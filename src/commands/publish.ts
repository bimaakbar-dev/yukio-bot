// src/commands/publish.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import type { AniListMedia } from '../types/anime';
import {
  githubCommitFile,
  githubCommitMultipleFiles,
  githubGetFile,
  githubListDir,
  type FileToCommit,
  type RepoTarget,
} from '../lib/github';
import { buildMetadataYaml } from '../services/qimochi-yaml';
import { getCharCache } from '../lib/dba-characters';

const BATCH_TTL_MS = 24 * 60 * 60 * 1000;
const PUBLISH_TTL_MS = 30 * 60 * 1000;
const CHAR_PART_SIZE = 50;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface EpisodeObject {
  number: number;
  streams: { quality: string; servers: { name: string; url: string }[] }[];
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
  slug: string | null;
  created_at: number;
  expires_at: number;
}

interface BatchSessionRow {
  session_id: string;
  user_id: number;
  slug_hint: string | null;
  chosen_slug: string | null;
  suggestions: string | null;
  combined_json: string;
  min_ep: number;
  max_ep: number;
  total_urls: number | null;
  errors: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface StartOrAppendResult {
  sessionId: string;
  mode: 'created' | 'appended' | 'reset_and_created';
  slugHint: string | null;
  totalEpisodes: number;
  minEp: number;
  maxEp: number;
  totalUrls: number;
  added: number[];
  skipped: number[];
}

interface DbaSessionRow {
  session_id: string;
  user_id: number;
  mal_id: number | null;
  kitsu_id: string | null;
  title: string;
  metadata: string | null;
  summary: string | null;
  expires_at: number;
}

interface PendingPublishRow {
  session_id: string;
  user_id: number;
  files_json: string;
  summary_json: string;
  created_at: number;
  expires_at: number;
}

interface SectionInfo {
  count: number;
  files: number;
}

interface PublishSummary {
  yukionime: { metadata: boolean };
  yukioData: {
    characters: SectionInfo;
    episodes: SectionInfo;
    franchises: SectionInfo;
    actors: SectionInfo;
  };
  qimochi: {
    franchises: SectionInfo;
  };
}

function emptySummary(): PublishSummary {
  return {
    yukionime: { metadata: false },
    yukioData: {
      characters: { count: 0, files: 0 },
      episodes: { count: 0, files: 0 },
      franchises: { count: 0, files: 0 },
      actors: { count: 0, files: 0 },
    },
    qimochi: {
      franchises: { count: 0, files: 0 },
    },
  };
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

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
            slug         TEXT,
            created_at   INTEGER NOT NULL,
            expires_at   INTEGER NOT NULL
          )`
        )
        .run();
      try {
        await db.prepare('ALTER TABLE temp_anime ADD COLUMN slug TEXT').run();
      } catch {}
      dbReady = true;
    } catch (err) {
      console.error('[Publish] DB init error:', err);
      dbInitPromise = null;
      throw err;
    }
  })();

  return dbInitPromise;
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

async function deleteSession(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM temp_anime WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[Publish] deleteSession error:', err);
  }
}

function buildMarkdown(session: SessionRow): string {
  const body = session.body.trim();
  return `${session.yaml}\n\n${body}\n`;
}

let batchDbReady = false;
let batchDbInitPromise: Promise<void> | null = null;

async function ensureBatchDb(db: D1Database): Promise<void> {
  if (batchDbReady) return;
  if (batchDbInitPromise) return batchDbInitPromise;

  batchDbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS batch_sessions (
            session_id     TEXT PRIMARY KEY,
            user_id        INTEGER NOT NULL,
            slug_hint      TEXT,
            chosen_slug    TEXT,
            suggestions    TEXT,
            combined_json  TEXT NOT NULL,
            min_ep         INTEGER NOT NULL,
            max_ep         INTEGER NOT NULL,
            total_urls     INTEGER,
            errors         TEXT,
            created_at     INTEGER NOT NULL,
            updated_at     INTEGER NOT NULL,
            expires_at     INTEGER NOT NULL
          )`
        )
        .run();
      await db
        .prepare(
          'CREATE INDEX IF NOT EXISTS idx_batch_sessions_user ON batch_sessions(user_id, updated_at DESC)'
        )
        .run();
      batchDbReady = true;
    } catch (err) {
      console.error('[Publish] batch DB init error:', err);
      batchDbInitPromise = null;
      throw err;
    }
  })();

  return batchDbInitPromise;
}

async function getActiveSession(
  db: D1Database,
  userId: number
): Promise<BatchSessionRow | null> {
  await ensureBatchDb(db);
  try {
    const row = await db
      .prepare(
        `SELECT * FROM batch_sessions
         WHERE user_id = ? AND expires_at > ?
         ORDER BY updated_at DESC LIMIT 1`
      )
      .bind(userId, Date.now())
      .first<BatchSessionRow>();
    return row ?? null;
  } catch (err) {
    console.error('[Publish] getActiveSession error:', err);
    return null;
  }
}

