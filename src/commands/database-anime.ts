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
import { askAI } from '../services/ai';
import {
  escapeHtml,
  sendTextSection,
  sendJsonSection,
  sendAutoDelete,
  trackMessage,
  clearTrackedSession,
  ensureTrackDb,
  type Tracker,
} from '../lib/telegram-utils';
import { showVaMenu } from './va';

const SESSION_TTL_MS = 30 * 60 * 1000;
const AI_TIMEOUT_MS = 12000;

/* ============================================================
   DB: INIT (sessions + voice_actors)
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

      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS voice_actors (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            nameNative      TEXT,
            image           TEXT,
            defaultLanguage TEXT,
            created_at      INTEGER NOT NULL
          )`
        )
        .run();

      await ensureTrackDb(db);

      dbReady = true;
    } catch (err) {
      console.error('[DBA] DB init error:', err);
      dbInitPromise = null;
      throw err;
    }
  })();

  return dbInitPromise;
}

/* ============================================================
   DB: SESSION
   ============================================================ */

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

async function getLatestSessionByUser(
  db: D1Database,
  userId: number
): Promise<SessionRow | null> {
  await ensureDb(db);

  const row = await db
    .prepare(
      `SELECT * FROM qimochi_sessions
       WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(userId, Date.now())
    .first<SessionRow>();

  return row;
}

async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM qimochi_sessions WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.error('[DBA] delete session error:', err);
  }
}

/* ============================================================
   VOICE ACTORS STORE (untuk disimpan silent saat klik Characters)
   ============================================================ */

interface VoiceActorInput {
  id: string;
  name: string;
  nameNative?: string;
  image?: string;
  defaultLanguage?: string;
}

async function saveVoiceActors(
  db: D1Database,
  vas: VoiceActorInput[]
): Promise<void> {
  if (vas.length === 0) return;

  await ensureDb(db);

  const ids = vas.map((v) => v.id);
  const placeholders = ids.map(() => '?').join(',');
  const existing = await db
    .prepare(`SELECT id FROM voice_actors WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: string }>();

  const existingSet = new Set((existing.results ?? []).map((r) => r.id));
  const newVAs = vas.filter((v) => !existingSet.has(v.id));

  if (newVAs.length === 0) {
    console.log(`[DBA] VA: ${vas.length} total, semua sudah ada`);
    return;
  }

  const now = Date.now();
  const stmts = newVAs.map((v) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO voice_actors
         (id, name, nameNative, image, defaultLanguage, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        v.id,
        v.name,
        v.nameNative ?? null,
        v.image ?? null,
        v.defaultLanguage ?? 'Japanese',
        now
      )
  );

  await db.batch(stmts);

  console.log(
    `[DBA] VA: ${newVAs.length} baru disimpan, ${vas.length - newVAs.length} sudah ada`
  );
}

/* ============================================================
   HELPERS
   ============================================================ */

function buildKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('📋 Metadata', `qd:m:${sessionId}`)
    .text('👥 Characters', `qd:c:${sessionId}`)
    .row()
    .text('🎬 Episodes', `qd:e:${sessionId}`)
    .text('🔗 Franchises', `qd:f:${sessionId}`)
    .row()
    .text('🎤 Voice Actors', `qd:v:${sessionId}`)
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
   COMMAND: /dba
   ============================================================ */

