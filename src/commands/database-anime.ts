// src/commands/database-anime.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import { searchJikan, jikanToAniList } from '../services/jikan';
import {
  getCharacters,
  getAllEpisodes,
  getRelations,
} from '../services/jikan-extras';
import {
  buildMetadataYaml,
  buildCharactersYaml,
  buildEpisodesYaml,
  buildFranchisesYaml,
  buildAllMarkdown,
} from '../services/qimochi-yaml';
import { askAI } from '../services/ai';

const SESSION_TTL_MS = 30 * 60 * 1000;
const MSG_LIMIT = 3800;
const AI_TIMEOUT_MS = 12000;

const TIMEOUT_SEARCH = 10000;
const TIMEOUT_CHARS = 12000;
const TIMEOUT_EPISODES = 15000;
const TIMEOUT_RELATIONS = 10000;

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
            mal_id       INTEGER NOT NULL,
            title        TEXT NOT NULL,
            cover        TEXT,
            year         TEXT,
            type         TEXT,
            studio       TEXT,
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
  mal_id: number;
  title: string;
  cover: string | null;
  year: string | null;
  type: string | null;
  studio: string | null;
  created_at: number;
  expires_at: number;
}

async function saveSession(
  db: D1Database,
  userId: number,
  data: {
    malId: number;
    title: string;
    cover: string | null;
    year: string | null;
    type: string | null;
    studio: string | null;
  }
): Promise<string> {
  await ensureDb(db);

  const sessionId = `q_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO qimochi_sessions
        (session_id, user_id, mal_id, title, cover, year, type, studio, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      userId,
      data.malId,
      data.title,
      data.cover,
      data.year,
      data.type,
      data.studio,
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

async function sendLongMessage(
  ctx: Context,
  label: string,
  content: string
): Promise<void> {
  const parts = splitMessage(content, MSG_LIMIT);

  if (parts.length === 1) {
    await ctx.reply(
      `📋 <b>${escapeHtml(label)}</b>\n\n<pre>${escapeHtml(parts[0] ?? '')}</pre>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    await ctx.reply(
      `📋 <b>${escapeHtml(label)}</b> [${i + 1}/${parts.length}]\n\n<pre>${escapeHtml(part)}</pre>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
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
  lines.push('');
  lines.push('Pilih action:');
  return lines.join('\n');
}

function cleanSynopsis(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .trim();
}

/* ============================================================
   SAFE FETCH — timeout wrapper
   ============================================================ */

async function safeFetch<T>(
  fn: () => Promise<T>,
  timeoutMs: number
): Promise<{ data: T | null; error: string | null }> {
  try {
    const result = await Promise.race([
      fn(),
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
    ]);

    if (result === null) {
      return { data: null, error: `timeout ${timeoutMs}ms` };
    }
    return { data: result, error: null };
  } catch (err: any) {
    return { data: null, error: err?.message ?? 'unknown' };
  }
}

/* ============================================================
   AI SYNOPSIS REWRITE
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

function fallbackYaml(section: string, error: string): string {
  const header =
    `# ⚠️ Gagal fetch dari Jikan: ${error}\n` +
    `# Coba tombol sekali lagi, atau isi manual di bawah.\n`;
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
      '<b>📚 Database Anime</b>\n\n' +
        '<b>Contoh:</b>\n' +
        '<code>/dba nama anime</code>\n\n' +
        '<i>Bot akan cari data, lalu tampil tombol untuk pilih section.</i>',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  const loading = await ctx.reply('🔍 Mencari...');

  try {
    const { data: jikan, error } = await safeFetch(
      () => searchJikan(query),
      TIMEOUT_SEARCH
    );

    if (!jikan) {
      const hint = error?.includes('timeout')
        ? '\n\n<i>Jikan API lambat. Coba lagi dalam 30 detik.</i>'
        : '';
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Anime <b>${escapeHtml(query)}</b> tidak ditemukan.${hint}`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const media = jikanToAniList(jikan);
    const studio = media.studios?.nodes?.[0]?.name ?? null;

    const sessionId = await saveSession(env.DB, ctx.from!.id, {
      malId: jikan.mal_id,
      title: media.title.romaji,
      cover: media.coverImage.extraLarge,
      year: media.seasonYear ? String(media.seasonYear) : null,
      type: media.format,
      studio,
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
        `❌ Gagal: ${escapeHtml((err?.message ?? 'unknown').slice(0, 200))}`
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
      const { data: jikan, error: searchError } = await safeFetch(
        () => searchJikan(session.title),
        TIMEOUT_SEARCH
      );

      if (!jikan) {
        await ctx.reply(
          `❌ Gagal ambil data Jikan: ${escapeHtml(searchError ?? 'unknown')}\n\n` +
            '<i>Ulangi /dba atau tunggu 30 detik.</i>',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const media = jikanToAniList(jikan);

      /* ---------- METADATA ---------- */
      if (action === 'm') {
        const yaml = buildMetadataYaml({
          media,
          malId: jikan.mal_id,
          kitsuId: null,
        });
        await sendLongMessage(ctx, `Metadata — ${session.title}`, yaml);
        return;
      }

      /* ---------- CHARACTERS ---------- */
      if (action === 'c') {
        const { data: chars, error } = await safeFetch(
          () => getCharacters(session.mal_id),
          TIMEOUT_CHARS
        );

        const yaml = chars
          ? buildCharactersYaml(chars)
          : fallbackYaml('characters', error ?? 'unknown');

        await sendLongMessage(ctx, `Characters — ${session.title}`, yaml);
        return;
      }

      /* ---------- EPISODES ---------- */
      if (action === 'e') {
        const { data: eps, error } = await safeFetch(
          () => getAllEpisodes(session.mal_id, 100),
          TIMEOUT_EPISODES
        );

        const yaml = eps
          ? buildEpisodesYaml(eps)
          : fallbackYaml('episodes', error ?? 'unknown');

        await sendLongMessage(ctx, `Episodes — ${session.title}`, yaml);
        return;
      }

      /* ---------- FRANCHISES ---------- */
      if (action === 'f') {
        const { data: rels, error } = await safeFetch(
          () => getRelations(session.mal_id),
          TIMEOUT_RELATIONS
        );

        const yaml = rels
          ? buildFranchisesYaml(rels)
          : fallbackYaml('franchises', error ?? 'unknown');

        await sendLongMessage(ctx, `Franchises — ${session.title}`, yaml);
        return;
      }

      /* ---------- SUMMARY ---------- */
      if (action === 's') {
        const cleaned = cleanSynopsis(media.description);

        const { data: ai } = await safeFetch(
          () => rewriteSynopsis(env, session.title, cleaned),
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
            (cleaned || 'Tulis sinopsis manual...');
        }

        await sendLongMessage(ctx, `Summary — ${session.title}`, body);
        return;
      }

      /* ---------- ALL ---------- */
      if (action === 'a') {
        await ctx.reply('⏳ All (1/5): Metadata...');

        const metaYaml = buildMetadataYaml({
          media,
          malId: jikan.mal_id,
          kitsuId: null,
        });

        await ctx.reply('⏳ All (2/5): Characters...');
        const { data: chars, error: charsErr } = await safeFetch(
          () => getCharacters(session.mal_id),
          TIMEOUT_CHARS
        );
        const charsYaml = chars
          ? buildCharactersYaml(chars)
          : fallbackYaml('characters', charsErr ?? 'unknown');

        await ctx.reply('⏳ All (3/5): Episodes...');
        const { data: eps, error: epsErr } = await safeFetch(
          () => getAllEpisodes(session.mal_id, 100),
          TIMEOUT_EPISODES
        );
        const epsYaml = eps
          ? buildEpisodesYaml(eps)
          : fallbackYaml('episodes', epsErr ?? 'unknown');

        await ctx.reply('⏳ All (4/5): Franchises...');
        const { data: rels, error: relsErr } = await safeFetch(
          () => getRelations(session.mal_id),
          TIMEOUT_RELATIONS
        );
        const relsYaml = rels
          ? buildFranchisesYaml(rels)
          : fallbackYaml('franchises', relsErr ?? 'unknown');

        await ctx.reply('⏳ All (5/5): Summary...');
        const cleaned = cleanSynopsis(media.description);
        const { data: ai } = await safeFetch(
          () => rewriteSynopsis(env, session.title, cleaned),
          AI_TIMEOUT_MS
        );
        const summary =
          '<!--\n' +
          '  ⚠️ Sinopsis di-generate AI. Tinjau ulang sebelum commit.\n' +
          '-->\n\n' +
          (ai || cleaned || 'Tulis sinopsis manual...');

        const full = buildAllMarkdown({
          metadata: metaYaml,
          characters: charsYaml,
          episodes: epsYaml,
          franchises: relsYaml,
          summary,
        });

        await sendLongMessage(ctx, `All — ${session.title}`, full);
        await deleteSession(env.DB, sessionId);
        return;
      }
    } catch (err: any) {
      console.error('[DBA] callback error:', err);
      const msg = err?.message ?? 'unknown';

      let hint = '';
      if (msg.includes('aborted') || msg.includes('timeout')) {
        hint = '\n\n<i>Jikan API lambat. Coba lagi dalam 30 detik.</i>';
      } else if (msg.includes('429')) {
        hint = '\n\n<i>Rate limit Jikan. Tunggu 1 menit.</i>';
      } else if (msg.includes('HTTP 5')) {
        hint = '\n\n<i>Jikan sedang down. Coba lagi nanti.</i>';
      }

      await ctx.reply(
        `❌ Gagal: ${escapeHtml(msg.slice(0, 200))}${hint}`,
        { parse_mode: 'HTML' }
      );
    }
  });
}
