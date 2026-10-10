// src/commands/cms.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import { escapeHtml } from '../lib/utils';
import { createLazyInit } from '../lib/lazy-init';
import { getCmsIndex, type CmsIndex } from '../lib/cms-cache';
import { githubGetFile } from '../lib/github';

const PER_PAGE = 8;
const SEARCH_LIMIT = 20;
const SESSION_TTL_MS = 15 * 60 * 1000;

type CmsStep = 'idle' | 'awaiting_search';

interface CmsSession {
  step: CmsStep;
  page?: number;
}

const ensureCmsSessionDb = createLazyInit('CmsSess', async (db) => {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS cms_sessions (
        user_id    INTEGER PRIMARY KEY,
        step       TEXT NOT NULL,
        page       INTEGER,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`
    )
    .run();
});

async function setSession(
  db: D1Database,
  userId: number,
  step: CmsStep,
  page?: number
): Promise<void> {
  await ensureCmsSessionDb(db);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO cms_sessions (user_id, step, page, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         step = excluded.step,
         page = excluded.page,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`
    )
    .bind(userId, step, page ?? null, now, now + SESSION_TTL_MS)
    .run();
}

async function getSession(
  db: D1Database,
  userId: number
): Promise<CmsSession | null> {
  await ensureCmsSessionDb(db);
  const row = await db
    .prepare(
      'SELECT step, page, expires_at FROM cms_sessions WHERE user_id = ?'
    )
    .bind(userId)
    .first<{ step: CmsStep; page: number | null; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  return { step: row.step, page: row.page ?? undefined };
}

async function clearSession(db: D1Database, userId: number): Promise<void> {
  await ensureCmsSessionDb(db);
  await db
    .prepare('DELETE FROM cms_sessions WHERE user_id = ?')
    .bind(userId)
    .run();
}

/* ============================================================
   MAIN MENU
   ============================================================ */

async function showMainMenu(
  ctx: Context,
  env: Env,
  edit = false
): Promise<void> {
  const loading = edit ? null : await ctx.reply('🔍 Loading index...');

  let index: CmsIndex;
  let fromCache: boolean;
  try {
    const r = await getCmsIndex(env);
    index = r.index;
    fromCache = r.fromCache;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    const text = `❌ Gagal load index:\n<code>${escapeHtml(msg.slice(0, 300))}</code>`;
    if (loading) {
      await ctx.api
        .editMessageText(ctx.chat!.id, loading.message_id, text, {
          parse_mode: 'HTML',
        })
        .catch(() => {});
    } else {
      await ctx.reply(text, { parse_mode: 'HTML' });
    }
    return;
  }

  if (loading) {
    await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
  }

  const ageStr = fromCache
    ? `🕐 Cache: ${Math.round((Date.now() - index.syncedAt) / 60000)} menit lalu`
    : '🆕 Fresh (baru sync)';

  const lines = [
    '🗄️ <b>Yukio Database</b>',
    '',
    `📚 Anime: <b>${index.animeSlugs.length}</b>`,
    `🎤 Actor files: <b>${index.actorLetters.length}</b>`,
    ageStr,
    '',
    '<i>Pilih menu:</i>',
  ];

  const kb = new InlineKeyboard()
    .text('📚 Anime', 'cms:anime')
    .text('📊 Stats', 'cms:stats')
    .row()
    .text('🔄 Sync', 'cms:sync');

  const payload = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  };

  if (edit && ctx.callbackQuery?.message?.message_id) {
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery.message.message_id,
        lines.join('\n'),
        payload
      )
      .catch(() => {});
  } else {
    await ctx.reply(lines.join('\n'), payload);
  }
}

/* ============================================================
   ANIME MENU
   ============================================================ */

async function showAnimeMenu(ctx: Context, env: Env): Promise<void> {
  const { index } = await getCmsIndex(env);

  const lines = [
    '📚 <b>Anime</b>',
    '',
    `Total: <b>${index.animeSlugs.length}</b>`,
    '',
    '<i>Pilih aksi:</i>',
  ];

  const kb = new InlineKeyboard()
    .text('📋 Browse', 'cms:browse:0')
    .text('🔍 Search', 'cms:search')
    .row()
    .text('◀️ Kembali', 'cms:home');

  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery!.message!.message_id!,
      lines.join('\n'),
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      }
    )
    .catch(() => {});
}