async function getBatchSession(
  db: D1Database,
  sessionId: string
): Promise<BatchSessionRow | null> {
  await ensureBatchDb(db);
  try {
    const row = await db
      .prepare('SELECT * FROM batch_sessions WHERE session_id = ?')
      .bind(sessionId)
      .first<BatchSessionRow>();

    if (!row) return null;
    if (row.expires_at < Date.now()) {
      await db
        .prepare('DELETE FROM batch_sessions WHERE session_id = ?')
        .bind(sessionId)
        .run()
        .catch(() => {});
      return null;
    }
    return row;
  } catch (err) {
    console.error('[Publish] getBatchSession error:', err);
    return null;
  }
}

async function updateBatchChosenSlug(
  db: D1Database,
  sessionId: string,
  slug: string
): Promise<void> {
  await ensureBatchDb(db);
  await db
    .prepare('UPDATE batch_sessions SET chosen_slug = ? WHERE session_id = ?')
    .bind(slug, sessionId)
    .run();
}

async function updateBatchSuggestions(
  db: D1Database,
  sessionId: string,
  suggestions: string[]
): Promise<void> {
  await ensureBatchDb(db);
  await db
    .prepare('UPDATE batch_sessions SET suggestions = ? WHERE session_id = ?')
    .bind(JSON.stringify(suggestions), sessionId)
    .run();
}

async function deleteBatchSession(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await ensureBatchDb(db);
    await db
      .prepare('DELETE FROM batch_sessions WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[Publish] deleteBatchSession error:', err);
  }
}

export async function resetBatchSessions(
  db: D1Database,
  userId: number
): Promise<number> {
  await ensureBatchDb(db);
  try {
    const res = await db
      .prepare('DELETE FROM batch_sessions WHERE user_id = ?')
      .bind(userId)
      .run();
    return res.meta?.changes ?? 0;
  } catch (err) {
    console.error('[Publish] resetBatchSessions error:', err);
    return 0;
  }
}

