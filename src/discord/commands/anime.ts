import type { Env } from '../../types/env';
import type { DiscordInteraction } from '../handler';
import type { AniListMedia } from '../../types/anime';
import type { D1Database } from '@cloudflare/workers-types';
import { searchJikan, jikanToAniList } from '../../services/jikan';
import { searchKitsu, kitsuToAniList } from '../../services/kitsu';
import { searchShikimori, shikimoriToAniList } from '../../services/shikimori';
import { chatAI } from '../../services/ai';

const AI_TIMEOUT_MS = 3000;
const SESSION_TTL_MS = 30 * 60 * 1000;

type AnimeStatus = 'Ongoing' | 'Completed' | 'Hiatus';
type AnimeType = 'TV' | 'Movie' | 'OVA' | 'ONA' | 'Special';

const FORMAT_MAP: Record<string, AnimeType> = {
  TV: 'TV', TV_SHORT: 'TV', MOVIE: 'Movie', SPECIAL: 'Special',
  OVA: 'OVA', ONA: 'ONA', MUSIC: 'Special',
};

const STATUS_MAP: Record<string, AnimeStatus> = {
  FINISHED: 'Completed', RELEASING: 'Ongoing', NOT_YET_RELEASED: 'Ongoing',
  CANCELLED: 'Hiatus', HIATUS: 'Hiatus',
};

/* ═══════════════════════════════════════════════
   DB: SESSIONS (pakai temp_anime, prefix d_)
   ═══════════════════════════════════════════════ */

let dbReady = false;
let dbInitPromise: Promise<void> | null = null;

async function ensureDb(db: D1Database): Promise<void> {
  if (dbReady) return;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    try {
      await db.prepare(
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
      ).run();
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

  await db.prepare(
    `INSERT INTO temp_anime
       (session_id, user_id, yaml, body, missing, ai_used, cover, source_label, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    sessionId, userId, data.yaml, data.body,
    JSON.stringify(data.missing), JSON.stringify(data.aiUsed),
    data.cover, data.sourceLabel, now, now + SESSION_TTL_MS
  ).run();

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
  const row = await db.prepare(
    'SELECT * FROM temp_anime WHERE session_id = ?'
  ).bind(sessionId).first<SessionRow>();

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await db.prepare('DELETE FROM temp_anime WHERE session_id = ?')
      .bind(sessionId).run().catch(() => {});
    return null;
  }
  return row;
}

async function deleteSession(db: D1Database, sessionId: string) {
  try {
    await db.prepare('DELETE FROM temp_anime WHERE session_id = ?')
      .bind(sessionId).run();
  } catch (err) {
    console.error('[Discord/Anime] delete error:', err);
  }
}

/* ═══════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════ */

function pickTitle(media: AniListMedia): string {
  return media.title.romaji || media.title.english || media.title.native || 'Unknown';
}

function yamlString(s: string): string {
  const cleaned = s.replace(/\n/g, ' ').trim();
  const needsQuote = /[:#&*!|>'"%@`{}\[\],]/.test(cleaned);
  if (!needsQuote) return cleaned;
  return `"${cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

function pick<T>(...values: (T | null | undefined)[]): T | null {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return v;
  }
  return null;
}

function normalizeStudioName(name: string): string {
  const t = name.trim();
  if (!t) return t;
  const lower = t.toLowerCase();
  const keep = [
    'studio', 'animation', 'production', 'pictures', 'works',
    'toei', 'mappa', 'ufotable', 'bones', 'wit ', 'kyoto', 'ghibli', 'gibli',
    'shaft', 'trigger', 'sunrise', 'gainax', 'madhouse', 'a-1', 'pierrot',
    'j.c.staff', 'jc staff', 'cloverworks',
  ];
  if (keep.some((k) => lower.includes(k))) return t;
  return `Studio ${t}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 20) + '\n… [truncated]';
}

/* ═══════════════════════════════════════════════
   AI ENRICHMENT
   ═══════════════════════════════════════════════ */