async function showBrowse(
  ctx: Context,
  env: Env,
  page: number
): Promise<void> {
  const { index } = await getCmsIndex(env);
  const all = index.animeSlugs;
  const totalPages = Math.max(1, Math.ceil(all.length / PER_PAGE));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const items = all.slice(p * PER_PAGE, (p + 1) * PER_PAGE);

  const lines = [
    '📋 <b>Browse Anime</b>',
    `<i>Halaman ${p + 1}/${totalPages} · ${all.length} total</i>`,
    '',
    '<i>Tap untuk lihat detail:</i>',
  ];

  const kb = new InlineKeyboard();
  for (const slug of items) {
    const f = index.animeFolders[slug];
    const badges: string[] = [];
    if (f?.characters) badges.push('👥');
    if (f?.episodes || f?.episodeStreams) badges.push('🎬');
    if (f?.franchises) badges.push('🔗');

    const label = `${slug}${badges.length ? '  ' + badges.join('') : ''}`;
    const short = label.length > 50 ? label.slice(0, 48) + '…' : label;
    kb.text(short, `cms:view:${slug}`).row();
  }

  if (totalPages > 1) {
    if (p > 0) kb.text('◀️', `cms:browse:${p - 1}`);
    if (p < totalPages - 1) kb.text('▶️', `cms:browse:${p + 1}`);
    kb.row();
  }
  kb.text('◀️ Kembali', 'cms:anime');

  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery!.message!.message_id!,
      lines.join('\n'),
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      }
    )
    .catch(() => {});
}

/* ============================================================
   SEARCH
   ============================================================ */

async function showSearchPrompt(
  ctx: Context,
  env: Env,
  userId: number
): Promise<void> {
  await setSession(env.DB, userId, 'awaiting_search');
  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery!.message!.message_id!,
      '🔍 <b>Search Anime</b>\n\n' +
        'Kirim kata kunci (bisa sebagian slug).\n' +
        '<i>Contoh: <code>jujutsu</code></i>',
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().text('❌ Batal', 'cms:anime'),
      }
    )
    .catch(() => {});
}

async function handleSearchResult(
  ctx: Context,
  env: Env,
  userId: number,
  query: string
): Promise<void> {
  await clearSession(env.DB, userId);
  const { index } = await getCmsIndex(env);
  const q = query.toLowerCase().trim();

  const matches = index.animeSlugs
    .filter((s) => s.toLowerCase().includes(q))
    .slice(0, SEARCH_LIMIT);

  if (matches.length === 0) {
    await ctx.reply(
      `❌ Tidak ada anime yang cocok dengan "<b>${escapeHtml(query)}</b>".`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text('🔍 Search lagi', 'cms:search')
          .row()
          .text('◀️ Kembali', 'cms:anime'),
      }
    );
    return;
  }

  const lines = [
    `🔍 <b>Hasil search: "${escapeHtml(query)}"</b>`,
    `Ditemukan: <b>${matches.length}</b>${matches.length === SEARCH_LIMIT ? '+' : ''}`,
    '',
  ];

  const kb = new InlineKeyboard();
  for (const slug of matches) {
    const short = slug.length > 50 ? slug.slice(0, 48) + '…' : slug;
    kb.text(short, `cms:view:${slug}`).row();
  }
  kb.text('🔍 Search lagi', 'cms:search').row();
  kb.text('◀️ Kembali', 'cms:anime');

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

/* ============================================================
   DETAIL
   ============================================================ */

async function showDetail(
  ctx: Context,
  env: Env,
  slug: string
): Promise<void> {
  const file = await githubGetFile(
    env,
    `src/content/anime/${slug}.md`,
    'yukio-data'
  );

  if (!file) {
    await ctx
      .answerCallbackQuery({ text: '❌ File tidak ditemukan', show_alert: true })
      .catch(() => {});
    return;
  }

  const fmMatch = file.content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fmText = fmMatch?.[1] ?? '';
  const get = (key: string): string | null => {
    const m = fmText.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m?.[1]?.replace(/^["']|["']$/g, '').trim() ?? null;
  };

  const title = get('title') ?? slug;
  const type = get('type') ?? '-';
  const status = get('status') ?? '-';
  const year = get('year') ?? '-';
  const episodes = get('episodes') ?? '-';
  const duration = get('duration') ?? '-';
  const malId = get('malId') ?? '-';

  const { index } = await getCmsIndex(env);
  const folder = index.animeFolders[slug];
  const hasChars = folder?.characters ?? false;
  const hasEps = folder?.episodes || folder?.episodeStreams;
  const hasFr = folder?.franchises ?? false;

  const lines = [
    `📄 <code>${escapeHtml(slug)}</code>`,
    '',
    `<b>${escapeHtml(title)}</b>`,
    `🎬 ${type} · ${status}`,
    `📅 ${year} · 📼 ${episodes} ep · ⏱️ ${duration} min`,
    `🆔 MAL: ${malId}`,
    '',
    `<i>Data folder:</i>`,
    `  ${hasChars ? '✅' : '⬜'} Characters`,
    `  ${hasEps ? '✅' : '⬜'} Episodes`,
    `  ${hasFr ? '✅' : '⬜'} Franchises`,
  ];

  const kb = new InlineKeyboard()
    .text('✏️ Edit', `cms:edit:${slug}`)
    .text('🗑️ Hapus', `cms:del:${slug}`)
    .row()
    .text('👥 Characters', `cms:sec:${slug}:chars`)
    .text('🎬 Episodes', `cms:sec:${slug}:eps`)
    .row()
    .text('🔗 Franchises', `cms:sec:${slug}:fr`)
    .text('◀️ Kembali', 'cms:browse:0');

  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery!.message!.message_id!,
      lines.join('\n'),
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      }
    )
    .catch(() => {});
}

