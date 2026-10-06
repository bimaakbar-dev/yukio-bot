// src/commands/database-anime.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import type { AniListMedia } from '../types/anime';
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
import { searchShikimori, shikimoriToAniList } from '../services/shikimori';
import { searchKitsu, kitsuToAniList } from '../services/kitsu';
import { getMetadataFromAniList } from '../services/anilist';
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
const SOURCE_TIMEOUT_MS = 8000;

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
            metadata     TEXT,
            fetched_sources TEXT,
            created_at   INTEGER NOT NULL,
            expires_at   INTEGER NOT NULL
          )`
        )
        .run();

      for (const col of ['metadata', 'fetched_sources']) {
        try {
          await db
            .prepare(`ALTER TABLE qimochi_sessions ADD COLUMN ${col} TEXT`)
            .run();
        } catch {}
      }

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
  metadata: string | null;
  fetched_sources: string | null;
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
    metadata?: AniListMedia | null;
    fetchedSources?: string[];
  }
): Promise<string> {
  await ensureDb(db);

  const sessionId = `q_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO qimochi_sessions
        (session_id, user_id, mal_id, kitsu_id, title, cover, year, type, studio, source, metadata, fetched_sources, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      data.metadata ? JSON.stringify(data.metadata) : null,
      data.fetchedSources ? JSON.stringify(data.fetchedSources) : null,
      now,
      now + SESSION_TTL_MS
    )
    .run();

  return sessionId;
}