export async function startOrAppendBatch(
  db: D1Database,
  userId: number,
  data: {
    slugHint: string | null;
    newEpisodes: EpisodeObject[];
    errors: string[];
  }
): Promise<StartOrAppendResult> {
  await ensureBatchDb(db);

  if (data.newEpisodes.length === 0) {
    throw new Error('Tidak ada episode baru untuk disimpan');
  }

  const existing = await getActiveSession(db, userId);
  const now = Date.now();

  let mode: StartOrAppendResult['mode'];
  let existingEpisodes: EpisodeObject[] = [];
  let sessionId: string;
  let isSameSeries = false;

  if (!existing) {
    mode = 'created';
    sessionId = 'b_' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
  } else if (
    !data.slugHint ||
    !existing.slug_hint ||
    existing.slug_hint === data.slugHint
  ) {
    mode = 'appended';
    sessionId = existing.session_id;
    isSameSeries = true;
    try {
      existingEpisodes = JSON.parse(existing.combined_json) as EpisodeObject[];
    } catch {
      existingEpisodes = [];
    }
  } else {
    mode = 'reset_and_created';
    await deleteBatchSession(db, existing.session_id);
    sessionId = 'b_' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
  }

  const existingNumbers = new Set(existingEpisodes.map((e) => e.number));
  const added: number[] = [];
  const skipped: number[] = [];
  const merged: EpisodeObject[] = [...existingEpisodes];

  for (const ep of data.newEpisodes) {
    if (existingNumbers.has(ep.number)) {
      skipped.push(ep.number);
    } else {
      added.push(ep.number);
      merged.push(ep);
    }
  }

  merged.sort((a, b) => a.number - b.number);

  if (merged.length === 0) {
    throw new Error('Tidak ada episode yang bisa disimpan');
  }

  const first = merged[0];
  const last = merged[merged.length - 1];
  if (!first || !last) {
    throw new Error('Gagal menghitung range episode');
  }

  const minEp = first.number;
  const maxEp = last.number;
  const totalUrls = merged.reduce(
    (sum, r) => sum + r.streams.reduce((s, q) => s + q.servers.length, 0),
    0
  );
  const combinedJson = JSON.stringify(merged, null, 2) + '\n';

  let existingErrors: string[] = [];
  if (existing && isSameSeries && existing.errors) {
    try {
      existingErrors = JSON.parse(existing.errors) as string[];
    } catch {
      existingErrors = [];
    }
  }
  const mergedErrors = [...existingErrors, ...data.errors].slice(-20);

  if (mode === 'created' || mode === 'reset_and_created') {
    await db
      .prepare(
        `INSERT INTO batch_sessions
          (session_id, user_id, slug_hint, chosen_slug, suggestions, combined_json, min_ep, max_ep, total_urls, errors, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        sessionId,
        userId,
        data.slugHint,
        null,
        null,
        combinedJson,
        minEp,
        maxEp,
        totalUrls,
        JSON.stringify(mergedErrors),
        now,
        now,
        now + BATCH_TTL_MS
      )
      .run();
  } else {
    await db
      .prepare(
        `UPDATE batch_sessions
         SET combined_json = ?, min_ep = ?, max_ep = ?, total_urls = ?, errors = ?, updated_at = ?, expires_at = ?
         WHERE session_id = ?`
      )
      .bind(
        combinedJson,
        minEp,
        maxEp,
        totalUrls,
        JSON.stringify(mergedErrors),
        now,
        now + BATCH_TTL_MS,
        sessionId
      )
      .run();
  }

  return {
    sessionId,
    mode,
    slugHint: data.slugHint,
    totalEpisodes: merged.length,
    minEp,
    maxEp,
    totalUrls,
    added,
    skipped,
  };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const m: number[][] = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) {
    const row = m[0];
    if (row) row[j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const rowPrev = m[i - 1];
      const rowCurr = m[i];
      if (!rowPrev || !rowCurr) continue;

      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      const del = (rowPrev[j] ?? 0) + 1;
      const ins = (rowCurr[j - 1] ?? 0) + 1;
      const sub = (rowPrev[j - 1] ?? 0) + cost;
      rowCurr[j] = Math.min(del, ins, sub);
    }
  }

  const lastRow = m[b.length];
  return lastRow ? (lastRow[a.length] ?? 0) : 0;
}

function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

async function findSimilarSlugs(
  env: Env,
  hint: string
): Promise<{ slug: string; score: number }[]> {
  if (!hint) return [];
  try {
    const dirs = await githubListDir(env, 'src/data/anime');
    const candidates = dirs
      .filter((d) => d.type === 'dir')
      .map((d) => d.name);

    return candidates
      .map((slug) => ({
        slug,
        score: similarity(hint.toLowerCase(), slug.toLowerCase()),
      }))
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  } catch (err) {
    console.warn('[Publish] findSimilarSlugs error:', err);
    return [];
  }
}

async function doPublishAnime(
  ctx: Context,
  env: Env,
  sessionId: string,
  force: boolean
): Promise<void> {
  const session = await getSession(env.DB, sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({
      text: '⏱️ Session kadaluarsa. Ulangi /anime.',
      show_alert: true,
    });
    return;
  }

  const slug = session.slug?.trim();
  if (!slug) {
    await ctx.answerCallbackQuery({
      text: '❌ Slug kosong. Ulangi /anime.',
      show_alert: true,
    });
    return;
  }

  const path = `src/content/anime/${slug}.md`;
  const content = buildMarkdown(session);

  if (!force) {
    let existing: Awaited<ReturnType<typeof githubGetFile>> = null;
    try {
      existing = await githubGetFile(env, path);
    } catch (err) {
      console.warn('[Publish] getFile failed:', err);
    }

    if (existing) {
      const previewOld = existing.content.slice(0, 300);
      await ctx.answerCallbackQuery({ text: '⚠️ File sudah ada' });

      const kb = new InlineKeyboard()
        .text('✅ Overwrite', `pub:anforce:${sessionId}`)
        .text('❌ Batal', `pub:skip:${sessionId}`);

      await ctx.reply(
        `⚠️ <b>File sudah ada di repo!</b>\n\n` +
          `📁 <code>${escapeHtml(path)}</code>\n` +
          `📏 Lama: <b>${existing.content.length}</b> char\n` +
          `📏 Baru: <b>${content.length}</b> char\n\n` +
          `<b>Preview lama:</b>\n` +
          `<pre>${escapeHtml(previewOld)}</pre>\n\n` +
          `Overwrite?`,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: kb,
        }
      );
      return;
    }
  }

  await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

  const loadingMsg = await ctx.reply(
    `📤 <b>Push ke GitHub...</b>\n\n📁 <code>${escapeHtml(path)}</code>`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );

  const result = await githubCommitFile(
    env,
    path,
    content,
    `feat: add anime ${slug}`
  );

  if (!result.ok) {
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        `❌ <b>Gagal push</b>\n\n<code>${escapeHtml(result.error ?? 'unknown')}</code>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
    return;
  }

  await deleteSession(env.DB, sessionId);

  const commitShort = result.sha?.slice(0, 7) ?? '?';

  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      loadingMsg.message_id,
      `✅ <b>Published!</b>\n\n` +
        `📁 <code>${escapeHtml(path)}</code>\n` +
        `🔗 Commit: <code>${commitShort}</code>\n` +
        `⏳ Deploy: ~2 menit`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    )
    .catch(() => {});
}