/* ============================================================
   STATS
   ============================================================ */

async function showStats(ctx: Context, env: Env): Promise<void> {
  const { index } = await getCmsIndex(env);

  let withChars = 0;
  let withEps = 0;
  let withFr = 0;

  for (const slug of index.animeSlugs) {
    const f = index.animeFolders[slug];
    if (f?.characters) withChars++;
    if (f?.episodes || f?.episodeStreams) withEps++;
    if (f?.franchises) withFr++;
  }

  const total = index.animeSlugs.length;
  const lines = [
    '📊 <b>Repo Stats</b>',
    '',
    `📄 Anime MD: <b>${total}</b>`,
    `🎤 Actor files: <b>${index.actorLetters.length}</b>`,
    '',
    '<b>Kelengkapan data:</b>',
    `  👥 Characters: <b>${withChars}</b> (${((withChars / total) * 100).toFixed(1)}%)`,
    `  🎬 Episodes: <b>${withEps}</b> (${((withEps / total) * 100).toFixed(1)}%)`,
    `  🔗 Franchises: <b>${withFr}</b> (${((withFr / total) * 100).toFixed(1)}%)`,
    '',
    '<b>⚠️ Belum lengkap:</b>',
    `  Tanpa characters: <b>${total - withChars}</b>`,
    `  Tanpa episodes: <b>${total - withEps}</b>`,
    `  Tanpa franchises: <b>${total - withFr}</b>`,
  ];

  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery!.message!.message_id!,
      lines.join('\n'),
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().text('◀️ Kembali', 'cms:home'),
      }
    )
    .catch(() => {});
}

/* ============================================================
   SYNC
   ============================================================ */

async function doSync(ctx: Context, env: Env): Promise<void> {
  await ctx.answerCallbackQuery({ text: '🔄 Syncing...' });

  try {
    const { index } = await getCmsIndex(env, true);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery!.message!.message_id!,
        `✅ <b>Sync selesai</b>\n\n` +
          `📚 Anime: <b>${index.animeSlugs.length}</b>\n` +
          `🎤 Actor files: <b>${index.actorLetters.length}</b>`,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard().text('◀️ Kembali', 'cms:home'),
        }
      )
      .catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery!.message!.message_id!,
        `❌ <b>Sync gagal</b>\n\n<code>${escapeHtml(msg.slice(0, 300))}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('◀️ Kembali', 'cms:home'),
        }
      )
      .catch(() => {});
  }
}

/* ============================================================
   COMMAND
   ============================================================ */

export const databaseCommand: CommandDefinition = {
  name: 'database',
  description: 'CMS untuk yukio-data — browse, search, edit, delete',
  usage: '/database',
  adminOnly: true,

  handler: async (ctx, env) => {
    await showMainMenu(ctx, env);
  },
};

/* ============================================================
   TEXT HANDLER
   ============================================================ */

export async function handleCmsText(
  ctx: Context,
  env: Env
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;

  const text = ctx.message?.text?.trim() ?? '';
  if (!text || text.startsWith('/')) return false;

  const session = await getSession(env.DB, userId);
  if (!session) return false;

  if (session.step === 'awaiting_search') {
    await handleSearchResult(ctx, env, userId, text);
    return true;
  }

  return false;
}

/* ============================================================
   CALLBACKS
   ============================================================ */

export function setupCmsCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^cms:home$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showMainMenu(ctx, env, true);
  });

  bot.callbackQuery(/^cms:anime$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showAnimeMenu(ctx, env);
  });

  bot.callbackQuery(/^cms:browse:(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1] ?? '0', 10);
    await ctx.answerCallbackQuery().catch(() => {});
    await showBrowse(ctx, env, page);
  });

  bot.callbackQuery(/^cms:search$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    await ctx.answerCallbackQuery().catch(() => {});
    await showSearchPrompt(ctx, env, userId);
  });

  bot.callbackQuery(/^cms:view:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await ctx.answerCallbackQuery().catch(() => {});
    await showDetail(ctx, env, slug);
  });

  bot.callbackQuery(/^cms:stats$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showStats(ctx, env);
  });

  bot.callbackQuery(/^cms:sync$/, async (ctx) => {
    await doSync(ctx, env);
  });

  // === Tahap 2 & 3 — belum diimplement, tapi tombolnya sudah ada ===
  bot.callbackQuery(/^cms:edit:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({
      text: '✏️ Edit — coming next (Tahap 2)',
      show_alert: true,
    });
  });

  bot.callbackQuery(/^cms:del:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({
      text: '🗑️ Delete — coming next (Tahap 3)',
      show_alert: true,
    });
  });

  bot.callbackQuery(/^cms:sec:(.+):(chars|eps|fr)$/, async (ctx) => {
    await ctx.answerCallbackQuery({
      text: '🚧 Detail section — coming next',
      show_alert: true,
    });
  });
}
