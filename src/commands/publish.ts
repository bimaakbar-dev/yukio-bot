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

/* ============================================================
   ANIME SESSION (temp_anime — shared dengan anime.ts)
   ============================================================ */

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

/* ============================================================
   BATCH SESSION (pending_batches)
   ============================================================ */

let batchDbReady = false;
let batchDbInitPromise: Promise<void> | null = null;

async function ensureBatchDb(db: D1Database): Promise<void> {
  if (batchDbReady) return;
  if (batchDbInitPromise) return batchDbInitPromise;

  batchDbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS pending_batches (
            session_id    TEXT PRIMARY KEY,
            user_id       INTEGER NOT NULL,
            slug_hint     TEXT,
            chosen_slug   TEXT,
            suggestions   TEXT,
            start_ep      INTEGER NOT NULL,
            end_ep        INTEGER NOT NULL,
            json_data     TEXT NOT NULL,
            total_urls    INTEGER,
            errors        TEXT,
            created_at    INTEGER NOT NULL,
            expires_at    INTEGER NOT NULL
          )`
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

interface PendingBatchRow {
  session_id: string;
  user_id: number;
  slug_hint: string | null;
  chosen_slug: string | null;
  suggestions: string | null;
  start_ep: number;
  end_ep: number;
  json_data: string;
  total_urls: number | null;
  errors: string | null;
  created_at: number;
  expires_at: number;
}

export async function saveBatchSession(
  db: D1Database,
  userId: number,
  data: {
    slugHint: string | null;
    startEp: number;
    endEp: number;
    jsonData: string;
    totalUrls: number;
    errors: string[];
  }
): Promise<string> {
  await ensureBatchDb(db);

  const sessionId = 'b_' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO pending_batches
        (session_id, user_id, slug_hint, chosen_slug, suggestions, start_ep, end_ep, json_data, total_urls, errors, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      userId,
      data.slugHint,
      null,
      null,
      data.startEp,
      data.endEp,
      data.jsonData,
      data.totalUrls,
      JSON.stringify(data.errors),
      now,
      now + BATCH_TTL_MS
    )
    .run();

  return sessionId;
}

async function getBatchSession(
  db: D1Database,
  sessionId: string
): Promise<PendingBatchRow | null> {
  await ensureBatchDb(db);
  const row = await db
    .prepare('SELECT * FROM pending_batches WHERE session_id = ?')
    .bind(sessionId)
    .first<PendingBatchRow>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM pending_batches WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }

  return row;
}

async function updateBatchChosenSlug(
  db: D1Database,
  sessionId: string,
  slug: string
): Promise<void> {
  await ensureBatchDb(db);
  await db
    .prepare('UPDATE pending_batches SET chosen_slug = ? WHERE session_id = ?')
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
    .prepare('UPDATE pending_batches SET suggestions = ? WHERE session_id = ?')
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
      .prepare('DELETE FROM pending_batches WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[Publish] deleteBatchSession error:', err);
  }
}

/* ============================================================
   LEVENSHTEIN (untuk auto-suggest slug)
   ============================================================ */

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

/* ============================================================
   ANIME — PUSH FLOW
   ============================================================ */

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
          `<b>Preview lama (300 char):</b>\n` +
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

/* ============================================================
   BATCH — PUSH FLOW
   ============================================================ */

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
  lines.push(`📦 <b>Batch ${session.start_ep}-${session.end_ep}</b>`);
  lines.push(`📊 Episode: <b>${session.end_ep - session.start_ep + 1}</b>`);
  if (session.total_urls) lines.push(`🎬 URL: <b>${session.total_urls}</b>`);
  lines.push('');

  const kb = new InlineKeyboard();

  if (suggestions.length > 0) {
    lines.push('🔍 <b>Slug mirip di repo:</b>');
    suggestions.forEach((s, i) => {
      const pct = Math.round(s.score * 100);
      lines.push(`${i + 1}. <code>${escapeHtml(s.slug)}</code> (${pct}%)`);
      const label = s.slug.length > 28 ? s.slug.slice(0, 26) + '…' : s.slug;
      kb.text(`📁 ${label} (${pct}%)`, `pub:bp:${sessionId}:${i}`).row();
    });
    lines.push('');
    lines.push(
      `Slug dari URL: <code>${escapeHtml(slugHint || '(kosong)')}</code>`
    );
  } else {
    lines.push('⚠️ Tidak ada slug mirip di repo.');
    if (slugHint) {
      lines.push(
        `Akan buat folder baru: <code>${escapeHtml(slugHint)}</code>`
      );
    } else {
      lines.push('Tidak bisa auto-detect slug dari URL.');
      lines.push(
        `Pakai: <code>/publish_batch ${sessionId} &lt;slug&gt;</code>`
      );
    }
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
      arr = session.suggestions ? (JSON.parse(session.suggestions) as string[]) : [];
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

  const path = `src/data/anime/${slug}/episodes/${session.start_ep}-${session.end_ep}.json`;
  const sizeKB = Math.round(session.json_data.length / 1024);

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
  lines.push(`📊 Episode: ${session.end_ep - session.start_ep + 1}`);
  if (session.total_urls) lines.push(`🎬 URL: ${session.total_urls}`);
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
  const path = `src/data/anime/${slug}/episodes/${session.start_ep}-${session.end_ep}.json`;

  await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

  const loading = await ctx.reply(
    `📤 <b>Push ke GitHub...</b>\n\n📁 <code>${escapeHtml(path)}</code>`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );

  const commitMsg = `feat: add episodes ${session.start_ep}-${session.end_ep} for ${slug}`;
  const result = await githubCommitFile(env, path, session.json_data, commitMsg);

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

/* ============================================================
   CALLBACK REGISTRATION
   ============================================================ */

export function setupPublishCallbacks(bot: Bot, env: Env): void {
  // === Anime ===
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

  // === Batch ===
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
}

/* ============================================================
   COMMAND: /publish_anime
   ============================================================ */

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

/* ============================================================
   COMMAND: /publish_batch
   ============================================================ */

export const publishBatchCommand: CommandDefinition = {
  name: 'publish_batch',
  description: 'Push batch episode ke repo web',
  usage: '/publish_batch [session_id] [slug]',
  adminOnly: true,

  handler: async (ctx, env) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const parts = arg.split(/\s+/).filter(Boolean);

    // Kalau ada 2 arg: session_id + slug → langsung preview
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