async function doPublishBatchInitial(
  ctx: Context,
  env: Env,
  sessionId: string
): Promise<void> {
  const session = await getBatchSession(env.DB, sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({
      text: '⏱️ Batch kadaluarsa. Ulangi /batch.',
      show_alert: true,
    });
    return;
  }

  if (ctx.from?.id !== session.user_id) {
    await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
    return;
  }

  await ctx.answerCallbackQuery({ text: '🔍 Cari slug...' });

  const slugHint = session.slug_hint ?? '';
  const suggestions = slugHint ? await findSimilarSlugs(env, slugHint) : [];

  await updateBatchSuggestions(
    env.DB,
    sessionId,
    suggestions.map((s) => s.slug)
  );

  const lines: string[] = [];
  lines.push(`📦 <b>Publish Batch</b>`);
  lines.push('');
  lines.push(`🎬 <code>${escapeHtml(slugHint || '(slug hint kosong)')}</code>`);
  lines.push(`📊 <b>${session.min_ep}-${session.max_ep}</b>`);
  if (session.total_urls) lines.push(`🎬 URL: <b>${session.total_urls}</b>`);
  lines.push('');

  const kb = new InlineKeyboard();

  if (suggestions.length > 0) {
    lines.push('🔍 <b>Slug mirip di repo:</b>');
    suggestions.forEach((s, i) => {
      const pct = Math.round(s.score * 100);
      lines.push(`${i + 1}. <code>${escapeHtml(s.slug)}</code> (${pct}%)`);
      const label = s.slug.length > 26 ? s.slug.slice(0, 24) + '…' : s.slug;
      kb.text(`📁 ${label} (${pct}%)`, `pub:bp:${sessionId}:${i}`).row();
    });
    lines.push('');
  } else {
    lines.push('⚠️ Tidak ada slug mirip di repo.');
    lines.push('');
  }

  if (slugHint) {
    kb.text('✨ Pakai slug dari URL', `pub:bp:${sessionId}:url`).row();
  }
  kb.text('✏️ Custom slug', `pub:bp:${sessionId}:custom`).row();
  kb.text('❌ Batal', `pub:bax:${sessionId}`);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

async function doPublishBatchPickSlug(
  ctx: Context,
  env: Env,
  sessionId: string,
  pick: string
): Promise<void> {
  const session = await getBatchSession(env.DB, sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: '⏱️ Batch kadaluarsa' });
    return;
  }

  let slug: string | null = null;

  if (pick === 'url') {
    slug = session.slug_hint;
  } else if (pick === 'custom') {
    await ctx.answerCallbackQuery({ text: '✏️ Kirim slug manual' });
    await ctx.reply(
      `✏️ Kirim slug baru via command:\n\n` +
        `<code>/publish_batch ${sessionId} slug-baru-kamu</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  } else {
    const idx = parseInt(pick, 10);
    let arr: string[] = [];
    try {
      arr = session.suggestions
        ? (JSON.parse(session.suggestions) as string[])
        : [];
    } catch {
      arr = [];
    }
    slug = arr[idx] ?? null;
  }

  if (!slug) {
    await ctx.answerCallbackQuery({ text: '❌ Slug tidak valid' });
    return;
  }

  await updateBatchChosenSlug(env.DB, sessionId, slug);
  await ctx.answerCallbackQuery({ text: `✅ ${slug.slice(0, 30)}` });

  await doPublishBatchPreview(ctx, env, sessionId, slug);
}

async function doPublishBatchPreview(
  ctx: Context,
  env: Env,
  sessionId: string,
  slug: string
): Promise<void> {
  const session = await getBatchSession(env.DB, sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: '⏱️ Batch kadaluarsa' });
    return;
  }

  const path = `src/data/anime/${slug}/episodes/${session.min_ep}-${session.max_ep}.json`;
  const sizeKB = Math.round(session.combined_json.length / 1024);

  let episodes: EpisodeObject[] = [];
  try {
    episodes = JSON.parse(session.combined_json) as EpisodeObject[];
  } catch {
    episodes = [];
  }

  const episodeCount = episodes.length;
  const rangeExpected = session.max_ep - session.min_ep + 1;
  const hasGap = episodeCount !== rangeExpected;

  let existing: Awaited<ReturnType<typeof githubGetFile>> = null;
  try {
    existing = await githubGetFile(env, path);
  } catch {}

  const lines: string[] = [];
  lines.push(`📋 <b>Preview Publish</b>`);
  lines.push('');
  lines.push(`📁 <code>${escapeHtml(path)}</code>`);
  lines.push(`📏 ${sizeKB} KB`);
  lines.push(`📊 ${episodeCount} episode (Ep ${session.min_ep}-${session.max_ep})`);
  if (hasGap) {
    lines.push(`⚠️ <i>Ada gap — hanya ${episodeCount} dari ${rangeExpected} episode.</i>`);
  }
  if (session.total_urls) lines.push(`🎬 URL: <b>${session.total_urls}</b>`);
  lines.push('');

  if (existing) {
    lines.push(
      `⚠️ <b>File sudah ada!</b> (${Math.round(existing.content.length / 1024)} KB)`
    );
    lines.push('Akan di-overwrite.');
  } else {
    lines.push('✅ File baru.');
  }

  const kb = new InlineKeyboard()
    .text('📤 Push ke GitHub', `pub:bpush:${sessionId}`)
    .text('❌ Batal', `pub:bax:${sessionId}`);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

async function doPublishBatchPush(
  ctx: Context,
  env: Env,
  sessionId: string
): Promise<void> {
  const session = await getBatchSession(env.DB, sessionId);
  if (!session || !session.chosen_slug) {
    await ctx.answerCallbackQuery({
      text: '⏱️ Batch kadaluarsa atau slug belum dipilih',
      show_alert: true,
    });
    return;
  }

  const slug = session.chosen_slug;
  const path = `src/data/anime/${slug}/episodes/${session.min_ep}-${session.max_ep}.json`;

  await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

  const loading = await ctx.reply(
    `📤 <b>Push ke GitHub...</b>\n\n📁 <code>${escapeHtml(path)}</code>`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );

  const commitMsg = `feat: add episodes ${session.min_ep}-${session.max_ep} for ${slug}`;
  const result = await githubCommitFile(env, path, session.combined_json, commitMsg);

  if (!result.ok) {
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ <b>Gagal push</b>\n\n<code>${escapeHtml(result.error ?? 'unknown')}</code>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
    return;
  }

  await deleteBatchSession(env.DB, sessionId);

  const commitShort = result.sha?.slice(0, 7) ?? '?';
  const siteUrl = `https://qimochi.pages.dev/anime/${slug}/`;

  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      loading.message_id,
      `✅ <b>Published!</b>\n\n` +
        `📁 <code>${escapeHtml(path)}</code>\n` +
        `🔗 Commit: <code>${commitShort}</code>\n` +
        `⏳ Deploy: ~2 menit\n\n` +
        (result.commitUrl ? `<a href="${result.commitUrl}">Lihat commit</a>\n` : '') +
        `🌐 <a href="${siteUrl}">${escapeHtml(siteUrl)}</a>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    )
    .catch(() => {});
}

async function getDbaSession(
  env: Env,
  userId: number
): Promise<DbaSessionRow | null> {
  try {
    const row = await env.DB
      .prepare(
        `SELECT * FROM qimochi_sessions
         WHERE user_id = ? AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(userId, Date.now())
      .first<DbaSessionRow>();
    return row ?? null;
  } catch {
    return null;
  }
}

