// src/commands/database-anime.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import { chainSearch } from '../services/qimochi-chain';
import {
  chainCharacters,
  chainEpisodes,
  chainRelations,
  type ChainContext,
} from '../services/qimochi-chain-extras';
import {
  buildMetadataYaml,
  buildCharactersYaml,
  buildEpisodesYaml,
  buildFranchisesYaml,
  buildAllMarkdown,
  getSynopsisRaw,
} from '../services/qimochi-yaml';
import { askAI } from '../services/ai';

const SESSION_TTL_MS = 30 * 60 * 1000;
const MSG_LIMIT = 3500;
const AI_TIMEOUT_MS = 12000;
const FILE_THRESHOLD = 500;

/* ============================================================
   DB: SESSION
   ============================================================ */

let dbReady = false;
let dbInitPromise: Promise<void> | null = null;

async function ensureDb(db: D1Database): Promise<void> {
  if (dbReady) return;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS qimochi_sessions (
            session_id   TEXT PRIMARY KEY,
            user_id      INTEGER NOT NULL,
            mal_id       INTEGER,
            kitsu_id     TEXT,
            title        TEXT NOT NULL,
            cover        TEXT,
            year         TEXT,
            type         TEXT,
            studio       TEXT,
            source       TEXT,
            created_at   INTEGER NOT NULL,
            expires_at   INTEGER NOT NULL
          )`
        )
        .run();
      dbReady = true;
    } catch (err) {
      console.error('[DBA] DB init error:', err);
      dbInitPromise = null;
      throw err;
    }
  })();

  return dbInitPromise;
}

interface SessionRow {
  session_id: string;
  user_id: number;
  mal_id: number | null;
  kitsu_id: string | null;
  title: string;
  cover: string | null;
  year: string | null;
  type: string | null;
  studio: string | null;
  source: string | null;
  created_at: number;
  expires_at: number;
}

async function saveSession(
  db: D1Database,
  userId: number,
  data: {
    malId: number | null;
    kitsuId: string | null;
    title: string;
    cover: string | null;
    year: string | null;
    type: string | null;
    studio: string | null;
    source: string | null;
  }
): Promise<string> {
  await ensureDb(db);

  const sessionId = `q_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO qimochi_sessions
        (session_id, user_id, mal_id, kitsu_id, title, cover, year, type, studio, source, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      userId,
      data.malId,
      data.kitsuId,
      data.title,
      data.cover,
      data.year,
      data.type,
      data.studio,
      data.source,
      now,
      now + SESSION_TTL_MS
    )
    .run();

  return sessionId;
}

async function getSession(
  db: D1Database,
  sessionId: string
): Promise<SessionRow | null> {
  await ensureDb(db);

  const row = await db
    .prepare('SELECT * FROM qimochi_sessions WHERE session_id = ?')
    .bind(sessionId)
    .first<SessionRow>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM qimochi_sessions WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }

  return row;
}

async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM qimochi_sessions WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.error('[DBA] delete error:', err);
  }
}

/* ============================================================
   HELPERS
   ============================================================ */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function splitMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];

  const parts: string[] = [];
  let current = '';

  for (const line of text.split('\n')) {
    if (line.length > max) {
      if (current) {
        parts.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += max) {
        const chunk = line.slice(i, i + max);
        if (i + max >= line.length) {
          current = chunk;
        } else {
          parts.push(chunk);
        }
      }
      continue;
    }

    const prospective = current ? `${current}\n${line}` : line;
    if (prospective.length > max && current.length > 0) {
      parts.push(current);
      current = line;
    } else {
      current = prospective;
    }
  }

  if (current) parts.push(current);
  return parts;
}

/**
 * Kirim document via Telegram Bot API manual (fetch).
 */
