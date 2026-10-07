// src/discord/commands/anime.ts
import type { Env } from '../../types/env';
import type { DiscordInteraction } from '../handler';
import type { D1Database } from '@cloudflare/workers-types';
import {
  searchAnime,
  detectMissing,
  enrichWithAITimeout,
  buildQimochiHubResult,
  pickTitle,
  isValidHttpUrl,
  QH_FORMAT_MAP,
  QH_STATUS_MAP,
  type Enriched,
} from '../../services/anime-core';

const SESSION_TTL_MS = 30 * 60 * 1000;
const DISCORD_MSG_LIMIT = 1900;

let dbReady = false;
let dbInitPromise: Promise<void> | null = null;

async function ensureDb(db: D1Database): Promise<void> {
  if (dbReady) return;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS temp_anime (
            session_id   TEXT PRIMARY KEY,
            user_id      INTEGER NOT NULL,
            yaml         TEXT NOT NULL,
            body         TEXT NOT NULL,
            missing      TEXT NOT NULL,
            ai_used      TEXT NOT NULL,
            cover        TEXT,
            source_label TEXT,
            created_at   INTEGER NOT NULL,
            expires_at   INTEGER NOT NULL
          )`
        )
        .run();
      dbReady = true;
    } catch (err) {
      console.error('[Discord/Anime] DB init error:', err);
      dbInitPromise = null;
      throw err;
    }
  })();

  return dbInitPromise;
}

async function saveSession(
  db: D1Database,
  userId: number,
  data: {
    yaml: string;
    body: string;
    missing: string[];
    aiUsed: string[];
    cover: string | null;
    sourceLabel: string | null;
  }
): Promise<string> {
  await ensureDb(db);
  const sessionId = `d_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO temp_anime
         (session_id, user_id, yaml, body, missing, ai_used, cover, source_label, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      userId,
      data.yaml,
      data.body,
      JSON.stringify(data.missing),
      JSON.stringify(data.aiUsed),
      data.cover,
      data.sourceLabel,
      now,
      now + SESSION_TTL_MS
    )
    .run();

  return sessionId;
}

interface SessionRow {
  session_id: string;
  user_id: number;
  yaml: string;
  body: string;
  missing: string;
  ai_used: string;
  cover: string | null;
  source_label: string | null;
  expires_at: number;
}

async function getSession(
  db: D1Database,
  sessionId: string
): Promise<SessionRow | null> {
  await ensureDb(db);
  const row = await db
    .prepare('SELECT * FROM temp_anime WHERE session_id = ?')
    .bind(sessionId)
    .first<SessionRow>();

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM temp_anime WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }
  return row;
}

