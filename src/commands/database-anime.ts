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
  getSynopsisRaw,
} from '../services/qimochi-yaml';
import {
  buildCharactersJson,
  buildEpisodesJson,
  buildFranchisesJson,
  buildVoiceActorsJson,
  chunkArray,
  chunkRangeLabel,
} from '../services/qimochi-json';
import { askAI } from '../services/ai';

const SESSION_TTL_MS = 30 * 60 * 1000;
const MSG_LIMIT = 3500;
const AI_TIMEOUT_MS = 12000;
const CHUNK_SIZE = 200;

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

function splitInline(text: string, max: number): string[] {
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
 * Kirim section (YAML / JSON) inline via <pre>.
 * Kalau panjang, split per MSG_LIMIT dengan label [N/M].
 */
async function sendSection(
  ctx: Context,
  label: string,
  content: string
): Promise<void> {
  const parts = splitInline(content, MSG_LIMIT);

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
        `[DBA] sendSection part ${i + 1}/${parts.length} failed: ${err?.message ?? err}`
      );
      throw err;
    }

    if (i < parts.length - 1) {
      await new Promise((r) => setTimeout(r, 400));
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

function fallbackJson(errors: string[]): string {
  return JSON.stringify(
    { error: true, message: 'Semua sumber gagal', errors },
    null,
    2
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

/* ============================================================
   COMMAND HANDLER
   ============================================================ */

async function handleCommand(ctx: Context, env: Env): Promise<void> {
  const query = typeof ctx.match === 'string' ? ctx.match.trim() : '';

  if (!query) {
    await ctx.reply(
      '<b>📚 Database Anime (Yukionime)</b>\n\n' +
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
  description: 'Generate data untuk Yukionime',
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
  bot.callbackQuery(/^qd:([mcefsx]):(q_[a-f0-9]+)$/, async (ctx) => {
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
        await sendSection(ctx, `Metadata — ${session.title}`, yaml);
        return;
      }

      /* ---------- CHARACTERS (+ VA) ---------- */
      if (action === 'c') {
        const { data: result, error } = await safeFetch(
          () => chainCharacters(chainCtx),
          25000
        );

        if (!result || !result.data || result.data.length === 0) {
          const errs = result?.errors ?? [error ?? 'unknown'];
          await sendSection(
            ctx,
            `Characters — ${session.title} [FAILED]`,
            fallbackJson(errs)
          );
          return;
        }

        const chars = result.data;
        const vas = result.voiceActors;
        const source = result.source;
        const chunks = chunkArray(chars, CHUNK_SIZE);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!;
          const range = chunkRangeLabel(i, CHUNK_SIZE, chars.length);
          const json = buildCharactersJson(chunk);

          await sendSection(
            ctx,
            `Characters ${range} — ${session.title} [${source}] [${i + 1}/${chunks.length}]`,
            json
          );

          if (i < chunks.length - 1) {
            await new Promise((r) => setTimeout(r, 400));
          }
        }

        if (vas.length > 0) {
          const vaJson = buildVoiceActorsJson(vas);
          await sendSection(
            ctx,
            `Voice Actors (${vas.length}) — ${session.title} [append ke voice-actors.json]`,
            vaJson
          );
        } else {
          await ctx.reply(
            'ℹ️ <i>Tidak ada data voice actor dari sumber.</i>',
            { parse_mode: 'HTML' }
          );
        }

        return;
      }

      /* ---------- EPISODES ---------- */
      if (action === 'e') {
        const { data: result, error } = await safeFetch(
          () => chainEpisodes(chainCtx),
          30000
        );

        if (!result || !result.data || result.data.length === 0) {
          const errs = result?.errors ?? [error ?? 'unknown'];
          await sendSection(
            ctx,
            `Episodes — ${session.title} [FAILED]`,
            fallbackJson(errs)
          );
          return;
        }

        const eps = result.data;
        const chunks = chunkArray(eps, CHUNK_SIZE);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!;
          const range = chunkRangeLabel(i, CHUNK_SIZE, eps.length);
          const json = buildEpisodesJson(chunk);
          const truncated = result.truncated && i === chunks.length - 1;
          const truncNote = truncated ? ' [⚠️ truncated]' : '';

          await sendSection(
            ctx,
            `Episodes ${range} — ${session.title} [${result.source}]${truncNote} [${i + 1}/${chunks.length}]`,
            json
          );

          if (i < chunks.length - 1) {
            await new Promise((r) => setTimeout(r, 400));
          }
        }

        return;
      }

      /* ---------- FRANCHISES ---------- */
      if (action === 'f') {
        const { data: result, error } = await safeFetch(
          () => chainRelations(chainCtx),
          25000
        );

        if (!result || !result.data || result.data.length === 0) {
          const errs = result?.errors ?? [error ?? 'unknown'];
          await sendSection(
            ctx,
            `Franchises — ${session.title} [FAILED]`,
            fallbackJson(errs)
          );
          return;
        }

        const json = buildFranchisesJson(result.data);
        await sendSection(
          ctx,
          `Franchises — ${session.title} [${result.source}]`,
          json
        );
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

        const body = ai
          ? ai
          : raw || 'Tulis sinopsis manual...';

        await sendSection(ctx, `Summary — ${session.title}`, body);
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