async function sendDocumentViaApi(
  botToken: string,
  chatId: number,
  filename: string,
  content: string,
  caption: string
): Promise<void> {
  const boundary =
    '----YukioBot' + Math.random().toString(36).slice(2, 12);

  const encoder = new TextEncoder();
  const CRLF = '\r\n';
  const chunks: Uint8Array[] = [];

  const pushStr = (s: string) => {
    chunks.push(encoder.encode(s));
  };

  pushStr(`--${boundary}${CRLF}`);
  pushStr(`Content-Disposition: form-data; name="chat_id"${CRLF}${CRLF}`);
  pushStr(`${chatId}${CRLF}`);

  pushStr(`--${boundary}${CRLF}`);
  pushStr(`Content-Disposition: form-data; name="caption"${CRLF}${CRLF}`);
  pushStr(`${caption}${CRLF}`);

  pushStr(`--${boundary}${CRLF}`);
  pushStr(`Content-Disposition: form-data; name="parse_mode"${CRLF}${CRLF}`);
  pushStr(`HTML${CRLF}`);

  pushStr(`--${boundary}${CRLF}`);
  pushStr(
    `Content-Disposition: form-data; name="document"; filename="${filename}"${CRLF}`
  );
  pushStr(`Content-Type: text/yaml; charset=utf-8${CRLF}${CRLF}`);
  chunks.push(encoder.encode(content));
  pushStr(`${CRLF}`);

  pushStr(`--${boundary}--${CRLF}`);

  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendDocument`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `sendDocument HTTP ${res.status}: ${errText.slice(0, 200)}`
    );
  }
}

/**
 * Kirim YAML — pakai env.TELEGRAM_BOT_TOKEN untuk file attachment.
 */
async function sendYamlMessage(
  ctx: Context,
  env: Env,
  label: string,
  yaml: string
): Promise<void> {
  // === FILE ATTACHMENT (threshold rendah, hampir semua YAML → file) ===
  if (yaml.length > FILE_THRESHOLD) {
    try {
      const filename = `qimochi-${Date.now()}.yaml`;
      const caption =
        `📋 <b>${escapeHtml(label)}</b>\n\n` +
        `<i>${yaml.length.toLocaleString()} char — dikirim sebagai file.</i>`;

      await sendDocumentViaApi(
        env.TELEGRAM_BOT_TOKEN,
        ctx.chat!.id,
        filename,
        yaml,
        caption
      );

      console.log(`[DBA] file attachment sent (${yaml.length} char)`);
      return;
    } catch (err: any) {
      console.error(`[DBA] sendDocument failed: ${err?.message ?? err}`);
      // Fallback text
    }
  }

  // === TEXT SPLIT (fallback untuk YAML kecil atau kalau file gagal) ===
  const parts = splitMessage(yaml, MSG_LIMIT);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    const header =
      parts.length > 1
        ? `📋 <b>${escapeHtml(label)}</b> [${i + 1}/${parts.length}]\n\n`
        : `📋 <b>${escapeHtml(label)}</b>\n\n`;

    try {
      await ctx.reply(`${header}<pre>${escapeHtml(part)}</pre>`, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err: any) {
      console.error(
        `[DBA] sendMessage part ${i + 1}/${parts.length} failed: ${err?.message ?? err}`
      );
      throw err;
    }

    if (i < parts.length - 1) {
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

function buildKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('📋 Metadata', `qd:m:${sessionId}`)
    .text('👥 Characters', `qd:c:${sessionId}`)
    .row()
    .text('🎬 Episodes', `qd:e:${sessionId}`)
    .text('🔗 Franchises', `qd:f:${sessionId}`)
    .row()
    .text('📝 Summary', `qd:s:${sessionId}`)
    .text('📦 All', `qd:a:${sessionId}`)
    .row()
    .text('❌ Batal', `qd:x:${sessionId}`);
}

function buildPreviewText(session: SessionRow): string {
  const lines: string[] = [];
  lines.push(`<b>${escapeHtml(session.title)}</b>`);
  lines.push('');
  if (session.year) lines.push(`📅 ${escapeHtml(session.year)}`);
  if (session.type) lines.push(`🎬 ${escapeHtml(session.type)}`);
  if (session.studio) lines.push(`🏢 ${escapeHtml(session.studio)}`);
  if (session.source) lines.push(`📡 ${escapeHtml(session.source)}`);
  lines.push('');
  lines.push('Pilih action:');
  return lines.join('\n');
}

function safeFetch<T>(
  fn: () => Promise<T>,
  timeoutMs: number
): Promise<{ data: T | null; error: string | null }> {
  return Promise.race([
    fn().then(
      (data) => ({ data, error: null }),
      (err) => ({
        data: null,
        error: (err as Error)?.message ?? 'unknown',
      })
    ),
    new Promise<{ data: T | null; error: string | null }>((r) =>
      setTimeout(() => r({ data: null, error: `timeout ${timeoutMs}ms` }), timeoutMs)
    ),
  ]);
}

/* ============================================================
   COMMENT HEADERS
   ============================================================ */

function headerMetadata(title: string): string {
  return (
    `# ============================================\n` +
    `# QimochiDB — Metadata Frontmatter\n` +
    `# Title: ${title}\n` +
    `# Copy-paste ke bagian atas file .md\n` +
    `# ============================================\n`
  );
}

