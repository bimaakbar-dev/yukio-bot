// src/commands/cms.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import { escapeHtml } from '../lib/utils';
import { createLazyInit } from '../lib/lazy-init';
import {
  githubGetFile,
  githubCommitFile,
  githubDeleteFile,
  githubListDir,
} from '../lib/github';
import {
  getCmsIndex,
  invalidateCmsIndex,
  type CmsIndex,
} from '../lib/cms-cache';
import {
  splitContent,
  getFrontmatterField,
  applyEdits,
} from './edit/content';

const SESSION_TTL_MS = 15 * 60 * 1000;

type CmsStep =
  | 'idle'
  | 'awaiting_slug'
  | 'edit_menu'
  | 'awaiting_value'
  | 'awaiting_body';

interface CmsSession {
  step: CmsStep;
  slug?: string;
  activeField?: string;
  edits: Record<string, string>;
}

/* ============================================================
   SESSION DB
   ============================================================ */

const ensureCmsSessionDb = createLazyInit('CmsSess', async (db) => {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS cms_sessions (
        user_id      INTEGER PRIMARY KEY,
        step         TEXT NOT NULL,
        slug         TEXT,
        active_field TEXT,
        edits_json   TEXT NOT NULL DEFAULT '{}',
        updated_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL
      )`
    )
    .run();

  for (const col of ['slug', 'active_field', 'edits_json']) {
    try {
      await db.prepare(`ALTER TABLE cms_sessions ADD COLUMN ${col} TEXT`).run();
    } catch {}
  }
});

async function setSession(
  db: D1Database,
  userId: number,
  data: {
    step: CmsStep;
    slug?: string;
    activeField?: string;
    edits?: Record<string, string>;
  }
): Promise<void> {
  await ensureCmsSessionDb(db);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO cms_sessions
         (user_id, step, slug, active_field, edits_json, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         step = excluded.step,
         slug = excluded.slug,
         active_field = excluded.active_field,
         edits_json = excluded.edits_json,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`
    )
    .bind(
      userId,
      data.step,
      data.slug ?? null,
      data.activeField ?? null,
      JSON.stringify(data.edits ?? {}),
      now,
      now + SESSION_TTL_MS
    )
    .run();
}

async function getSession(
  db: D1Database,
  userId: number
): Promise<CmsSession | null> {
  await ensureCmsSessionDb(db);
  const row = await db
    .prepare(
      `SELECT step, slug, active_field, edits_json, expires_at
       FROM cms_sessions WHERE user_id = ?`
    )
    .bind(userId)
    .first<{
      step: CmsStep;
      slug: string | null;
      active_field: string | null;
      edits_json: string;
      expires_at: number;
    }>();

  if (!row) return null;
  if (row.expires_at < Date.now()) return null;

  let edits: Record<string, string> = {};
  try {
    edits = JSON.parse(row.edits_json);
  } catch {}

  return {
    step: row.step,
    slug: row.slug ?? undefined,
    activeField: row.active_field ?? undefined,
    edits,
  };
}

async function clearSession(db: D1Database, userId: number): Promise<void> {
  await ensureCmsSessionDb(db);
  await db
    .prepare('DELETE FROM cms_sessions WHERE user_id = ?')
    .bind(userId)
    .run();
}

/* ============================================================
   FIELD DEFINITIONS
   ============================================================ */

type FieldType = 'text' | 'number' | 'choice' | 'csv' | 'url' | 'body';

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  choices?: string[];
  hint?: string;
}

const EDIT_FIELDS: FieldDef[] = [
  { key: 'title', label: '📄 Title', type: 'text' },
  { key: 'titleEnglish', label: '📄 Title EN', type: 'text' },
  { key: 'titleNative', label: '📄 Title JP', type: 'text' },
  {
    key: 'type',
    label: '🎬 Type',
    type: 'choice',
    choices: ['TV', 'Movie', 'OVA', 'ONA', 'Special', 'Music', 'Unknown'],
  },
  {
    key: 'status',
    label: '📊 Status',
    type: 'choice',
    choices: ['airing', 'finished', 'upcoming', 'hiatus', 'cancelled'],
  },
  { key: 'source', label: '📖 Source', type: 'text' },
  {
    key: 'season',
    label: '🌤️ Season',
    type: 'choice',
    choices: ['winter', 'spring', 'summer', 'fall'],
  },
  { key: 'year', label: '📅 Year', type: 'number', hint: '1900-2100' },
  { key: 'episodes', label: '📼 Episodes', type: 'number' },
  { key: 'duration', label: '⏱️ Duration', type: 'number', hint: 'menit' },
  { key: 'rating', label: '🔞 Age Rating', type: 'text', hint: 'PG-13, R, dst' },
  { key: 'stats.score', label: '⭐ Score', type: 'number', hint: '0.0 - 10.0' },
  { key: 'malId', label: '🆔 MAL ID', type: 'number' },
  { key: 'genres', label: '🏷️ Genres', type: 'csv', hint: 'action, comedy' },
  { key: 'studios', label: '🏢 Studios', type: 'csv', hint: 'mappa, bones' },
  { key: 'image', label: '🖼️ Image', type: 'url' },
  { key: 'banner', label: '🖼️ Banner', type: 'url' },
  { key: 'trailer', label: '🎬 Trailer', type: 'text' },
  { key: 'body', label: '📝 Sinopsis', type: 'body' },
];