let pendingPublishDbReady = false;
let pendingPublishDbInitPromise: Promise<void> | null = null;

async function ensurePendingPublishDb(db: D1Database): Promise<void> {
  if (pendingPublishDbReady) return;
  if (pendingPublishDbInitPromise) return pendingPublishDbInitPromise;

  pendingPublishDbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS pending_publish (
            session_id   TEXT PRIMARY KEY,
            user_id      INTEGER NOT NULL,
            files_json   TEXT NOT NULL,
            summary_json TEXT NOT NULL,
            created_at   INTEGER NOT NULL,
            expires_at   INTEGER NOT NULL
          )`
        )
        .run();
      pendingPublishDbReady = true;
    } catch (err) {
      console.error('[Publish] pending DB init error:', err);
      pendingPublishDbInitPromise = null;
      throw err;
    }
  })();

  return pendingPublishDbInitPromise;
}

async function savePendingPublish(
  db: D1Database,
  userId: number,
  files: FileToCommit[],
  summary: PublishSummary
): Promise<string> {
  await ensurePendingPublishDb(db);
  const sessionId = 'pp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 13);
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO pending_publish
        (session_id, user_id, files_json, summary_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      userId,
      JSON.stringify(files),
      JSON.stringify(summary),
      now,
      now + PUBLISH_TTL_MS
    )
    .run();

  return sessionId;
}

async function getPendingPublish(
  db: D1Database,
  sessionId: string
): Promise<PendingPublishRow | null> {
  await ensurePendingPublishDb(db);

  const row = await db
    .prepare('SELECT * FROM pending_publish WHERE session_id = ?')
    .bind(sessionId)
    .first<PendingPublishRow>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM pending_publish WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }

  return row;
}

async function deletePendingPublish(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await ensurePendingPublishDb(db);
    await db
      .prepare('DELETE FROM pending_publish WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[Publish] deletePendingPublish error:', err);
  }
}

function buildMetadataFile(
  session: DbaSessionRow,
  slug: string
): FileToCommit | null {
  if (!session.metadata) return null;

  let media: AniListMedia;
  try {
    media = JSON.parse(session.metadata) as AniListMedia;
  } catch {
    return null;
  }

  const yaml = buildMetadataYaml({
    media,
    malId: session.mal_id ?? null,
    kitsuId: session.kitsu_id ?? null,
  });

  let body: string;

  if (session.summary && session.summary.trim().length > 50) {
    body = session.summary.trim();
  } else {
    const raw = media.description ?? '';
    if (raw.length < 30) {
      body = '> ⚠️ Sinopsis belum tersedia. Silakan isi manual.';
    } else {
      body = stripHtml(raw);
    }
  }

  return {
    path: `src/content/anime/${slug}.md`,
    content: `${yaml}\n\n${body}\n`,
    target: 'yukionime',
  };
}

async function buildCharacterFiles(
  env: Env,
  sessionId: string,
  slug: string
): Promise<FileToCommit[]> {
  const cache = await getCharCache(env.DB, sessionId);
  if (!cache || cache.chars.length === 0) return [];

  const chunks = chunkArray(cache.chars, CHAR_PART_SIZE);
  const files: FileToCommit[] = [];

  let cursor = 1;
  for (const chunk of chunks) {
    const start = cursor;
    const end = cursor + chunk.length - 1;
    files.push({
      path: `data/anime/${slug}/characters/${start}-${end}.json`,
      content: JSON.stringify(chunk, null, 2) + '\n',
      target: 'yukio-data',
      itemCount: chunk.length,
    });
    cursor = end + 1;
  }

  return files;
}

function buildPreviewLines(
  session: DbaSessionRow,
  slug: string,
  summary: PublishSummary,
  totalFiles: number
): string {
  const lines: string[] = [];
  lines.push(`📋 <b>Preview Publish</b>`);
  lines.push('');
  lines.push(`🎬 <code>${escapeHtml(session.title)}</code>`);
  lines.push(`🆔 <code>${slug}</code>`);
  lines.push('');

  const hasAny = () => {
    if (summary.yukionime.metadata) return true;
    const d = summary.yukioData;
    if (d.characters.count > 0) return true;
    if (d.episodes.count > 0) return true;
    if (d.franchises.count > 0) return true;
    if (d.actors.count > 0) return true;
    if (summary.qimochi.franchises.count > 0) return true;
    return false;
  };

  if (!hasAny()) {
    lines.push(`<i>Tidak ada data siap di-publish.</i>`);
    return lines.join('\n');
  }

  if (summary.yukionime.metadata) {
    lines.push(`📄 <b>Metadata + Summary</b> → yukionime`);
  }

  const d = summary.yukioData;
  if (d.characters.count > 0) {
    lines.push(
      `👥 <b>Characters</b> (${d.characters.count}) → yukio-data (${d.characters.files} file)`
    );
  }
  if (d.episodes.count > 0) {
    lines.push(
      `🎬 <b>Episodes</b> (${d.episodes.count}) → yukio-data (${d.episodes.files} file)`
    );
  }
  if (d.franchises.count > 0) {
    lines.push(
      `🔗 <b>Franchises</b> (${d.franchises.count}) → yukio-data`
    );
  }
  if (d.actors.count > 0) {
    lines.push(
      `🎤 <b>Actors</b> (${d.actors.count}) → yukio-data (${d.actors.files} file)`
    );
  }
  if (summary.qimochi.franchises.count > 0) {
    lines.push(
      `🔗 <b>Franchises</b> → qimochi`
    );
  }

  lines.push('');
  lines.push(`📦 Total: <b>${totalFiles}</b> file`);
  return lines.join('\n');
}

async function doPublishNew(ctx: Context, env: Env): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const loading = await ctx.reply('🔍 Scan session...');

  try {
    const session = await getDbaSession(env, userId);

    if (!session) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        '📭 Tidak ada session /dba aktif.\n\n' +
          'Kirim <code>/dba &lt;judul&gt;</code> dulu.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const slug = slugify(session.title);
    const files: FileToCommit[] = [];
    const summary = emptySummary();

    const metaFile = buildMetadataFile(session, slug);
    if (metaFile) {
      files.push(metaFile);
      summary.yukionime.metadata = true;
    }

    try {
      const charFiles = await buildCharacterFiles(env, session.session_id, slug);
      if (charFiles.length > 0) {
        files.push(...charFiles);
        let totalChars = 0;
        for (const cf of charFiles) totalChars += cf.itemCount ?? 0;
        summary.yukioData.characters = {
          count: totalChars,
          files: charFiles.length,
        };
      }
    } catch (err) {
      console.warn('[Publish] buildCharacterFiles error:', err);
    }

    const previewText = buildPreviewLines(session, slug, summary, files.length);

    if (files.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `⚠️ <b>Tidak ada data siap di-publish.</b>\n\n` +
          `Buka <code>/dba</code> → klik <b>📋 Metadata</b>, <b>👥 Characters</b>, atau section lain dulu.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const pendingId = await savePendingPublish(env.DB, userId, files, summary);

    const kb = new InlineKeyboard()
      .text('📤 Push', `pp:push:${pendingId}`)
      .text('❌ Batal', `pp:cancel:${pendingId}`);

    await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, previewText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
    });
  } catch (err: any) {
    console.error('[Publish] scan error:', err);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
}