function headerCharacters(title: string): string {
  return (
    `# ============================================\n` +
    `# QimochiDB — Characters\n` +
    `# Title: ${title}\n` +
    `# Ganti "characters: []" di frontmatter dengan ini\n` +
    `# ============================================\n`
  );
}

function headerEpisodes(title: string): string {
  return (
    `# ============================================\n` +
    `# QimochiDB — Episode List\n` +
    `# Title: ${title}\n` +
    `# Ganti "episodeList: []" di frontmatter dengan ini\n` +
    `# ============================================\n`
  );
}

function headerFranchises(title: string): string {
  return (
    `# ============================================\n` +
    `# QimochiDB — Franchises\n` +
    `# Title: ${title}\n` +
    `# Ganti "franchises: []" di frontmatter dengan ini\n` +
    `# ============================================\n`
  );
}

function headerSummary(title: string): string {
  return (
    `# ============================================\n` +
    `# QimochiDB — Body (Sinopsis)\n` +
    `# Title: ${title}\n` +
    `# Copy-paste di bawah frontmatter (setelah "---")\n` +
    `# ============================================\n`
  );
}

/* ============================================================
   AI SYNOPSIS
   ============================================================ */

async function rewriteSynopsis(
  env: Env,
  title: string,
  originalSynopsis: string
): Promise<string | null> {
  if (!originalSynopsis || originalSynopsis.length < 30) return null;

  const prompt =
    `Tulis ulang sinopsis anime berikut menjadi sinopsis baru dalam bahasa Indonesia.\n\n` +
    `Judul: ${title}\n\n` +
    `Sinopsis referensi (English):\n${originalSynopsis}\n\n` +
    `ATURAN:\n` +
    `- Tulis sebagai sinopsis baru, BUKAN terjemahan literal\n` +
    `- Bahasa Indonesia natural dan mengalir\n` +
    `- 2-3 paragraf pendek\n` +
    `- Jangan spoiler\n` +
    `- Jangan tambahkan info yang tidak ada di referensi\n` +
    `- Langsung mulai dari tokoh utama atau setting\n\n` +
    `Output hanya sinopsis, tanpa penjelasan tambahan.`;

  try {
    const result = await Promise.race([
      askAI(env, prompt, { maxTokens: 700, temperature: 0.6, smart: true }),
      new Promise<string>((r) => setTimeout(() => r(''), AI_TIMEOUT_MS)),
    ]);

    return result && result.length > 50 ? result.trim() : null;
  } catch (err) {
    console.error('[DBA] AI rewrite failed:', err);
    return null;
  }
}