async function deleteSession(db: D1Database, sessionId: string) {
  try {
    await db
      .prepare('DELETE FROM temp_anime WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.error('[Discord/Anime] delete error:', err);
  }
}

/* ═══════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════ */

function splitForDiscord(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const parts: string[] = [];
  let current = '';
  for (const line of s.split('\n')) {
    if (current.length + line.length + 1 > max && current.length > 0) {
      parts.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/* ═══════════════════════════════════════════════
   DISCORD API
   ═══════════════════════════════════════════════ */

const DISCORD_API = 'https://discord.com/api/v10';

async function editOriginal(
  appId: string,
  interactionToken: string,
  body: Record<string, unknown>
): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${appId}/${interactionToken}/messages/@original`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(
      '[Discord] editOriginal failed:',
      res.status,
      err.slice(0, 200)
    );
  }
}

async function sendFollowup(
  appId: string,
  interactionToken: string,
  body: Record<string, unknown>
): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${appId}/${interactionToken}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(
      '[Discord] followup failed:',
      res.status,
      err.slice(0, 200)
    );
  }
}

/* ═══════════════════════════════════════════════
   SLASH COMMAND HANDLER
   ═══════════════════════════════════════════════ */

export function handleAnime(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Response {
  ctx.waitUntil(processAnime(interaction, env));
  return new Response(JSON.stringify({ type: 5 }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function processAnime(
  interaction: DiscordInteraction,
  env: Env
): Promise<void> {
  const token = interaction.token;
  const appId = interaction.application_id ?? env.DISCORD_APP_ID;
  const userId = interaction.member?.user.id ?? interaction.user?.id;

  if (!userId) {
    await editOriginal(appId, token, {
      content: '❌ Tidak dapat identify user.',
    });
    return;
  }

  const query =
    (interaction.data?.options?.find(
      (o) => o.name === 'search' || o.name === 'query'
    )?.value as string) ?? '';

  if (!query) {
    await editOriginal(appId, token, { content: '❌ Query kosong.' });
    return;
  }

  try {
    let result;
    try {
      result = await searchAnime(query);
    } catch (err: any) {
      await editOriginal(appId, token, {
        content: `❌ Anime **${query}** tidak ditemukan.\n\n_${(err?.message ?? 'unknown').slice(0, 300)}_`,
      });
      return;
    }

    const { media, source } = result;

    const need = detectMissing(media);

    let enriched: Enriched | null = null;
    if (need.length > 0) {
      enriched = await enrichWithAITimeout(
        env,
        pickTitle(media),
        {
          studio: media.studios?.nodes?.[0]?.name,
          rating: media.averageScore ? media.averageScore / 10 : null,
          genre: media.genres,
          releaseDate: media.startDate?.year
            ? `${media.startDate.year}-01-01`
            : null,
          originalSynopsis: media.description,
        },
        need
      );
    }

    const { yaml, body, missing, aiUsed } = buildQimochiHubResult(
      media,
      enriched
    );

    const sessionId = await saveSession(env.DB, parseInt(userId, 10), {
      yaml,
      body,
      missing,
      aiUsed,
      cover: media.coverImage.extraLarge || media.coverImage.large || null,
      sourceLabel: `📡 Sumber: ${source}`,
    });

    const title = pickTitle(media);
    const year = media.startDate?.year ?? media.seasonYear ?? '-';
    const studioName = media.studios?.nodes?.[0]?.name ?? 'Unknown';
    const genres = (media.genres ?? []).slice(0, 3).join(', ') || '-';
    const rating = media.averageScore
      ? (media.averageScore / 10).toFixed(1)
      : '-';
    const statusText = QH_STATUS_MAP[media.status] ?? media.status;
    const typeText = QH_FORMAT_MAP[media.format] ?? media.format;

    const infoMsg =
      `**${title}**\n\n` +
      `📅 Tahun: ${year}\n` +
      `🎬 Tipe: ${typeText}\n` +
      `📌 Status: ${statusText}\n` +
      `📼 Episode: ${media.episodes ?? '-'}\n` +
      `🏢 Studio: ${studioName}\n` +
      `🏷️ Genre: ${genres}\n` +
      `⭐ Rating: ${rating}\n\n` +
      `✅ **Data siap!** Klik tombol untuk convert ke YAML.`;

    await editOriginal(appId, token, {
      content: infoMsg,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: '📋 Convert ke YAML',
              custom_id: `an:y:${sessionId}`,
            },
            {
              type: 2,
              style: 4,
              label: '❌ Batal',
              custom_id: `an:x:${sessionId}`,
            },
          ],
        },
      ],
    });
  } catch (err: any) {
    console.error('[Discord/Anime] error:', err);
    await editOriginal(appId, token, {
      content: `❌ Gagal: ${(err?.message ?? 'unknown').slice(0, 200)}`,
    });
  }
}

/* ═══════════════════════════════════════════════
   BUTTON HANDLER
   ═══════════════════════════════════════════════ */

export function handleAnimeButton(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
  customId: string
): Response {
  ctx.waitUntil(processButton(interaction, env, customId));
  return new Response(JSON.stringify({ type: 6 }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function processButton(
  interaction: DiscordInteraction,
  env: Env,
  customId: string
): Promise<void> {
  const parts = customId.split(':');
  const action = parts[1];
  const sessionId = parts[2];

  const appId = interaction.application_id ?? env.DISCORD_APP_ID;
  const token = interaction.token;
  const userId = interaction.member?.user.id ?? interaction.user?.id;

  if (!sessionId || !action) {
    await editOriginal(appId, token, { content: '❌ Tombol tidak valid.' });
    return;
  }

  const session = await getSession(env.DB, sessionId);
  if (!session) {
    await editOriginal(appId, token, {
      content: '⏱️ Session kadaluarsa. Ulangi `/anime`.',
    });
    return;
  }

  if (!userId || parseInt(userId, 10) !== session.user_id) {
    await editOriginal(appId, token, { content: '⛔ Bukan sesi Anda.' });
    return;
  }

  if (action === 'x') {
    await deleteSession(env.DB, sessionId);
    await editOriginal(appId, token, {
      content: '❌ **Dibatalkan.**',
      components: [],
    });
    return;
  }

  if (action === 'y') {
    await editOriginal(appId, token, {
      content: '📋 **Generating YAML...**',
      components: [],
    });

    const missing: string[] = JSON.parse(session.missing);
    const aiUsed: string[] = JSON.parse(session.ai_used);

    if (missing.length > 0 || aiUsed.length > 0) {
      const warns: string[] = [];
      if (missing.length > 0) {
        warns.push('⚠️ **Perlu edit manual:**');
        warns.push(...missing.map((f) => `• \`${f}\``));
        warns.push('');
      }
      if (aiUsed.length > 0) {
        warns.push('🤖 **Diisi AI (VERIFIKASI ulang):**');
        warns.push(...aiUsed.map((f) => `• \`${f}\``));
      }
      await sendFollowup(appId, token, {
        content: warns.join('\n').slice(0, 1900),
      });
    }

    if (session.cover && isValidHttpUrl(session.cover)) {
      await sendFollowup(appId, token, {
        embeds: [{ color: 0x8b5cf6, image: { url: session.cover } }],
      });
    }

    const fullMd = `${session.yaml}\n\n${session.body}`;
    const parts = splitForDiscord(fullMd, DISCORD_MSG_LIMIT);

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? '';
      const header =
        parts.length > 1
          ? `📄 **Markdown** (${i + 1}/${parts.length})\n\n`
          : `📄 **Markdown File**\n\n`;

      await sendFollowup(appId, token, {
        content: header + '```markdown\n' + part + '\n```',
      });
    }

    await editOriginal(appId, token, {
      content: '✅ **Selesai!**',
      components: [],
    });

    await deleteSession(env.DB, sessionId);
  }
}