function findField(key: string): FieldDef | null {
  return EDIT_FIELDS.find((f) => f.key === key) ?? null;
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
    '<i>Shortcut: <code>/database {slug}</code> langsung ke detail</i>',
  ];

  const kb = new InlineKeyboard()
    .text('🔍 Cari Slug', 'cms:search')
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
   SEARCH BY SLUG
   ============================================================ */

async function showSlugPrompt(
  ctx: Context,
  env: Env,
  userId: number
): Promise<void> {
  await setSession(env.DB, userId, { step: 'awaiting_slug' });
  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery!.message!.message_id!,
      '🔍 <b>Cari Anime</b>\n\n' +
        'Kirim <b>slug</b> anime.\n' +
        '<i>Contoh: <code>jujutsu-kaisen</code></i>',
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().text('❌ Batal', 'cms:home'),
      }
    )
    .catch(() => {});
}

async function handleSlugInput(
  ctx: Context,
  env: Env,
  userId: number,
  rawSlug: string
): Promise<void> {
  const slug = rawSlug.toLowerCase().trim();

  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    await ctx.reply(
      '❌ Slug invalid. Format: <code>lowercase-with-dash</code>\n\nCoba lagi:',
      { parse_mode: 'HTML' }
    );
    return;
  }

  await clearSession(env.DB, userId);

  const loading = await ctx.reply(
    `🔍 Cek <code>${escapeHtml(slug)}</code>...`,
    { parse_mode: 'HTML' }
  );

  const file = await githubGetFile(
    env,
    `src/content/anime/${slug}.md`,
    'yukio-data'
  );

  await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});

  if (!file) {
    await ctx.reply(
      `❌ <b>Slug tidak ditemukan</b>\n\n` +
        `<code>${escapeHtml(slug)}</code> belum ada di yukio-data.\n\n` +
        `<i>Mau tambah baru?</i>`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text('➕ Tambah Baru', `cms:add:${slug}`)
          .text('🔍 Coba Lagi', 'cms:search')
          .row()
          .text('◀️ Kembali', 'cms:home'),
      }
    );
    return;
  }

  await showDetailFromContent(ctx, env, slug, file.content, false);
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

  await showDetailFromContent(ctx, env, slug, file.content, true);
}

async function showDetailFromContent(
  ctx: Context,
  env: Env,
  slug: string,
  content: string,
  edit: boolean
): Promise<void> {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
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
  const hasEps = folder?.episodes ?? false;
  const hasStreams = folder?.episodeStreams ?? false;
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
    `  ${hasEps ? '✅' : '⬜'} Episodes (metadata)`,
    `  ${hasStreams ? '✅' : '⬜'} Episodes (streams)`,
    `  ${hasFr ? '✅' : '⬜'} Franchises`,
  ];

  const kb = new InlineKeyboard()
    .text('✏️ Edit', `cms:edit:${slug}`)
    .text('🗑️ Hapus', `cms:del:${slug}`)
    .row()
    .text('👥 Characters', `cms:sec:${slug}:chars`)
    .text('🎬 Episodes', `cms:ep:${slug}`)
    .row()
    .text('🔗 Franchises', `cms:sec:${slug}:fr`)
    .row()
    .text('🔍 Cari Lagi', 'cms:search')
    .text('◀️ Menu', 'cms:home');

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
   EPISODES MENU
   ============================================================ */