export const publishAnimeCommand: CommandDefinition = {
  name: 'publish_anime',
  description: 'Push metadata anime ke qimochi',
  usage: '/publish_anime [slug]',
  adminOnly: true,

  handler: async (ctx, env) => {
    const argSlug = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const userId = ctx.from?.id;
    if (!userId) return;

    const row = await env.DB
      .prepare(
        `SELECT * FROM temp_anime
         WHERE user_id = ? AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(userId, Date.now())
      .first<SessionRow>();

    if (!row) {
      await ctx.reply(
        '📭 Tidak ada session /anime yang aktif.\n\n' +
          'Kirim <code>/anime &lt;judul&gt;</code> lalu klik 📋 Convert ke YAML dulu.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const slug = argSlug || row.slug;
    if (!slug) {
      await ctx.reply(
        '❌ Session tidak punya slug. Kirim slug manual:\n' +
          '<code>/publish_anime my-slug-here</code>',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const path = `src/content/anime/${slug}.md`;
    const content = buildMarkdown({ ...row, slug });

    const loading = await ctx.reply(
      `📤 <b>Push ke GitHub...</b>\n\n📁 <code>${escapeHtml(path)}</code>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );

    const result = await githubCommitFile(
      env,
      path,
      content,
      `feat: add anime ${slug}`
    );

    if (!result.ok) {
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ <b>Gagal push</b>\n\n<code>${escapeHtml(result.error ?? 'unknown')}</code>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
      return;
    }

    await deleteSession(env.DB, row.session_id);

    const commitShort = result.sha?.slice(0, 7) ?? '?';
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `✅ <b>Published!</b>\n\n` +
          `📁 <code>${escapeHtml(path)}</code>\n` +
          `🔗 Commit: <code>${commitShort}</code>\n` +
          `⏳ Deploy ~2 menit`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      )
      .catch(() => {});
  },
};