interface Enriched {
  studio?: string | null;
  rating?: number | null;
  synopsis?: string | null;
  genre?: string[] | null;
  releaseDate?: string | null;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

async function enrichWithAITimeout(
  env: Env,
  title: string,
  existing: { studio?: string | null; rating?: number | null; genre?: string[] | null; releaseDate?: string | null },
  need: string[]
): Promise<Enriched | null> {
  if (need.length === 0) return null;

  const known: string[] = [];
  if (existing.studio) known.push(`studio: ${existing.studio}`);
  if (existing.rating) known.push(`rating: ${existing.rating}`);
  if (existing.genre?.length) known.push(`genre: ${existing.genre.join(', ')}`);
  if (existing.releaseDate) known.push(`releaseDate: ${existing.releaseDate}`);

  const prompt =
    `You are a FACTUAL anime database expert. Return STRICT JSON only.\n` +
    `CRITICAL: If you don't know a fact with HIGH CONFIDENCE, return null. NEVER GUESS.\n\n` +
    `Anime title: ${title}\n\n` +
    (known.length > 0 ? `Known data:\n${known.join('\n')}\n\n` : '') +
    `Fill in ONLY these missing: ${need.join(', ')}\n\n` +
    `Output JSON: {"studio":"...","rating":7.5,"genre":["..."],"releaseDate":"YYYY-MM-DD","synopsis":"..."}\n\n` +
    `RULES:\n- If not 100% sure, use null.\n- studio: full official name.\n- synopsis: Indonesian, factual.\n- Valid JSON only.`;

  try {
    const rawPromise = chatAI(
      env, [{ role: 'user', content: prompt }],
      { maxTokens: 900, temperature: 0.1, smart: true }
    );

    const raw = await Promise.race([
      rawPromise,
      new Promise<string>((r) => setTimeout(() => r(''), AI_TIMEOUT_MS)),
    ]);

    if (!raw) return null;
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const obj = parsed as Record<string, unknown>;
    const out: Enriched = {};
    if (typeof obj.studio === 'string') out.studio = obj.studio;
    if (typeof obj.rating === 'number') out.rating = obj.rating;
    if (Array.isArray(obj.genre)) {
      out.genre = obj.genre.filter((g): g is string => typeof g === 'string');
    }
    if (typeof obj.releaseDate === 'string') out.releaseDate = obj.releaseDate;
    if (typeof obj.synopsis === 'string') out.synopsis = obj.synopsis;
    return out;
  } catch (err) {
    console.error('[Discord/Anime] AI error:', err);
    return null;
  }
}

/* ═══════════════════════════════════════════════
   FETCH + MERGE
   ═══════════════════════════════════════════════ */

async function fetchAndMerge(query: string): Promise<{
  media: AniListMedia;
  sources: string[];
} | null> {
  const [jikanR, kitsuR, shikimoriR] = await Promise.allSettled([
    searchJikan(query),
    searchKitsu(query),
    searchShikimori(query),
  ]);

  const jikan = jikanR.status === 'fulfilled' && jikanR.value
    ? jikanToAniList(jikanR.value) : null;
  const kitsu = kitsuR.status === 'fulfilled' && kitsuR.value
    ? kitsuToAniList(kitsuR.value) : null;
  const shikimori = shikimoriR.status === 'fulfilled' && shikimoriR.value
    ? shikimoriToAniList(shikimoriR.value) : null;

  const sources: string[] = [];
  if (jikan) sources.push('Jikan');
  if (kitsu) sources.push('Kitsu');
  if (shikimori) sources.push('Shikimori');

  if (sources.length === 0) return null;

  const merged: AniListMedia = {
    id: jikan?.id ?? kitsu?.id ?? shikimori?.id ?? 0,
    title: {
      romaji: pick(jikan?.title.romaji, kitsu?.title.romaji, shikimori?.title.romaji) ?? 'Unknown',
      english: pick(jikan?.title.english, kitsu?.title.english, shikimori?.title.english),
      native: pick(jikan?.title.native, kitsu?.title.native, shikimori?.title.native),
    },
    coverImage: {
      extraLarge: pick(kitsu?.coverImage.extraLarge, jikan?.coverImage.extraLarge, shikimori?.coverImage.extraLarge) ?? '',
      large: pick(kitsu?.coverImage.large, jikan?.coverImage.large, shikimori?.coverImage.large) ?? '',
    },
    description: pick(jikan?.description, kitsu?.description),
    format: pick(jikan?.format, kitsu?.format, shikimori?.format) ?? 'TV',
    status: pick(jikan?.status, kitsu?.status, shikimori?.status) ?? 'RELEASING',
    seasonYear: pick(jikan?.seasonYear, kitsu?.seasonYear, shikimori?.seasonYear),
    episodes: pick(jikan?.episodes, kitsu?.episodes, shikimori?.episodes),
    genres: pick(jikan?.genres, shikimori?.genres, kitsu?.genres) ?? [],
    averageScore: pick(jikan?.averageScore, shikimori?.averageScore, kitsu?.averageScore),
    studios: {
      nodes: pick(jikan?.studios.nodes, shikimori?.studios.nodes, kitsu?.studios.nodes) ?? [],
    },
    startDate: {
      year: pick(jikan?.startDate.year, kitsu?.startDate.year, shikimori?.startDate.year),
      month: pick(jikan?.startDate.month, kitsu?.startDate.month, shikimori?.startDate.month),
      day: pick(jikan?.startDate.day, kitsu?.startDate.day, shikimori?.startDate.day),
    },
  };

  return { media: merged, sources };
}

/* ═══════════════════════════════════════════════
   BUILD YAML + BODY
   ═══════════════════════════════════════════════ */

interface BuildResult {
  yaml: string;
  body: string;
  missing: string[];
  aiUsed: string[];
}

function buildResult(media: AniListMedia, enriched: Enriched | null): BuildResult {
  const missing: string[] = [];
  const aiUsed: string[] = [];

  const title = pickTitle(media);
  if (!title || title === 'Unknown') missing.push('title');

  let cover = media.coverImage.extraLarge || media.coverImage.large || '';
  if (!cover || !isValidHttpUrl(cover)) {
    cover = 'https://placehold.co/400x600?text=No+Cover';
    missing.push('cover');
  }

  let status: AnimeStatus = 'Ongoing';
  const mappedStatus = STATUS_MAP[media.status];
  if (mappedStatus) status = mappedStatus;
  else missing.push('status');

  let type: AnimeType = 'TV';
  const mappedType = FORMAT_MAP[media.format];
  if (mappedType) type = mappedType;
  else missing.push('type');

  let genres = (media.genres ?? []).filter((g) => g && g.trim());
  if (genres.length === 0 && enriched?.genre?.length) {
    genres = enriched.genre; aiUsed.push('genre');
  }
  if (genres.length === 0) { genres = ['Unknown']; missing.push('genre'); }
  const genreYaml = `[${genres.map((g) => yamlString(g)).join(', ')}]`;

  let studio = media.studios?.nodes?.[0]?.name ?? '';
  if (!studio || studio === 'Unknown') {
    if (enriched?.studio) { studio = normalizeStudioName(enriched.studio); aiUsed.push('studio'); }
    else { studio = 'Unknown'; missing.push('studio'); }
  }

  const y = media.startDate?.year ?? media.seasonYear;
  const mo = media.startDate?.month;
  const d = media.startDate?.day;
  let releaseDate: string;

  if (y && mo && d) {
    releaseDate = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  } else if (enriched?.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(enriched.releaseDate)) {
    releaseDate = enriched.releaseDate; aiUsed.push('releaseDate');
  } else if (y) {
    releaseDate = `${y}-01-01`; missing.push('releaseDate (default 01-01)');
  } else {
    releaseDate = new Date().toISOString().split('T')[0] ?? '2020-01-01';
    missing.push('releaseDate');
  }

  const addedAt = new Date().toISOString().split('T')[0] ?? '2026-01-01';

  let rating: string;
  if (typeof media.averageScore === 'number' && media.averageScore > 0) {
    rating = (media.averageScore / 10).toFixed(1);
  } else if (typeof enriched?.rating === 'number' && enriched.rating > 0) {
    rating = enriched.rating.toFixed(1); aiUsed.push('rating');
  } else {
    rating = '0.0'; missing.push('rating');
  }

  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: ${yamlString(title)}`);
  lines.push(`cover: ${cover}`);
  lines.push(`status: ${status}`);
  lines.push(`type: ${type}`);
  lines.push(`genre: ${genreYaml}`);
  lines.push(`studio: ${yamlString(studio)}`);
  lines.push(`releaseDate: ${releaseDate}`);
  lines.push(`addedAt: ${addedAt}`);
  lines.push(`rating: ${rating}`);
  lines.push('episodes: []');
  lines.push('---');
  const yaml = lines.join('\n');

  let synopsisRaw = media.description ?? null;
  if (synopsisRaw) synopsisRaw = stripHtml(synopsisRaw);

  let synopsis = synopsisRaw;
  const isTooShort = !synopsis || synopsis.length < 50;
  if (isTooShort && enriched?.synopsis && enriched.synopsis.length > 50) {
    synopsis = enriched.synopsis; aiUsed.push('synopsis');
  }
  if (!synopsis || synopsis.length < 30) {
    synopsis = '> ⚠️ Sinopsis belum tersedia. Silakan isi manual.\n\n' + `${title} adalah anime yang...`;
    missing.push('synopsis (body)');
  }

  return { yaml, body: synopsis, missing, aiUsed };
}

/* ═══════════════════════════════════════════════
   DISCORD API HELPERS
   ═══════════════════════════════════════════════ */

const DISCORD_API = 'https://discord.com/api/v10';

async function editOriginal(
  env: Env,
  interactionToken: string,
  body: Record<string, unknown>
): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interactionToken}/messages/@original`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error('[Discord] editOriginal failed:', res.status, err.slice(0, 200));
  }
}