async function listJsonFiles(env: Env, path: string): Promise<string[]> {
  try {
    const dir = await githubListDir(env, path, 'yukio-data');
    return dir
      .filter((d) => d.type === 'file' && d.name.endsWith('.json'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

async function showEpisodesMenu(
  ctx: Context,
  env: Env,
  slug: string
): Promise<void> {
  const [metaFiles, streamFiles] = await Promise.all([
    listJsonFiles(env, `data/anime/${slug}/episodes`),
    listJsonFiles(env, `data/anime/${slug}/episodes/streams`),
  ]);

  const lines = [
    `🎬 <b>Episodes — ${escapeHtml(slug)}</b>`,
    '',
    `📄 <b>Metadata</b> (${metaFiles.length}):`,
  ];

  if (metaFiles.length === 0) lines.push('  <i>(kosong)</i>');
  else for (const f of metaFiles) lines.push(`  • <code>${escapeHtml(f)}</code>`);

  lines.push('');
  lines.push(`📺 <b>Streams</b> (${streamFiles.length}):`);

  if (streamFiles.length === 0) lines.push('  <i>(kosong)</i>');
  else
    for (const f of streamFiles)
      lines.push(`  • <code>${escapeHtml(f)}</code>`);

  lines.push('');
  lines.push('<i>Tap file untuk preview / hapus:</i>');

  const kb = new InlineKeyboard();
  for (const f of metaFiles) kb.text(`📄 ${f}`, `cms:epv:${slug}:meta:${f}`).row();
  for (const f of streamFiles)
    kb.text(`📺 ${f}`, `cms:epv:${slug}:streams:${f}`).row();

  if (streamFiles.length === 0) kb.text('➕ Batch Baru', `cms:epb:${slug}`).row();

  kb.text('🔍 Refresh', `cms:ep:${slug}`)
    .text('◀️ Detail', `cms:view:${slug}`);

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

async function showChunkPreview(
  ctx: Context,
  env: Env,
  slug: string,
  type: 'meta' | 'streams',
  fileName: string
): Promise<void> {
  const path =
    type === 'meta'
      ? `data/anime/${slug}/episodes/${fileName}`
      : `data/anime/${slug}/episodes/streams/${fileName}`;

  const file = await githubGetFile(env, path, 'yukio-data');
  if (!file) {
    await ctx
      .answerCallbackQuery({ text: '❌ File hilang', show_alert: true })
      .catch(() => {});
    return;
  }

  let preview = file.content;
  if (preview.length > 3000) preview = preview.slice(0, 3000) + '\n\n… [truncated]';

  const sizeKb = Math.round(file.content.length / 1024);
  const typeLabel = type === 'meta' ? '📄 Metadata' : '📺 Streams';

  const lines = [
    `${typeLabel} — <code>${escapeHtml(fileName)}</code>`,
    '',
    `📏 ${sizeKb} KB`,
    '',
    `<pre>${escapeHtml(preview)}</pre>`,
  ];

  const kb = new InlineKeyboard()
    .text('🗑️ Hapus', `cms:epd:${slug}:${type}:${fileName}`)
    .row()
    .text('◀️ Kembali', `cms:ep:${slug}`);

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

async function confirmDeleteChunk(
  ctx: Context,
  env: Env,
  slug: string,
  type: 'meta' | 'streams',
  fileName: string
): Promise<void> {
  void env;
  const path =
    type === 'meta'
      ? `data/anime/${slug}/episodes/${fileName}`
      : `data/anime/${slug}/episodes/streams/${fileName}`;

  const lines = [
    '⚠️ <b>Konfirmasi Hapus</b>',
    '',
    `🆔 <code>${escapeHtml(slug)}</code>`,
    `📁 <code>${escapeHtml(path)}</code>`,
    '',
    '<i>Tidak bisa dibatalkan.</i>',
  ];

  const kb = new InlineKeyboard()
    .text('✅ Hapus', `cms:epdy:${slug}:${type}:${fileName}`)
    .text('❌ Batal', `cms:epv:${slug}:${type}:${fileName}`);

  await ctx.answerCallbackQuery({ text: '⚠️' });
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

async function execDeleteChunk(
  ctx: Context,
  env: Env,
  slug: string,
  type: 'meta' | 'streams',
  fileName: string
): Promise<void> {
  const path =
    type === 'meta'
      ? `data/anime/${slug}/episodes/${fileName}`
      : `data/anime/${slug}/episodes/streams/${fileName}`;

  await ctx.answerCallbackQuery({ text: '🗑️ Deleting...' });

  const loadingMsgId = ctx.callbackQuery!.message!.message_id!;
  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      loadingMsgId,
      `🗑️ Menghapus <code>${escapeHtml(path)}</code>...`,
      { parse_mode: 'HTML' }
    )
    .catch(() => {});

  const result = await githubDeleteFile(
    env,
    path,
    `chore(cms): delete ${fileName} from ${slug}`,
    'yukio-data'
  );

  if (!result.ok) {
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loadingMsgId,
        `❌ <b>Gagal hapus</b>\n\n<code>${escapeHtml(result.error ?? 'unknown')}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('◀️ Kembali', `cms:ep:${slug}`),
        }
      )
      .catch(() => {});
    return;
  }

  await invalidateCmsIndex(env);

  const lines = [
    '✅ <b>File dihapus</b>',
    '',
    `📁 <code>${escapeHtml(path)}</code>`,
    `🔗 Commit: <code>${result.sha?.slice(0, 7) ?? '?'}</code>`,
  ];

  const kb = new InlineKeyboard()
    .text('🔙 Episodes', `cms:ep:${slug}`)
    .text('📄 Detail', `cms:view:${slug}`);

  await ctx.api
    .editMessageText(ctx.chat!.id, loadingMsgId, lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
    })
    .catch(() => {});
}

async function showBatchShortcut(
  ctx: Context,
  env: Env,
  slug: string
): Promise<void> {
  void env;
  const lines = [
    '🚀 <b>Batch Streams</b>',
    '',
    `Slug: <code>${escapeHtml(slug)}</code>`,
    '',
    '<b>Langkah:</b>',
    `1. Ketik <code>/batch</code>`,
    `2. Step 1, kirim: <code>${escapeHtml(slug)}</code>`,
    `3. Step 2, kirim URL source`,
    `4. Step 3, kirim range episode`,
    '',
    '<i>Setelah selesai, balik ke sini → 🔍 Refresh.</i>',
  ];

  const kb = new InlineKeyboard()
    .text('🔍 Refresh', `cms:ep:${slug}`)
    .text('◀️ Detail', `cms:view:${slug}`);

  await ctx.answerCallbackQuery({ text: '🚀' });
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
   HARD DELETE ANIME
   ============================================================ */

async function collectFolderFiles(
  env: Env,
  path: string,
  depth = 0
): Promise<string[]> {
  if (depth > 3) return [];
  const files: string[] = [];
  try {
    const items = await githubListDir(env, path, 'yukio-data');
    for (const item of items) {
      const child = `${path}/${item.name}`;
      if (item.type === 'file') {
        files.push(child);
      } else if (item.type === 'dir') {
        const sub = await collectFolderFiles(env, child, depth + 1);
        files.push(...sub);
      }
    }
  } catch {}
  return files;
}

async function showDeleteConfirm(
  ctx: Context,
  env: Env,
  slug: string
): Promise<void> {
  await ctx.answerCallbackQuery({ text: '🔍 Scan file...' });

  const mdPath = `src/content/anime/${slug}.md`;
  const md = await githubGetFile(env, mdPath, 'yukio-data').catch(() => null);
  const dataFiles = await collectFolderFiles(env, `data/anime/${slug}`, 0);

  const total = (md ? 1 : 0) + dataFiles.length;

  if (total === 0) {
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery!.message!.message_id!,
        `ℹ️ <b>Tidak ada file untuk dihapus</b>\n\n🆔 <code>${escapeHtml(slug)}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text(
            '◀️ Detail',
            `cms:view:${slug}`
          ),
        }
      )
      .catch(() => {});
    return;
  }

  const lines = [
    `⚠️ <b>Konfirmasi Hapus</b>`,
    '',
    `🆔 <code>${escapeHtml(slug)}</code>`,
    '',
    `<b>${total} file akan dihapus:</b>`,
  ];

  if (md) lines.push(`  📄 <code>${escapeHtml(mdPath)}</code>`);
  for (const f of dataFiles.slice(0, 10)) {
    lines.push(`  📁 <code>${escapeHtml(f)}</code>`);
  }
  if (dataFiles.length > 10) {
    lines.push(`  <i>… dan ${dataFiles.length - 10} file lain</i>`);
  }

  lines.push('');
  lines.push('<b>⚠️ Tidak bisa dibatalkan.</b>');

  const kb = new InlineKeyboard()
    .text(`✅ Hapus ${total} file`, `cms:dely:${slug}`)
    .row()
    .text('❌ Batal', `cms:view:${slug}`);

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

async function execDeleteAnime(
  ctx: Context,
  env: Env,
  slug: string
): Promise<void> {
  await ctx.answerCallbackQuery({ text: '🗑️ Deleting...' });

  const loadingMsgId = ctx.callbackQuery!.message!.message_id!;
  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      loadingMsgId,
      `🗑️ <b>Menghapus semua file...</b>\n\n🆔 <code>${escapeHtml(slug)}</code>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    )
    .catch(() => {});

  try {
    const mdPath = `src/content/anime/${slug}.md`;
    const md = await githubGetFile(env, mdPath, 'yukio-data').catch(() => null);
    const dataFiles = await collectFolderFiles(env, `data/anime/${slug}`, 0);
    const paths = [...(md ? [mdPath] : []), ...dataFiles];

    if (paths.length === 0) throw new Error('Tidak ada file');

    let deleted = 0;
    const errors: string[] = [];

    for (let i = 0; i < paths.length; i++) {
      const p = paths[i]!;
      try {
        await ctx.api
          .editMessageText(
            ctx.chat!.id,
            loadingMsgId,
            `🗑️ <b>[${i + 1}/${paths.length}]</b>\n\n<code>${escapeHtml(p)}</code>`,
            { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
          )
          .catch(() => {});

        const r = await githubDeleteFile(
          env,
          p,
          `chore(cms): delete ${slug} (${i + 1}/${paths.length})`,
          'yukio-data'
        );
        if (r.ok) deleted++;
        else errors.push(`${p}: ${r.error ?? 'unknown'}`);
      } catch (err) {
        errors.push(`${p}: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }

    await invalidateCmsIndex(env);

    const lines = [
      `✅ <b>Hapus selesai</b>`,
      '',
      `🆔 <code>${escapeHtml(slug)}</code>`,
      `🗑️ Dihapus: <b>${deleted}</b> / ${paths.length} file`,
    ];

    if (errors.length > 0) {
      lines.push('');
      lines.push(`⚠️ <b>Error (${errors.length}):</b>`);
      for (const e of errors.slice(0, 3)) {
        lines.push(`• <code>${escapeHtml(e.slice(0, 120))}</code>`);
      }
    }

    const kb = new InlineKeyboard()
      .text('🔍 Cari Lagi', 'cms:search')
      .text('🏠 Menu', 'cms:home');

    await ctx.api
      .editMessageText(ctx.chat!.id, loadingMsgId, lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      })
      .catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loadingMsgId,
        `❌ <b>Gagal hapus</b>\n\n<code>${escapeHtml(msg.slice(0, 300))}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text(
            '◀️ Detail',
            `cms:view:${slug}`
          ),
        }
      )
      .catch(() => {});
  }
}

/* ============================================================
   TAMBAH BARU
   ============================================================ */

async function showAddNewInstructions(
  ctx: Context,
  env: Env,
  slug: string
): Promise<void> {
  void env;

  const lines = [
    `➕ <b>Tambah Anime Baru</b>`,
    '',
    `🆔 Target slug: <code>${escapeHtml(slug)}</code>`,
    '',
    '<b>Alur:</b>',
    `1️⃣ Ketik <code>/dba ${escapeHtml(slug.replace(/-/g, ' '))}</code>`,
    `2️⃣ Cari metadata + klik section (Metadata, Characters, Episodes)`,
    `3️⃣ Ketik <code>/publish</code> → centang → 📤 Push`,
    '',
    `<i>Setelah selesai, balik ke sini → 🔍 Cari Slug untuk cek.</i>`,
  ];

  const kb = new InlineKeyboard()
    .text('🔍 Cari Slug', 'cms:search')
    .text('🏠 Menu', 'cms:home');

  await ctx.answerCallbackQuery({ text: '➕' });
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
  let withStreams = 0;
  let withFr = 0;

  for (const slug of index.animeSlugs) {
    const f = index.animeFolders[slug];
    if (f?.characters) withChars++;
    if (f?.episodes) withEps++;
    if (f?.episodeStreams) withStreams++;
    if (f?.franchises) withFr++;
  }

  const total = index.animeSlugs.length;
  const pct = (n: number) => ((n / total) * 100).toFixed(1);

  const lines = [
    '📊 <b>Repo Stats</b>',
    '',
    `📄 Anime MD: <b>${total}</b>`,
    `🎤 Actor files: <b>${index.actorLetters.length}</b>`,
    '',
    '<b>Kelengkapan data:</b>',
    `  👥 Characters: <b>${withChars}</b> (${pct(withChars)}%)`,
    `  📄 Episodes meta: <b>${withEps}</b> (${pct(withEps)}%)`,
    `  📺 Episodes streams: <b>${withStreams}</b> (${pct(withStreams)}%)`,
    `  🔗 Franchises: <b>${withFr}</b> (${pct(withFr)}%)`,
    '',
    '<b>⚠️ Belum lengkap:</b>',
    `  Tanpa characters: <b>${total - withChars}</b>`,
    `  Tanpa episodes meta: <b>${total - withEps}</b>`,
    `  Tanpa streams: <b>${total - withStreams}</b>`,
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
    await invalidateCmsIndex(env);
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
   EDIT — MENU
   ============================================================ */

async function showEditMenu(
  ctx: Context,
  env: Env,
  userId: number,
  slug: string,
  edits: Record<string, string>
): Promise<void> {
  await setSession(env.DB, userId, {
    step: 'edit_menu',
    slug,
    edits,
  });

  const count = Object.keys(edits).length;
  const lines = [
    `✏️ <b>Edit — ${escapeHtml(slug)}</b>`,
    '',
    count > 0
      ? `📝 <b>${count} perubahan pending:</b>`
      : '<i>Belum ada perubahan.</i>',
  ];

  if (count > 0) {
    for (const [k, v] of Object.entries(edits)) {
      const f = findField(k);
      const label = f?.label ?? k;
      const preview =
        k === 'body'
          ? `${v.slice(0, 40).replace(/\n/g, ' ')}…`
          : v.length > 40
            ? v.slice(0, 38) + '…'
            : v;
      lines.push(`• ${label} → <code>${escapeHtml(preview)}</code>`);
    }
  }

  lines.push('');
  lines.push('<i>Tap field untuk ubah:</i>');

  const kb = new InlineKeyboard();
  let i = 0;
  for (const f of EDIT_FIELDS) {
    const mark = edits[f.key] !== undefined ? '✅' : '⬜';
    kb.text(`${mark} ${f.label}`, `cms:ef:${f.key}`);
    i++;
    if (i % 2 === 0) kb.row();
  }
  if (i % 2 !== 0) kb.row();

  kb.text(`💾 Save (${count})`, 'cms:save');
  kb.text('❌ Batal', `cms:view:${slug}`);
  kb.row();
  kb.text('◀️ Detail', `cms:view:${slug}`);

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

async function showFieldPrompt(
  ctx: Context,
  env: Env,
  userId: number,
  slug: string,
  fieldKey: string,
  edits: Record<string, string>
): Promise<void> {
  const field = findField(fieldKey);
  if (!field) {
    await ctx.answerCallbackQuery({ text: '❌ Field tidak dikenal' });
    return;
  }

  const file = await githubGetFile(
    env,
    `src/content/anime/${slug}.md`,
    'yukio-data'
  );
  if (!file) {
    await ctx.answerCallbackQuery({ text: '❌ File hilang', show_alert: true });
    return;
  }

  const { frontmatter } = splitContent(file.content);
  const current = getFrontmatterField(frontmatter, fieldKey);

  const step: CmsStep =
    field.type === 'body' ? 'awaiting_body' : 'awaiting_value';
  await setSession(env.DB, userId, {
    step,
    slug,
    activeField: fieldKey,
    edits,
  });

  const lines = [
    `✏️ <b>${escapeHtml(field.label)}</b>`,
    '',
    current
      ? `📌 Sekarang: <code>${escapeHtml(current.slice(0, 100))}</code>`
      : '📌 Sekarang: <i>(kosong)</i>',
    '',
  ];

  const kb = new InlineKeyboard();

  if (field.type === 'choice' && field.choices) {
    lines.push('<i>Pilih nilai baru:</i>');
    field.choices.forEach((c, i) => {
      kb.text(c, `cms:ev:${i}`);
      if ((i + 1) % 3 === 0) kb.row();
    });
    if (field.choices.length % 3 !== 0) kb.row();
  } else {
    if (field.hint)
      lines.push(`<i>Kirim nilai baru. ${escapeHtml(field.hint)}</i>`);
    else if (field.type === 'url')
      lines.push('<i>Kirim URL baru (https://...)</i>');
    else if (field.type === 'body')
      lines.push('<i>Kirim sinopsis baru (bisa multi-baris)</i>');
    else if (field.type === 'csv')
      lines.push('<i>Pisah pakai koma. Contoh: <code>action, comedy</code></i>');
    else lines.push('<i>Kirim nilai baru:</i>');
  }

  kb.text('◀️ Balik', 'cms:edit:back');

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
   EDIT — SAVE
   ============================================================ */

async function saveEdits(
  ctx: Context,
  env: Env,
  userId: number,
  slug: string,
  edits: Record<string, string>
): Promise<void> {
  const count = Object.keys(edits).length;
  if (count === 0) {
    await ctx.answerCallbackQuery({ text: '❌ Belum ada perubahan' });
    return;
  }

  await ctx.answerCallbackQuery({ text: '📤 Saving...' });

  const loadingMsgId = ctx.callbackQuery!.message!.message_id!;
  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      loadingMsgId,
      `📤 <b>Menyimpan ${count} perubahan...</b>\n\n🆔 <code>${escapeHtml(slug)}</code>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    )
    .catch(() => {});

  try {
    const file = await githubGetFile(
      env,
      `src/content/anime/${slug}.md`,
      'yukio-data'
    );
    if (!file) throw new Error('File MD tidak ditemukan di repo');

    const newContent = applyEdits(file.content, edits);

    const result = await githubCommitFile(
      env,
      `src/content/anime/${slug}.md`,
      newContent,
      `chore(cms): update ${slug} (${count} field)`,
      'yukio-data'
    );

    if (!result.ok) throw new Error(result.error ?? 'push failed');

    await clearSession(env.DB, userId);
    await invalidateCmsIndex(env);

    const lines = [
      `✅ <b>Update berhasil</b>`,
      '',
      `🆔 <code>${escapeHtml(slug)}</code>`,
      `📦 ${count} field diubah`,
      `🔗 Commit: <code>${result.sha?.slice(0, 7) ?? '?'}</code>`,
      '',
      `<i>Deploy ~2 menit</i>`,
    ];

    const kb = new InlineKeyboard()
      .text('✏️ Edit Lagi', `cms:edit:${slug}`)
      .text('📄 Detail', `cms:view:${slug}`);

    await ctx.api
      .editMessageText(ctx.chat!.id, loadingMsgId, lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      })
      .catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loadingMsgId,
        `❌ <b>Gagal save</b>\n\n<code>${escapeHtml(msg.slice(0, 300))}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text(
            '◀️ Balik',
            `cms:edit:${slug}`
          ),
        }
      )
      .catch(() => {});
  }
}

/* ============================================================
   EDIT — VALIDATION
   ============================================================ */

function validateValue(
  field: FieldDef,
  raw: string
): { ok: true; value: string } | { ok: false; error: string } {
  const v = raw.trim();
  if (!v) return { ok: false, error: 'Nilai kosong tidak diizinkan' };

  if (field.type === 'number') {
    const n = Number(v);
    if (isNaN(n)) return { ok: false, error: 'Harus angka' };
    if (field.key === 'year' && (n < 1900 || n > 2100)) {
      return { ok: false, error: 'Year harus 1900-2100' };
    }
    if (field.key === 'stats.score' && (n < 0 || n > 10)) {
      return { ok: false, error: 'Score harus 0.0-10.0' };
    }
    return { ok: true, value: v };
  }

  if (field.type === 'url') {
    try {
      new URL(v);
      return { ok: true, value: v };
    } catch {
      return { ok: false, error: 'URL tidak valid' };
    }
  }

  return { ok: true, value: v };
}

/* ============================================================
   COMMAND
   ============================================================ */

export const databaseCommand: CommandDefinition = {
  name: 'database',
  description: 'CMS yukio-data — cek slug, edit, hapus',
  usage: '/database [slug]',
  adminOnly: true,

  handler: async (ctx, env) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const userId = ctx.from?.id;
    if (!userId) return;

    if (arg) {
      await handleSlugInput(ctx, env, userId, arg);
      return;
    }

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

  const text = ctx.message?.text ?? '';
  if (!text) return false;
  if (text.startsWith('/')) return false;

  const session = await getSession(env.DB, userId);
  if (!session) return false;

  if (session.step === 'awaiting_slug') {
    await handleSlugInput(ctx, env, userId, text);
    return true;
  }

  if (session.step === 'awaiting_value' || session.step === 'awaiting_body') {
    await handleFieldValue(ctx, env, userId, session, text);
    return true;
  }

  return false;
}

async function handleFieldValue(
  ctx: Context,
  env: Env,
  userId: number,
  session: CmsSession,
  text: string
): Promise<void> {
  const { slug, activeField, edits } = session;
  if (!slug || !activeField) {
    await clearSession(env.DB, userId);
    return;
  }

  const field = findField(activeField);
  if (!field) {
    await clearSession(env.DB, userId);
    return;
  }

  const isBody = session.step === 'awaiting_body';
  const raw = isBody ? text : text.trim();

  if (!isBody) {
    const v = validateValue(field, raw);
    if (!v.ok) {
      await ctx.reply(`❌ ${v.error}. Coba lagi:`);
      return;
    }
  } else if (raw.trim().length < 10) {
    await ctx.reply('❌ Sinopsis minimal 10 karakter. Coba lagi:');
    return;
  }

  const newEdits = { ...edits, [activeField]: raw };

  await ctx.reply(
    `✅ <b>${escapeHtml(field.label)}</b> di-set.\n\n<i>Kembali ke menu edit...</i>`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );

  const count = Object.keys(newEdits).length;
  const lines = [
    `✏️ <b>Edit — ${escapeHtml(slug)}</b>`,
    '',
    `📝 <b>${count} perubahan pending:</b>`,
  ];
  for (const [k, v] of Object.entries(newEdits)) {
    const f = findField(k);
    const label = f?.label ?? k;
    const preview =
      k === 'body'
        ? `${v.slice(0, 40).replace(/\n/g, ' ')}…`
        : v.length > 40
          ? v.slice(0, 38) + '…'
          : v;
    lines.push(`• ${label} → <code>${escapeHtml(preview)}</code>`);
  }
  lines.push('');
  lines.push('<i>Tap field untuk ubah:</i>');

  const kb = new InlineKeyboard();
  let i = 0;
  for (const f of EDIT_FIELDS) {
    const mark = newEdits[f.key] !== undefined ? '✅' : '⬜';
    kb.text(`${mark} ${f.label}`, `cms:ef:${f.key}`);
    i++;
    if (i % 2 === 0) kb.row();
  }
  if (i % 2 !== 0) kb.row();

  kb.text(`💾 Save (${count})`, 'cms:save');
  kb.text('❌ Batal', `cms:view:${slug}`);
  kb.row();
  kb.text('◀️ Detail', `cms:view:${slug}`);

  await setSession(env.DB, userId, {
    step: 'edit_menu',
    slug,
    edits: newEdits,
  });

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

/* ============================================================
   CALLBACKS
   ============================================================ */

export function setupCmsCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^cms:home$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showMainMenu(ctx, env, true);
  });

  bot.callbackQuery(/^cms:search$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    await ctx.answerCallbackQuery().catch(() => {});
    await showSlugPrompt(ctx, env, userId);
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

  bot.callbackQuery(/^cms:add:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await showAddNewInstructions(ctx, env, slug);
  });

  bot.callbackQuery(/^cms:del:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await showDeleteConfirm(ctx, env, slug);
  });

  bot.callbackQuery(/^cms:dely:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await execDeleteAnime(ctx, env, slug);
  });

  /* EPISODES */
  bot.callbackQuery(/^cms:ep:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await ctx.answerCallbackQuery().catch(() => {});
    await showEpisodesMenu(ctx, env, slug);
  });

  bot.callbackQuery(/^cms:epv:([^:]+):(meta|streams):([^:]+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    const type = (ctx.match[2] ?? 'meta') as 'meta' | 'streams';
    const fileName = ctx.match[3] ?? '';
    await ctx.answerCallbackQuery().catch(() => {});
    await showChunkPreview(ctx, env, slug, type, fileName);
  });

  bot.callbackQuery(/^cms:epd:([^:]+):(meta|streams):([^:]+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    const type = (ctx.match[2] ?? 'meta') as 'meta' | 'streams';
    const fileName = ctx.match[3] ?? '';
    await confirmDeleteChunk(ctx, env, slug, type, fileName);
  });

  bot.callbackQuery(/^cms:epdy:([^:]+):(meta|streams):([^:]+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    const type = (ctx.match[2] ?? 'meta') as 'meta' | 'streams';
    const fileName = ctx.match[3] ?? '';
    await execDeleteChunk(ctx, env, slug, type, fileName);
  });

  bot.callbackQuery(/^cms:epb:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await showBatchShortcut(ctx, env, slug);
  });

  /* EDIT */
  bot.callbackQuery(/^cms:edit:(.+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const slug = ctx.match[1] ?? '';
    await ctx.answerCallbackQuery().catch(() => {});
    await showEditMenu(ctx, env, userId, slug, {});
  });

  bot.callbackQuery(/^cms:edit:back$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const session = await getSession(env.DB, userId);
    if (!session?.slug) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Session habis',
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    await showEditMenu(ctx, env, userId, session.slug, session.edits);
  });

  bot.callbackQuery(/^cms:ef:([a-zA-Z.]+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const key = ctx.match[1] ?? '';
    const session = await getSession(env.DB, userId);
    if (!session?.slug) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Session habis',
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    await showFieldPrompt(ctx, env, userId, session.slug, key, session.edits);
  });

  bot.callbackQuery(/^cms:ev:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const idx = parseInt(ctx.match[1] ?? '-1', 10);
    const session = await getSession(env.DB, userId);
    if (!session?.slug || !session.activeField) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Session habis',
        show_alert: true,
      });
      return;
    }

    const field = findField(session.activeField);
    if (!field || !field.choices || idx < 0 || idx >= field.choices.length) {
      await ctx.answerCallbackQuery({ text: '❌ Pilihan invalid' });
      return;
    }

    const value = field.choices[idx]!;
    await ctx.answerCallbackQuery({ text: `✅ ${value}` });

    const newEdits = { ...session.edits, [session.activeField]: value };
    await showEditMenu(ctx, env, userId, session.slug, newEdits);
  });

  bot.callbackQuery(/^cms:save$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const session = await getSession(env.DB, userId);
    if (!session?.slug) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Session habis',
        show_alert: true,
      });
      return;
    }
    await saveEdits(ctx, env, userId, session.slug, session.edits);
  });

  bot.callbackQuery(/^cms:sec:(.+):(chars|fr)$/, async (ctx) => {
    await ctx.answerCallbackQuery({
      text: '🚧 Section detail — coming next',
      show_alert: true,
    });
  });
}