export const publishBatchCommand: CommandDefinition = {
  name: 'publish_batch',
  description: 'Push batch episode ke repo web',
  usage: '/publish_batch [session_id] [slug]',
  adminOnly: true,

  handler: async (ctx, env) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const parts = arg.split(/\s+/).filter(Boolean);

    if (parts.length === 2 && parts[0] && parts[1]) {
      const sessionId = parts[0];
      const customSlug = parts[1];
      const session = await getBatchSession(env.DB, sessionId);
      if (!session) {
        await ctx.reply('❌ Session batch tidak ditemukan / kadaluarsa.');
        return;
      }
      if (session.user_id !== ctx.from?.id) {
        await ctx.reply('⛔ Bukan sesi Anda.');
        return;
      }

      await updateBatchChosenSlug(env.DB, sessionId, customSlug);
      await doPublishBatchPreview(ctx, env, sessionId, customSlug);
      return;
    }

    await ctx.reply(
      '<b>📦 Publish Batch</b>\n\n' +
        '<b>Auto:</b> dari tombol di akhir <code>/batch</code>\n\n' +
        '<b>Manual:</b>\n' +
        '<code>/publish_batch &lt;session_id&gt; &lt;slug&gt;</code>\n\n' +
        '<i>Session ID ada di pesan batch selesai.</i>',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
  },
};

export const batchResetCommand: CommandDefinition = {
  name: 'batch_reset',
  description: 'Hapus semua session batch aktif',
  adminOnly: true,

  handler: async (ctx, env) => {
    if (!ctx.from?.id) return;
    const count = await resetBatchSessions(env.DB, ctx.from.id);
    if (count === 0) {
      await ctx.reply('📭 Tidak ada session batch aktif.');
      return;
    }
    await ctx.reply(`✅ <b>${count}</b> session batch dihapus.`, {
      parse_mode: 'HTML',
    });
  },
};

export const publishCommand: CommandDefinition = {
  name: 'publish',
  description: 'Push semua data ke yukionime + yukio-data',
  usage: '/publish',
  adminOnly: true,

  handler: async (ctx, env) => {
    await doPublishNew(ctx, env);
  },
};