async function sendFollowup(
  env: Env,
  interactionToken: string,
  body: Record<string, unknown>
): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${interactionToken}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error('[Discord] followup failed:', res.status, err.slice(0, 200));
  }
}

/* ═══════════════════════════════════════════════
   HANDLERS
   ═══════════════════════════════════════════════ */

/**
 * Entry point dari handler.ts. Return deferred response (type 5) langsung,
 * proses lanjut di background via ctx.waitUntil().
 */
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
  const userId = interaction.member?.user.id ?? interaction.user?.id;
  if (!userId) {
    await editOriginal(env, token, { content: '❌ Tidak dapat identify user.' });
    return;
  }

  const query =
    (interaction.data?.options?.find((o) => o.name === 'query')?.value as string) ?? '';

  if (!query) {
    await editOriginal(env, token, { content: '❌ Query kosong.' });
    return;
  }

  try {
    const result = await fetchAndMerge(query);

    if (!result) {
      await editOriginal(env, token, {
        content: `❌ Anime **${query}** tidak ditemukan.`,
      });
      return;
    }

    const { media, sources } = result;

    // Detect missing
    const need: string[] = [];
    const studio = media.studios?.nodes?.[0]?.name;
    if (!studio || studio === 'Unknown') need.push('studio');
    if (typeof media.averageScore !== 'number' || media.averageScore <= 0) need.push('rating');
    if (!media.genres || media.genres.length === 0) need.push('genre');
    if (!media.startDate?.year && !media.seasonYear) need.push('releaseDate');
    const cleanDesc = stripHtml(media.description ?? '');
    if (!cleanDesc || cleanDesc.length < 50) need.push('synopsis');

    // AI enrich
    let enriched: Enriched | null = null;
    if (need.length > 0) {
      enriched = await enrichWithAITimeout(
        env,
        pickTitle(media),
        {
          studio: media.studios?.nodes?.[0]?.name,
          rating: media.averageScore ? media.averageScore / 10 : null,
          genre: media.genres,
          releaseDate: media.startDate?.year ? `${media.startDate.year}-01-01` : null,
        },
        need
      );
    }

    const { yaml, body, missing, aiUsed } = buildResult(media, enriched);

    // Simpan session
    const sessionId = await saveSession(env.DB, parseInt(userId, 10), {
      yaml, body, missing, aiUsed,
      cover: media.coverImage.extraLarge || media.coverImage.large || null,
      sourceLabel: `📡 Sumber: ${sources.join(' + ')}`,
    });

    // Info card
    const title = pickTitle(media);
    const year = media.startDate?.year ?? media.seasonYear ?? '-';
    const studioName = media.studios?.nodes?.[0]?.name ?? 'Unknown';
    const genres = (media.genres ?? []).slice(0, 3).join(', ') || '-';
    const rating = media.averageScore ? (media.averageScore / 10).toFixed(1) : '-';
    const statusText = STATUS_MAP[media.status] ?? media.status;
    const typeText = FORMAT_MAP[media.format] ?? media.format;

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

    await editOriginal(env, token, {
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
    await editOriginal(env, token, {
      content: `❌ Gagal: ${(err?.message ?? 'unknown').slice(0, 200)}`,
    });
  }
}

/* ═══════════════════════════════════════════════
   BUTTON HANDLERS
   ═══════════════════════════════════════════════ */

export async function handleAnimeButton(
  interaction: DiscordInteraction,
  env: Env,
  customId: string
): Promise<Response> {
  const parts = customId.split(':');
  // an:y:SESSIONID atau an:x:SESSIONID
  const action = parts[1];
  const sessionId = parts[2];

  if (!sessionId || !action) {
    return json({
      type: 4,
      data: { content: '❌ Tombol tidak valid.', flags: 64 },
    });
  }

  const userId = interaction.member?.user.id ?? interaction.user?.id;
  const session = await getSession(env.DB, sessionId);

  if (!session) {
    return json({
      type: 4,
      data: { content: '⏱️ Session kadaluarsa. Ulangi `/anime`.', flags: 64 },
    });
  }

  if (!userId || parseInt(userId, 10) !== session.user_id) {
    return json({
      type: 4,
      data: { content: '⛔ Bukan sesi Anda.', flags: 64 },
    });
  }

  // Batal
  if (action === 'x') {
    await deleteSession(env.DB, sessionId);
    return json({
      type: 7, // UPDATE_MESSAGE
      data: {
        content: '❌ **Dibatalkan.**',
        components: [],
      },
    });
  }

  // Convert
  if (action === 'y') {
    // Update message: hapus button, tampil status
    await editOriginal(env, interaction.token, {
      content: '📋 **Generating YAML...**',
      components: [],
    }).catch(() => {});

    const missing: string[] = JSON.parse(session.missing);
    const aiUsed: string[] = JSON.parse(session.ai_used);

    // Warning
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
      await sendFollowup(env, interaction.token, {
        content: warns.join('\n').slice(0, 1900),
      });
    }

    // YAML
    await sendFollowup(env, interaction.token, {
      content:
        `📋 **YAML Frontmatter**\n\n` +
        `\`\`\`yaml\n${truncate(session.yaml, 1900)}\n\`\`\``,
    });

    // Sinopsis
    await sendFollowup(env, interaction.token, {
      content:
        `📝 **Body (Sinopsis)**\n\n` +
        `\`\`\`\n${truncate(session.body, 1900)}\n\`\`\``,
    });

    // Cover + source
    const embed: Record<string, unknown> = {
      color: 0x8b5cf6,
    };
    if (session.cover && isValidHttpUrl(session.cover)) {
      embed.image = { url: session.cover };
    }
    if (session.source_label) {
      embed.footer = { text: session.source_label };
    }

    await sendFollowup(env, interaction.token, {
      embeds: [embed],
    });

    // Hapus session
    await deleteSession(env.DB, sessionId);

    // Response ke Discord (wajib)
    return json({
      type: 7,
      data: {
        content: '✅ **Selesai!**',
        components: [],
      },
    });
  }

  return json({
    type: 4,
    data: { content: '❌ Action tidak dikenal.', flags: 64 },
  });
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}