async function handleCommand(ctx: Context, env: Env): Promise<void> {
  const query = typeof ctx.match === 'string' ? ctx.match.trim() : '';

  if (!query) {
    await ctx.reply(
      '<b>📚 Database Anime (Yukionime)</b>\n\n' +
        '<b>Contoh:</b>\n' +
        '<code>/dba nama anime</code>\n\n' +
        '<i>Ketik /end untuk membersihkan semua pesan session.</i>',
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

    // Track pesan user
    if (ctx.message?.message_id) {
      await trackMessage(env.DB, sessionId, ctx.message.message_id);
    }

    // Track loading message, lalu hapus
    await trackMessage(env.DB, sessionId, loading.message_id);
    await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});

    // Kirim preview
    if (session.cover) {
      const msg = await ctx.replyWithPhoto(session.cover, {
        caption: buildPreviewText(session),
        parse_mode: 'HTML',
        reply_markup: buildKeyboard(sessionId),
      });
      await trackMessage(env.DB, sessionId, msg.message_id);
    } else {
      const msg = await ctx.reply(buildPreviewText(session), {
        parse_mode: 'HTML',
        reply_markup: buildKeyboard(sessionId),
        link_preview_options: { is_disabled: true },
      });
      await trackMessage(env.DB, sessionId, msg.message_id);
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
   COMMAND: /end
   ============================================================ */

export const endCommand: CommandDefinition = {
  name: 'end',
  description: 'Hapus semua pesan session /dba aktif',
  adminOnly: true,

  handler: async (ctx, env) => {
    if (!ctx.from?.id || !ctx.chat?.id) return;

    await ensureDb(env.DB);

    const endMsgId = ctx.message?.message_id;

    const session = await getLatestSessionByUser(env.DB, ctx.from.id);

    if (!session) {
      await ctx
        .reply(
          '📭 <i>Tidak ada session /dba aktif.</i>\n\n' +
            'Ketik <code>/dba &lt;judul&gt;</code> untuk mulai.',
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
        )
        .catch(() => {});
      return;
    }

    if (endMsgId) {
      await trackMessage(env.DB, session.session_id, endMsgId);
    }

    console.log(
      `[DBA] /end — clearing session ${session.session_id} (${session.title})`
    );

    const deleted = await clearTrackedSession(
      ctx.api,
      env.DB,
      ctx.chat.id,
      session.session_id
    );

    await deleteSession(env.DB, session.session_id);

    await sendAutoDelete(
      ctx,
      `✅ <b>Selesai</b>\n<i>${deleted} pesan dihapus.</i>`
    );
  },
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
  bot.callbackQuery(/^qd:([mcefsvx]):(q_[a-f0-9]+)$/, async (ctx) => {
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

    // === BATAL ===
    if (action === 'x') {
      await ctx.answerCallbackQuery({ text: '🗑️ Membersihkan...' });

      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const deleted = await clearTrackedSession(
        ctx.api,
        env.DB,
        chatId,
        sessionId
      );
      await deleteSession(env.DB, sessionId);

      await sendAutoDelete(
        ctx,
        `✅ <b>Selesai</b>\n<i>${deleted} pesan dihapus.</i>`
      );
      return;
    }

    // === VOICE ACTORS (redirect ke /va menu) ===
    if (action === 'v') {
      await ctx.answerCallbackQuery({ text: '🎤 Buka menu Voice Actors...' });
      await showVaMenu(ctx, env);
      return;
    }

    await ctx.answerCallbackQuery({ text: '⏳ Memproses...' });

    const tracker: Tracker = (msgId) =>
      trackMessage(env.DB, sessionId, msgId);

    try {
      const chainCtx = buildChainContext(session);

      /* ---------- METADATA ---------- */
      if (action === 'm') {
        let result;
        try {
          result = await chainSearch(session.title);
        } catch (err: any) {
          const msg = await ctx.reply(
            `❌ Gagal: ${escapeHtml((err?.message ?? 'unknown').slice(0, 200))}`,
            { parse_mode: 'HTML' }
          );
          await tracker(msg.message_id);
          return;
        }

        const yaml = buildMetadataYaml({
          media: result.media,
          malId: result.malId ?? session.mal_id,
          kitsuId: result.kitsuId ?? session.kitsu_id,
        });
        await sendTextSection(
          ctx,
          `Metadata — ${session.title}`,
          yaml,
          tracker
        );
        return;
      }

      /* ---------- CHARACTERS (simpan VA silent) ---------- */
      if (action === 'c') {
        const { data: result, error } = await safeFetch(
          () => chainCharacters(chainCtx),
          25000
        );

        if (!result || !result.data || result.data.length === 0) {
          const errs = result?.errors ?? [error ?? 'unknown'];
          await sendTextSection(
            ctx,
            `Characters — ${session.title} [FAILED]`,
            fallbackJson(errs),
            tracker
          );
          return;
        }

        const chars = result.data;
        const vas = result.voiceActors;
        const source = result.source;

        if (vas.length > 0) {
          try {
            await saveVoiceActors(env.DB, vas);
          } catch (err) {
            console.warn('[DBA] Gagal simpan VA:', err);
          }
        }

        await sendJsonSection(
          ctx,
          `Characters — ${session.title} [${source}]`,
          chars,
          tracker
        );

        if (vas.length > 0) {
          const msg = await ctx.reply(
            `ℹ️ <i>${vas.length} voice actor tersimpan ke DB. ` +
              `Ketik /va untuk kelola.</i>`,
            { parse_mode: 'HTML' }
          );
          await tracker(msg.message_id);
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
          await sendTextSection(
            ctx,
            `Episodes — ${session.title} [FAILED]`,
            fallbackJson(errs),
            tracker
          );
          return;
        }

        const eps = result.data;
        const truncNote = result.truncated ? ' [⚠️ truncated]' : '';

        await sendJsonSection(
          ctx,
          `Episodes — ${session.title} [${result.source}]${truncNote}`,
          eps,
          tracker
        );
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
          await sendTextSection(
            ctx,
            `Franchises — ${session.title} [FAILED]`,
            fallbackJson(errs),
            tracker
          );
          return;
        }

        await sendJsonSection(
          ctx,
          `Franchises — ${session.title} [${result.source}]`,
          result.data,
          tracker
        );
        return;
      }

      /* ---------- SUMMARY ---------- */
      if (action === 's') {
        let result;
        try {
          result = await chainSearch(session.title);
        } catch (err: any) {
          const msg = await ctx.reply(
            `❌ Gagal: ${escapeHtml((err?.message ?? 'unknown').slice(0, 200))}`,
            { parse_mode: 'HTML' }
          );
          await tracker(msg.message_id);
          return;
        }

        const raw = getSynopsisRaw(result.media);
        const { data: ai } = await safeFetch(
          () => rewriteSynopsis(env, session.title, raw),
          AI_TIMEOUT_MS
        );

        const body = ai ?? raw ?? 'Tulis sinopsis manual...';
        await sendTextSection(
          ctx,
          `Summary — ${session.title}`,
          body,
          tracker
        );
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

      const m = await ctx.reply(
        `❌ Gagal: ${escapeHtml(msg.slice(0, 200))}${hint}`,
        { parse_mode: 'HTML' }
      );
      await tracker(m.message_id).catch(() => {});
    }
  });
}