export function setupPublishCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^pub:an:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishAnime(ctx, env, sessionId, false);
  });

  bot.callbackQuery(/^pub:anforce:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishAnime(ctx, env, sessionId, true);
  });

  bot.callbackQuery(/^pub:skip:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (sessionId) await deleteSession(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageReplyMarkup({ reply_markup: undefined })
      .catch(() => {});
    await ctx
      .reply('❌ <b>Dibatalkan.</b>', { parse_mode: 'HTML' })
      .catch(() => {});
  });

  bot.callbackQuery(/^pub:ba:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishBatchInitial(ctx, env, sessionId);
  });

  bot.callbackQuery(/^pub:bp:(b_[a-z0-9]+):(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const pick = ctx.match[2] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishBatchPickSlug(ctx, env, sessionId, pick);
  });

  bot.callbackQuery(/^pub:bpush:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishBatchPush(ctx, env, sessionId);
  });

  bot.callbackQuery(/^pub:bax:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (sessionId) await deleteBatchSession(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageReplyMarkup({ reply_markup: undefined })
      .catch(() => {});
    await ctx
      .reply('❌ <b>Batch dibatalkan.</b>', { parse_mode: 'HTML' })
      .catch(() => {});
  });

  bot.callbackQuery(/^pub:baadd:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }

    const session = await getBatchSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: '⏱️ Batch kadaluarsa' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '➕ Kirim /batch lagi' });

    await ctx.reply(
      `➕ <b>Tambah Batch</b>\n\n` +
        `Session aktif:\n` +
        `<code>${sessionId}</code>\n\n` +
        `📊 Sekarang: <b>${session.min_ep}-${session.max_ep}</b>\n` +
        (session.slug_hint
          ? `🎬 <code>${escapeHtml(session.slug_hint)}</code>\n`
          : '') +
        `\nKirim <code>/batch &lt;url&gt; &lt;range&gt;</code> lagi.\n` +
        `Episode yang sudah ada akan otomatis di-skip.`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
  });

  bot.callbackQuery(/^pp:push:(pp_[a-z0-9]+)$/, async (ctx) => {
    try {
      const pendingId = ctx.match[1] ?? '';
      if (!pendingId) {
        await ctx.answerCallbackQuery({ text: '❌' });
        return;
      }

      const pending = await getPendingPublish(env.DB, pendingId);
      if (!pending) {
        await ctx.answerCallbackQuery({
          text: '⏱️ Kadaluarsa. Ulangi /publish.',
          show_alert: true,
        });
        return;
      }

      if (ctx.from?.id !== pending.user_id) {
        await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
        return;
      }

      await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

      let files: FileToCommit[] = [];
      try {
        files = JSON.parse(pending.files_json) as FileToCommit[];
      } catch {
        files = [];
      }

      if (files.length === 0) {
        await ctx.reply('❌ Tidak ada file.').catch(() => {});
        return;
      }

      const groups = new Map<RepoTarget, FileToCommit[]>();
      for (const f of files) {
        const target = f.target ?? 'qimochi';
        if (!groups.has(target)) groups.set(target, []);
        groups.get(target)!.push(f);
      }

      const metaFile = files.find(
        (f) => f.target === 'yukionime' && f.path.startsWith('src/content/anime/')
      );
      const slug =
        metaFile?.path.split('/').pop()?.replace(/\.md$/, '') ??
        (files[0]?.path.split('/').slice(-2, -1)[0] ?? 'unknown');

      const message = `feat: publish data for ${slug}`;

      const results: {
        target: RepoTarget;
        ok: boolean;
        sha?: string;
        commitUrl?: string;
        count: number;
        error?: string;
      }[] = [];

      for (const [target, groupFiles] of groups) {
        let r: {
          ok: boolean;
          sha?: string;
          commitUrl?: string;
          error?: string;
        };

        if (groupFiles.length === 1) {
          const f = groupFiles[0]!;
          r = await githubCommitFile(env, f.path, f.content, message, target);
        } else {
          r = await githubCommitMultipleFiles(
            env,
            groupFiles,
            message,
            target
          );
        }

        results.push({
          target,
          ok: r.ok,
          sha: r.sha,
          commitUrl: r.commitUrl,
          count: groupFiles.length,
          error: r.error,
        });
      }

      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;

      if (okCount === 0) {
        const errLines: string[] = ['❌ <b>Gagal push semua</b>', ''];
        for (const r of results) {
          errLines.push(
            `• <b>${r.target}</b>: <code>${escapeHtml((r.error ?? 'unknown').slice(0, 200))}</code>`
          );
        }
        await ctx
          .editMessageText(errLines.join('\n'), {
            parse_mode: 'HTML',
            reply_markup: undefined,
          })
          .catch(() => {});
        return;
      }

      if (failCount === 0) {
        await deletePendingPublish(env.DB, pendingId);
      }

      const lines: string[] = [];
      lines.push(
        failCount === 0
          ? `✅ <b>Published!</b>`
          : `⚠️ <b>Publish sebagian</b> (${okCount}/${results.length})`
      );
      lines.push('');

      for (const r of results) {
        const status = r.ok ? '✅' : '❌';
        const short = r.sha?.slice(0, 7) ?? '?';
        lines.push(
          `${status} <b>${r.target}</b> — ${r.count} file` +
            (r.ok ? ` · <code>${short}</code>` : ` · <i>${escapeHtml((r.error ?? 'unknown').slice(0, 100))}</i>`)
        );
      }

      if (failCount === 0) {
        lines.push('');
        lines.push(`⏳ Deploy ~2 menit`);
      } else {
        lines.push('');
        lines.push(
          `<i>Yang sukses tidak di-rollback. Ulangi /publish untuk retry yang gagal.</i>`
        );
      }

      await ctx
        .editMessageText(lines.join('\n'), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: undefined,
        })
        .catch(() => {});
    } catch (err: any) {
      console.error('[Publish] push error:', err);
      await ctx
        .reply(
          `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^pp:cancel:(pp_[a-z0-9]+)$/, async (ctx) => {
    const pendingId = ctx.match[1] ?? '';
    if (pendingId) await deletePendingPublish(env.DB, pendingId);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageText('❌ <b>Dibatalkan.</b>', {
        parse_mode: 'HTML',
        reply_markup: undefined,
      })
      .catch(() => {});
  });
}