function fallbackSection(section: string, errors: string[]): string {
  const header =
    `# ⚠️ Semua sumber gagal.\n` +
    errors.map((e) => `# - ${e}`).join('\n') +
    `\n# Isi manual di bawah.\n`;
  if (section === 'characters') return `${header}characters: []`;
  if (section === 'episodes') return `${header}episodeList: []`;
  if (section === 'franchises') return `${header}franchises: []`;
  return header;
}

/* ============================================================
   COMMAND HANDLER
   ============================================================ */

async function handleCommand(ctx: Context, env: Env): Promise<void> {
  const query = typeof ctx.match === 'string' ? ctx.match.trim() : '';

  if (!query) {
    await ctx.reply(
      '<b>📚 Database Anime (QimochiDB)</b>\n\n' +
        '<b>Contoh:</b>\n' +
        '<code>/dba nama anime</code>\n\n' +
        '<i>Bot akan cari data, lalu tampil tombol untuk pilih section.</i>',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  const loading = await ctx.reply('🔍 Mencari (Shikimori → Kitsu)...');

  try {
    let result;
    try {
      result = await chainSearch(query);
    } catch (err: any) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Anime <b>${escapeHtml(query)}</b> tidak ditemukan.\n\n` +
          `<i>${escapeHtml((err?.message ?? 'unknown').slice(0, 400))}</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const media = result.media;
    const studio = media.studios?.nodes?.[0]?.name ?? null;

    const sessionId = await saveSession(env.DB, ctx.from!.id, {
      malId: result.malId,
      kitsuId: result.kitsuId,
      title: media.title.romaji,
      cover: media.coverImage.extraLarge,
      year: media.seasonYear ? String(media.seasonYear) : null,
      type: media.format,
      studio,
      source: result.source,
    });

    const session = await getSession(env.DB, sessionId);
    if (!session) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        '❌ Gagal simpan session.'
      );
      return;
    }

    await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});

    if (session.cover) {
      await ctx.replyWithPhoto(session.cover, {
        caption: buildPreviewText(session),
        parse_mode: 'HTML',
        reply_markup: buildKeyboard(sessionId),
      });
    } else {
      await ctx.reply(buildPreviewText(session), {
        parse_mode: 'HTML',
        reply_markup: buildKeyboard(sessionId),
        link_preview_options: { is_disabled: true },
      });
    }
  } catch (err: any) {
    console.error('[DBA] command error:', err);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Gagal: ${escapeHtml((err?.message ?? 'unknown').slice(0, 200))}`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
}

export const databaseAnimeCommand: CommandDefinition = {
  name: 'database-anime',
  description: 'Generate YAML untuk QimochiDB',
  usage: '/dba <judul>',
  adminOnly: true,
  handler: handleCommand,
};

export const dbaShortCommand: CommandDefinition = {
  name: 'dba',
  description: 'Alias pendek untuk /database-anime',
  usage: '/dba <judul>',
  adminOnly: true,
  handler: handleCommand,
};

/* ============================================================
   CALLBACK HANDLERS
   ============================================================ */

function buildChainContext(session: SessionRow): ChainContext {
  return {
    malId: session.mal_id,
    kitsuId: session.kitsu_id,
    title: session.title,
  };
}

export function setupDatabaseAnimeCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^qd:([mcefsax]):(q_[a-f0-9]+)$/, async (ctx) => {
    const match = ctx.match as RegExpMatchArray;
    const action = match[1];
    const sessionId = match[2];

    if (!action || !sessionId) {
      await ctx.answerCallbackQuery({ text: '❌ Callback invalid' });
      return;
    }

    const session = await getSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Session kadaluarsa. Ulangi /dba.',
        show_alert: true,
      });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return;
    }

    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }

    if (action === 'x') {
      await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
      await deleteSession(env.DB, sessionId);
      await ctx
        .editMessageCaption({
          caption: `❌ <b>Dibatalkan</b>`,
          parse_mode: 'HTML',
          reply_markup: undefined,
        })
        .catch(() => {
          ctx
            .editMessageText('❌ <b>Dibatalkan</b>', {
              parse_mode: 'HTML',
              reply_markup: undefined,
            })
            .catch(() => {});
        });
      return;
    }

    await ctx.answerCallbackQuery({ text: '⏳ Memproses...' });

    try {
      const chainCtx = buildChainContext(session);

      /* ---------- METADATA ---------- */
      if (action === 'm') {
        let result;
        try {
          result = await chainSearch(session.title);
        } catch (err: any) {
          await ctx.reply(
            `❌ Gagal: ${escapeHtml((err?.message ?? 'unknown').slice(0, 200))}`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        const yaml = buildMetadataYaml({
          media: result.media,
          malId: result.malId ?? session.mal_id,
          kitsuId: result.kitsuId ?? session.kitsu_id,
        });
        const header = headerMetadata(session.title);
        await sendYamlMessage(
          ctx,
          env,
          `Metadata — ${session.title}`,
          header + yaml
        );
        return;
      }

      /* ---------- CHARACTERS ---------- */
      if (action === 'c') {
        const { data: chars, error } = await safeFetch(
          () => chainCharacters(chainCtx),
          25000
        );

        let yaml: string;
        let label: string;

        if (!chars || !chars.data || chars.data.length === 0) {
          const errs = chars?.errors ?? [error ?? 'unknown'];
          yaml = fallbackSection('characters', errs);
          label = `Characters — ${session.title} [FAILED]`;
        } else {
          yaml = buildCharactersYaml(chars.data);
          label = `Characters — ${session.title} [${chars.source}]`;
        }

        const header = headerCharacters(session.title);
        await sendYamlMessage(ctx, env, label, header + yaml);
        return;
      }

      /* ---------- EPISODES ---------- */
      if (action === 'e') {
        const { data: eps, error } = await safeFetch(
          () => chainEpisodes(chainCtx),
          30000
        );

        let yaml: string;
        let label: string;

        if (!eps || !eps.data || eps.data.length === 0) {
          const errs = eps?.errors ?? [error ?? 'unknown'];
          yaml = fallbackSection('episodes', errs);
          label = `Episodes — ${session.title} [FAILED]`;
        } else {
          yaml = buildEpisodesYaml(eps.data);
          label = `Episodes — ${session.title} [${eps.source}]`;
        }

        const header = headerEpisodes(session.title);
        await sendYamlMessage(ctx, env, label, header + yaml);
        return;
      }

      /* ---------- FRANCHISES ---------- */
      if (action === 'f') {
        const { data: rels, error } = await safeFetch(
          () => chainRelations(chainCtx),
          25000
        );

        let yaml: string;
        let label: string;

        if (!rels || !rels.data || rels.data.length === 0) {
          const errs = rels?.errors ?? [error ?? 'unknown'];
          yaml = fallbackSection('franchises', errs);
          label = `Franchises — ${session.title} [FAILED]`;
        } else {
          yaml = buildFranchisesYaml(rels.data);
          label = `Franchises — ${session.title} [${rels.source}]`;
        }

        const header = headerFranchises(session.title);
        await sendYamlMessage(ctx, env, label, header + yaml);
        return;
      }

      /* ---------- SUMMARY ---------- */
      if (action === 's') {
        let result;
        try {
          result = await chainSearch(session.title);
        } catch (err: any) {
          await ctx.reply(
            `❌ Gagal: ${escapeHtml((err?.message ?? 'unknown').slice(0, 200))}`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        const raw = getSynopsisRaw(result.media);
        const { data: ai } = await safeFetch(
          () => rewriteSynopsis(env, session.title, raw),
          AI_TIMEOUT_MS
        );

        let body: string;
        if (ai) {
          body =
            '<!--\n' +
            '  ⚠️ Sinopsis ini di-generate AI. Tinjau ulang sebelum commit.\n' +
            '  Kalau tidak sesuai, edit manual.\n' +
            '-->\n\n' +
            ai;
        } else {
          body =
            '<!--\n' +
            '  ⚠️ AI gagal generate sinopsis. Tulis manual di sini.\n' +
            '-->\n\n' +
            (raw || 'Tulis sinopsis manual...');
        }

        const header = headerSummary(session.title);
        await sendYamlMessage(
          ctx,
          env,
          `Summary — ${session.title}`,
          header + body
        );
        return;
      }

      /* ---------- ALL ---------- */
      if (action === 'a') {
        let searchResult;
        try {
          searchResult = await chainSearch(session.title);
        } catch (err: any) {
          await ctx.reply(
            `❌ Gagal: ${escapeHtml((err?.message ?? 'unknown').slice(0, 200))}`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        await ctx.reply('⏳ All (1/5): Metadata...');
        const metaYaml = buildMetadataYaml({
          media: searchResult.media,
          malId: searchResult.malId ?? session.mal_id,
          kitsuId: searchResult.kitsuId ?? session.kitsu_id,
        });

        await ctx.reply('⏳ All (2/5): Characters...');
        const charsRes = await safeFetch(() => chainCharacters(chainCtx), 25000);
        const charsYaml =
          charsRes.data?.data && charsRes.data.data.length > 0
            ? buildCharactersYaml(charsRes.data.data)
            : fallbackSection(
                'characters',
                charsRes.data?.errors ?? [charsRes.error ?? 'unknown']
              );

        await ctx.reply('⏳ All (3/5): Episodes...');
        const epsRes = await safeFetch(() => chainEpisodes(chainCtx), 30000);
        const epsYaml =
          epsRes.data?.data && epsRes.data.data.length > 0
            ? buildEpisodesYaml(epsRes.data.data)
            : fallbackSection(
                'episodes',
                epsRes.data?.errors ?? [epsRes.error ?? 'unknown']
              );

        await ctx.reply('⏳ All (4/5): Franchises...');
        const relsRes = await safeFetch(() => chainRelations(chainCtx), 25000);
        const relsYaml =
          relsRes.data?.data && relsRes.data.data.length > 0
            ? buildFranchisesYaml(relsRes.data.data)
            : fallbackSection(
                'franchises',
                relsRes.data?.errors ?? [relsRes.error ?? 'unknown']
              );

        await ctx.reply('⏳ All (5/5): Summary...');
        const raw = getSynopsisRaw(searchResult.media);
        const aiRes = await safeFetch(
          () => rewriteSynopsis(env, session.title, raw),
          AI_TIMEOUT_MS
        );
        const summary =
          '<!--\n' +
          '  ⚠️ Sinopsis di-generate AI. Tinjau ulang sebelum commit.\n' +
          '-->\n\n' +
          (aiRes.data || raw || 'Tulis sinopsis manual...');

        const full = buildAllMarkdown({
          metadata: headerMetadata(session.title) + metaYaml,
          characters: headerCharacters(session.title) + charsYaml,
          episodes: headerEpisodes(session.title) + epsYaml,
          franchises: headerFranchises(session.title) + relsYaml,
          summary: headerSummary(session.title) + summary,
        });

        await sendYamlMessage(ctx, env, `All — ${session.title}`, full);
        await deleteSession(env.DB, sessionId);
        return;
      }
    } catch (err: any) {
      console.error('[DBA] callback error:', err);
      const msg = err?.message ?? 'unknown';

      let hint = '';
      if (msg.includes('aborted') || msg.includes('timeout')) {
        hint = '\n\n<i>API lambat. Coba lagi dalam 30 detik.</i>';
      } else if (msg.includes('429')) {
        hint = '\n\n<i>Rate limit. Tunggu 1 menit.</i>';
      } else if (msg.includes('HTTP 5')) {
        hint = '\n\n<i>Server down. Coba lagi nanti.</i>';
      }

      await ctx.reply(
        `❌ Gagal: ${escapeHtml(msg.slice(0, 200))}${hint}`,
        { parse_mode: 'HTML' }
      );
    }
  });
}