async function updateSessionMetadata(
  db: D1Database,
  sessionId: string,
  metadata: AniListMedia,
  fetchedSources: string[]
): Promise<void> {
  await ensureDb(db);
  await db
    .prepare(
      `UPDATE qimochi_sessions
       SET metadata = ?, fetched_sources = ?, title = ?, cover = ?
       WHERE session_id = ?`
    )
    .bind(
      JSON.stringify(metadata),
      JSON.stringify(fetchedSources),
      metadata.title.romaji,
      metadata.coverImage.extraLarge,
      sessionId
    )
    .run();
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

  return db
    .prepare(
      `SELECT * FROM qimochi_sessions
       WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(userId, Date.now())
    .first<SessionRow>();
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

interface MissingInfo {
  fields: string[];
  canShikimori: boolean;
  canKitsu: boolean;
}

const SHIKIMORI_CAN_FILL = new Set([
  'titleEnglish', 'titleNative', 'malId', 'source',
  'duration', 'rating', 'aired.to', 'genres', 'studios',
  'banner', 'trailer', 'stats.score',
]);

const KITSU_CAN_FILL = new Set([
  'titleEnglish', 'titleNative', 'kitsuId',
  'duration', 'banner', 'aired.to', 'genres', 'stats.score',
]);

function detectMissing(
  media: AniListMedia,
  fetchedSources: string[]
): MissingInfo {
  const fields: string[] = [];

  if (!media.title.english) fields.push('titleEnglish');
  if (!media.title.native) fields.push('titleNative');
  if (!media.myanimelistId) fields.push('malId');
  if (!media.source) fields.push('source');
  if (!media.duration) fields.push('duration');
  if (!media.rating) fields.push('rating');
  if (!media.endDate) fields.push('aired.to');
  if (!media.genres || media.genres.length === 0) fields.push('genres');
  if (!media.studios?.nodes?.length) fields.push('studios');
  if (!media.banner) fields.push('banner');
  if (!media.trailer) fields.push('trailer');
  if (!media.averageScore) fields.push('stats.score');

  const hasShiki = fetchedSources.includes('shikimori');
  const hasKitsu = fetchedSources.includes('kitsu');

  const canShikimori =
    !hasShiki && fields.some((f) => SHIKIMORI_CAN_FILL.has(f));
  const canKitsu =
    !hasKitsu && fields.some((f) => KITSU_CAN_FILL.has(f));

  return { fields, canShikimori, canKitsu };
}

interface MergeResult {
  merged: AniListMedia;
  filled: string[];
}

function mergeMetadata(
  base: AniListMedia,
  incoming: AniListMedia,
  sourceName: string
): MergeResult {
  const merged: AniListMedia = JSON.parse(JSON.stringify(base));
  const filled: string[] = [];

  if (!merged.title.english && incoming.title.english) {
    merged.title.english = incoming.title.english;
    filled.push('titleEnglish');
  }

  if (!merged.title.native && incoming.title.native) {
    merged.title.native = incoming.title.native;
    filled.push('titleNative');
  }

  if (!merged.myanimelistId && incoming.myanimelistId) {
    merged.myanimelistId = incoming.myanimelistId;
    filled.push('malId');
  }

  if (!merged.source && incoming.source) {
    merged.source = incoming.source;
    filled.push('source');
  }

  if (!merged.duration && incoming.duration) {
    merged.duration = incoming.duration;
    filled.push('duration');
  }

  if (!merged.rating && incoming.rating) {
    merged.rating = incoming.rating;
    filled.push('rating');
  }

  if (!merged.endDate && incoming.endDate) {
    merged.endDate = incoming.endDate;
    filled.push('aired.to');
  }

  if (
    (!merged.genres || merged.genres.length === 0) &&
    incoming.genres?.length
  ) {
    merged.genres = incoming.genres;
    filled.push('genres');
  }

  if (!merged.studios?.nodes?.length && incoming.studios?.nodes?.length) {
    merged.studios = incoming.studios;
    filled.push('studios');
  }

  if (!merged.banner && incoming.banner) {
    merged.banner = incoming.banner;
    filled.push('banner');
  }

  if (!merged.trailer && incoming.trailer) {
    merged.trailer = incoming.trailer;
    filled.push('trailer');
  }

  if (!merged.averageScore && incoming.averageScore) {
    merged.averageScore = incoming.averageScore;
    filled.push('stats.score');
  }

  if (!merged.coverImage.extraLarge && incoming.coverImage.extraLarge) {
    merged.coverImage.extraLarge = incoming.coverImage.extraLarge;
    merged.coverImage.large = incoming.coverImage.large;
    filled.push('image');
  }

  console.log(
    `[Merge] ${sourceName} filled: ${filled.length > 0 ? filled.join(', ') : 'nothing'}`
  );

  return { merged, filled };
}

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
): Promise<{ newCount: number; skippedCount: number }> {
  if (vas.length === 0) return { newCount: 0, skippedCount: 0 };

  await ensureDb(db);

  const CHUNK = 100;

  const existingSet = new Set<string>();

  for (let i = 0; i < vas.length; i += CHUNK) {
    const slice = vas.slice(i, i + CHUNK);
    const ids = slice.map((v) => v.id);
    const placeholders = ids.map(() => '?').join(',');
    const res = await db
      .prepare(`SELECT id FROM voice_actors WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<{ id: string }>();
    for (const r of res.results ?? []) {
      existingSet.add(r.id);
    }
  }

  const newVAs = vas.filter((v) => !existingSet.has(v.id));

  if (newVAs.length === 0) {
    console.log(`[DBA] VA: ${vas.length} total, semua sudah ada`);
    return { newCount: 0, skippedCount: vas.length };
  }

  const now = Date.now();

  for (let i = 0; i < newVAs.length; i += CHUNK) {
    const slice = newVAs.slice(i, i + CHUNK);
    const stmts = slice.map((v) =>
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
  }

  console.log(
    `[DBA] VA: ${newVAs.length} baru disimpan, ${vas.length - newVAs.length} sudah ada`
  );

  return {
    newCount: newVAs.length,
    skippedCount: vas.length - newVAs.length,
  };
}

function getFetchedSources(session: SessionRow): string[] {
  if (!session.fetched_sources) return [];
  try {
    const arr = JSON.parse(session.fetched_sources);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function getSessionMetadata(session: SessionRow): AniListMedia | null {
  if (!session.metadata) return null;
  try {
    return JSON.parse(session.metadata) as AniListMedia;
  } catch {
    return null;
  }
}

function buildMetadataKeyboard(
  sessionId: string,
  missing: MissingInfo
): InlineKeyboard {
  const kb = new InlineKeyboard();
  let hasRow = false;

  if (missing.canShikimori) {
    kb.text('📡 Cari Shikimori', `qd:ms:${sessionId}`);
    hasRow = true;
  }
  if (missing.canKitsu) {
    if (hasRow) kb.row();
    kb.text('📡 Cari Kitsu', `qd:mk:${sessionId}`);
    hasRow = true;
  }
  if (hasRow) kb.row();
  kb.text('✅ Selesai', `qd:mo:${sessionId}`);

  return kb;
}

function buildMetadataView(
  session: SessionRow,
  media: AniListMedia,
  missing: MissingInfo,
  sources: string[]
): string {
  const yaml = buildMetadataYaml({
    media,
    malId: media.myanimelistId ?? session.mal_id,
    kitsuId: session.kitsu_id,
  });

  const sourceLabel = sources.length > 0
    ? sources.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' + ')
    : '—';

  const lines: string[] = [];
  lines.push(`📋 <b>Metadata — ${escapeHtml(media.title.romaji)}</b>`);
  lines.push(`<i>Sumber: ${escapeHtml(sourceLabel)}</i>`);

  if (missing.fields.length > 0) {
    lines.push('');
    lines.push(
      `⚠️ <b>Field kosong (${missing.fields.length}):</b> ` +
        `<code>${escapeHtml(missing.fields.join(', '))}</code>`
    );
  } else {
    lines.push('');
    lines.push('✅ <b>Semua field lengkap!</b>');
  }

  lines.push('');
  lines.push(`<pre>${escapeHtml(yaml)}</pre>`);

  return lines.join('\n');
}

async function fetchWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number
): Promise<T | null> {
  try {
    return await Promise.race([
      fn(),
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
  } catch {
    return null;
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

  const loading = await ctx.reply('🔍 Mencari (AniList → Shikimori → Kitsu)...');

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
      metadata: media,
      fetchedSources: ['anilist'],
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

    if (ctx.message?.message_id) {
      await trackMessage(env.DB, sessionId, ctx.message.message_id);
    }
    await trackMessage(env.DB, sessionId, loading.message_id);
    await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});

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

function buildChainContext(session: SessionRow): ChainContext {
  return {
    malId: session.mal_id,
    kitsuId: session.kitsu_id,
    title: session.title,
  };
}

async function handleMetadataShow(
  ctx: Context,
  env: Env,
  session: SessionRow,
  tracker: Tracker
): Promise<void> {
  let media = getSessionMetadata(session);

  // Belum ada metadata → fetch AniList
  if (!media) {
    const fetched = await fetchWithTimeout(
      () => getMetadataFromAniList(session.title),
      SOURCE_TIMEOUT_MS
    );

    if (!fetched) {
      const msg = await ctx.reply(
        '❌ Gagal fetch metadata dari AniList.',
        { parse_mode: 'HTML' }
      );
      await tracker(msg.message_id);
      return;
    }

    media = fetched;
    await updateSessionMetadata(env.DB, session.session_id, media, ['anilist']);
  }

  const sources = getFetchedSources(session);
  const missing = detectMissing(media, sources);
  const view = buildMetadataView(session, media, missing, sources);
  const kb = buildMetadataKeyboard(session.session_id, missing);

  const msg = await ctx.reply(view, {
    parse_mode: 'HTML',
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
  await tracker(msg.message_id);
}

async function handleMetadataMerge(
  ctx: Context,
  env: Env,
  session: SessionRow,
  sourceName: 'shikimori' | 'kitsu',
  tracker: Tracker
): Promise<void> {
  const media = getSessionMetadata(session);
  if (!media) {
    const msg = await ctx.reply('❌ Session tidak punya metadata.');
    await tracker(msg.message_id);
    return;
  }

  const sources = getFetchedSources(session);
  if (sources.includes(sourceName)) {
    const msg = await ctx.reply(
      `ℹ️ ${sourceName} sudah pernah di-fetch.`,
      { parse_mode: 'HTML' }
    );
    await tracker(msg.message_id);
    return;
  }

  // Fetch source baru
  let incoming: AniListMedia | null = null;

  if (sourceName === 'shikimori') {
    const shiki = await fetchWithTimeout(
      () => searchShikimori(session.title),
      SOURCE_TIMEOUT_MS
    );
    if (shiki) incoming = shikimoriToAniList(shiki);
  } else if (sourceName === 'kitsu') {
    const kitsu = await fetchWithTimeout(
      () => searchKitsu(session.title),
      SOURCE_TIMEOUT_MS
    );
    if (kitsu) incoming = kitsuToAniList(kitsu);
  }

  if (!incoming) {
    const msg = await ctx.reply(
      `❌ Gagal fetch dari ${sourceName}.`,
      { parse_mode: 'HTML' }
    );
    await tracker(msg.message_id);
    return;
  }

  // Merge
  const { merged, filled } = mergeMetadata(media, incoming, sourceName);

  // Update session
  const newSources = [...sources, sourceName];
  await updateSessionMetadata(env.DB, session.session_id, merged, newSources);

  // Reload session (untuk title/cover baru)
  const updatedSession = (await getSession(env.DB, session.session_id))!;

  // Notif kalau tidak ada yang di-fill
  if (filled.length === 0) {
    const msg = await ctx.reply(
      `ℹ️ <i>Tidak ada field baru dari ${sourceName}.</i>`,
      { parse_mode: 'HTML' }
    );
    await tracker(msg.message_id);
    return;
  }

  // Tampilkan YAML baru
  const missing = detectMissing(merged, newSources);
  const view = buildMetadataView(updatedSession, merged, missing, newSources);
  const kb = buildMetadataKeyboard(session.session_id, missing);

  const msg = await ctx.reply(view, {
    parse_mode: 'HTML',
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
  await tracker(msg.message_id);
}

export function setupDatabaseAnimeCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(
    /^qd:(ms|mk|mo|m|c|e|f|s|v|x):(q_[a-f0-9]+)$/,
    async (ctx) => {
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
        await ctx
          .editMessageReplyMarkup({ reply_markup: undefined })
          .catch(() => {});
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

      // === SELESAI (metadata) ===
      if (action === 'mo') {
        await ctx.answerCallbackQuery({ text: '✅ Selesai!' });
        await ctx
          .editMessageReplyMarkup({ reply_markup: undefined })
          .catch(() => {});
        return;
      }

      // === METADATA REDIRECT → Shikimori ===
      if (action === 'ms') {
        await ctx.answerCallbackQuery({ text: '📡 Cari Shikimori...' });
        const tracker: Tracker = (msgId) =>
          trackMessage(env.DB, sessionId, msgId);
        await handleMetadataMerge(ctx, env, session, 'shikimori', tracker);
        return;
      }

      // === METADATA REDIRECT → Kitsu ===
      if (action === 'mk') {
        await ctx.answerCallbackQuery({ text: '📡 Cari Kitsu...' });
        const tracker: Tracker = (msgId) =>
          trackMessage(env.DB, sessionId, msgId);
        await handleMetadataMerge(ctx, env, session, 'kitsu', tracker);
        return;
      }

      // === VOICE ACTORS redirect ===
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
          await handleMetadataShow(ctx, env, session, tracker);
          return;
        }

        /* ---------- CHARACTERS ---------- */
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
    }
  );
}
