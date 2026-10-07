// src/commands/publish.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import {
  githubCommitFile,
  githubGetFile,
  githubListDir,
} from '../lib/github';

const BATCH_TTL_MS = 24 * 60 * 60 * 1000;

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

async function getSession(
  db: D1Database,
  sessionId: string
): Promise<SessionRow | null> {
  try {
    const row = await db
      .prepare('SELECT * FROM temp_anime WHERE session_id = ?')
      .bind(sessionId)
      .first<SessionRow>();
    return row ?? null;
  } catch (err) {
    console.error('[Publish] getSession error:', err);
    return null;
  }
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

  const minEp = merged[0]!.number;
  const maxEp = merged[merged.length - 1]!.number;
  const totalUrls = merged.reduce(
    (sum, r) =>
      sum + r.streams.reduce((s, q) => s + q.servers.length, 0),
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
         SET combined_json = ?,
             min_ep = ?,
             max_ep = ?,
             total_urls = ?,
             errors = ?,
             updated_at = ?,
             expires_at = ?
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
  for (let j = 0; j <= a.length; j++) m[0]![j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      m[i]![j] = Math.min(
        m[i - 1]![j]! + 1,
        m[i]![j - 1]! + 1,
        m[i - 1]![j - 1]! + cost
      );
    }
  }
  return m[b.length]![a.length]!;
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
    const candidates = dirs.filter((d) => d.type === 'dir').map((d) => d.name);

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

  const siteUrl = `https://qimochi.pages.dev/anime/${slug}/`;
  const commitShort = result.sha?.slice(0, 7) ?? '?';

  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      loadingMsg.message_id,
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
  const rangeExpected = session.max_ep - session.min_ep + 1;
  const hasGap = episodeCount !== rangeExpected;

  let existing: Awaited<ReturnType<typeof githubGetFile>> = null;
  try {
    existing = await githubGetFile(env, path);
  } catch {
    /* ignore */
  }

  const lines: string[] = [];
  lines.push(`📋 <b>Preview Publish</b>`);
  lines.push('');
  lines.push(`📁 <code>${escapeHtml(path)}</code>`);
  lines.push(`📏 ${sizeKB} KB`);
  lines.push(
    `📊 ${episodeCount} episode (Ep ${session.min_ep}-${session.max_ep})`
  );
  if (hasGap) {
    lines.push(
      `⚠️ <i>Ada gap — hanya ${episodeCount} dari ${rangeExpected} episode.</i>`
    );
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
  const result = await githubCommitFile(
    env,
    path,
    session.combined_json,
    commitMsg
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
        (result.commitUrl
          ? `<a href="${result.commitUrl}">Lihat commit</a>\n`
          : '') +
        `🌐 <a href="${siteUrl}">${escapeHtml(siteUrl)}</a>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    )
    .catch(() => {});
}

export function setupPublishCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^pub:an:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) return await ctx.answerCallbackQuery({ text: '❌' });
    await doPublishAnime(ctx, env, sessionId, false);
  });

  bot.callbackQuery(/^pub:anforce:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) return await ctx.answerCallbackQuery({ text: '❌' });
    await doPublishAnime(ctx, env, sessionId, true);
  });

  bot.callbackQuery(/^pub:skip:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (sessionId) await deleteSession(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply('❌ <b>Dibatalkan.</b>', { parse_mode: 'HTML' }).catch(() => {});
  });

  bot.callbackQuery(/^pub:ba:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) return await ctx.answerCallbackQuery({ text: '❌' });
    await doPublishBatchInitial(ctx, env, sessionId);
  });

  bot.callbackQuery(/^pub:bp:(b_[a-z0-9]+):(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const pick = ctx.match[2] ?? '';
    if (!sessionId) return await ctx.answerCallbackQuery({ text: '❌' });
    await doPublishBatchPickSlug(ctx, env, sessionId, pick);
  });

  bot.callbackQuery(/^pub:bpush:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) return await ctx.answerCallbackQuery({ text: '❌' });
    await doPublishBatchPush(ctx, env, sessionId);
  });

  bot.callbackQuery(/^pub:bax:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (sessionId) await deleteBatchSession(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply('❌ <b>Batch dibatalkan.</b>', { parse_mode: 'HTML' }).catch(() => {});
  });

  bot.callbackQuery(/^pub:baadd:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) return await ctx.answerCallbackQuery({ text: '❌' });

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
}

export const publishAnimeCommand: CommandDefinition = {
  name: 'publish_anime',
  description: 'Push metadata anime ke repo web',
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
    await ctx.reply(
      `✅ <b>${count}</b> session batch dihapus.`,
      { parse_mode: 'HTML' }
    );
  },
};