// src/commands/database/actions.ts
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import { escapeHtml } from '../../lib/utils';
import { createLazyInit } from '../../lib/lazy-init';
import {
  githubGetFile,
  githubCommitFile,
  githubDeleteFile,
  githubListDir,
} from '../../lib/github';

import {
  getCmsIndex,
  invalidateCmsIndex,
  type CmsIndex,
} from '../../lib/cms-cache';

import {
  splitContent,
  getFrontmatterField,
  applyEdits,
} from '../../lib/content-editor';

import {
  EDIT_FIELDS,
  findField,
  buildMainMenuKeyboard,
  buildDetailKeyboard,
  buildEditMenuKeyboard,
  buildValueKeyboard,
  buildFieldMenuText,
  buildValuePromptText,
} from './ui';

const SESSION_TTL_MS = 15 * 60 * 1000;

type Step = 'idle' | 'awaiting_slug' | 'edit_menu' | 'awaiting_value' | 'awaiting_body';

interface Session {
  step: Step;
  slug?: string;
  activeField?: string;
  edits: Record<string, string>;
}

const ensureSessionDb = createLazyInit('DbSess', async (db) => {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS db_sessions (
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
});

async function setSession(
  db: D1Database,
  userId: number,
  data: { step: Step; slug?: string; activeField?: string; edits?: Record<string, string> }
): Promise<void> {
  await ensureSessionDb(db);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO db_sessions
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

async function getSession(db: D1Database, userId: number): Promise<Session | null> {
  await ensureSessionDb(db);
  const row = await db
    .prepare(
      `SELECT step, slug, active_field, edits_json, expires_at
       FROM db_sessions WHERE user_id = ?`
    )
    .bind(userId)
    .first<{
      step: Step;
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
  await ensureSessionDb(db);
  await db.prepare('DELETE FROM db_sessions WHERE user_id = ?').bind(userId).run();
}

export async function showMainMenu(
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
        .editMessageText(ctx.chat!.id, loading.message_id, text, { parse_mode: 'HTML' })
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

  const kb = buildMainMenuKeyboard();
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

export async function showSlugPrompt(
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
        '<i>Contoh: <code>nama-anime</code></i>',
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().text('❌ Batal', 'db:home'),
      }
    )
    .catch(() => {});
}

export async function handleSlugInput(
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

  const loading = await ctx.reply(`🔍 Cek <code>${escapeHtml(slug)}</code>...`, {
    parse_mode: 'HTML',
  });

  const file = await githubGetFile(env, `src/content/anime/${slug}.md`).catch(() => null);

  await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});

  if (!file) {
    await ctx.reply(
        `❌ <b>Slug tidak ditemukan</b>\n\n` +
        `<code>${escapeHtml(slug)}</code> belum ada di data repo.\n\n` +
        `<i>Pakai /anime untuk tambah baru.</i>`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text('🔍 Coba Lagi', 'db:search')
          .text('◀️ Kembali', 'db:home'),
      }
    );
    return;
  }

  await showDetailFromContent(ctx, env, slug, file.content, false);
}

export async function showDetail(ctx: Context, env: Env, slug: string): Promise<void> {
  const file = await githubGetFile(env, `src/content/anime/${slug}.md`).catch(() => null);

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
  const { frontmatter } = splitContent(content);
  const get = (key: string): string | null => getFrontmatterField(frontmatter, key);

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

  const kb = buildDetailKeyboard(slug, hasChars, hasEps, hasStreams, hasFr);
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

async function showEditMenu(
  ctx: Context,
  env: Env,
  userId: number,
  slug: string,
  edits: Record<string, string>
): Promise<void> {
  await setSession(env.DB, userId, { step: 'edit_menu', slug, edits });

  const text = buildFieldMenuText(slug, edits);
  const kb = buildEditMenuKeyboard(slug, edits);

  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery!.message!.message_id!,
      text,
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

  const file = await githubGetFile(env, `src/content/anime/${slug}.md`).catch(() => null);
  if (!file) {
    await ctx.answerCallbackQuery({ text: '❌ File hilang', show_alert: true });
    return;
  }

  const { frontmatter } = splitContent(file.content);
  const current = getFrontmatterField(frontmatter, fieldKey);

  const step: Step = field.type === 'body' ? 'awaiting_body' : 'awaiting_value';
  await setSession(env.DB, userId, { step, slug, activeField: fieldKey, edits });

  const text = buildValuePromptText(slug, field, current);
  const kb =
    field.type === 'choice' && field.choices
      ? buildValueKeyboard(fieldKey, field.choices)
      : new InlineKeyboard().text('↩️ Balik', 'db:edit:back');

  await ctx.api
    .editMessageText(ctx.chat!.id, ctx.callbackQuery!.message!.message_id!, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
    })
    .catch(() => {});
}

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
    const file = await githubGetFile(env, `src/content/anime/${slug}.md`);
    if (!file) throw new Error('File MD tidak ditemukan');

    const newContent = applyEdits(file.content, edits);

    const result = await githubCommitFile(
      env,
      `src/content/anime/${slug}.md`,
      newContent,
      `chore(cms): update ${slug} (${count} field)`
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

    await ctx.api
      .editMessageText(ctx.chat!.id, loadingMsgId, lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text('✏️ Edit Lagi', `db:edit:${slug}`)
          .text('📄 Detail', `db:view:${slug}`),
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
          reply_markup: new InlineKeyboard().text('◀️ Balik', `db:edit:${slug}`),
        }
      )
      .catch(() => {});
  }
}

async function listJsonFiles(env: Env, path: string): Promise<string[]> {
  try {
    const dir = await githubListDir(env, path);
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
  else for (const f of streamFiles) lines.push(`  • <code>${escapeHtml(f)}</code>`);

  lines.push('');
  lines.push('<i>Tap file untuk preview / hapus:</i>');

  const kb = new InlineKeyboard();
  for (const f of metaFiles) kb.text(`📄 ${f}`, `db:epv:${slug}:meta:${f}`).row();
  for (const f of streamFiles) kb.text(`📺 ${f}`, `db:epv:${slug}:streams:${f}`).row();

  kb.text('🔍 Refresh', `db:ep:${slug}`).text('◀️ Detail', `db:view:${slug}`);

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

  const file = await githubGetFile(env, path).catch(() => null);
  if (!file) {
    await ctx.answerCallbackQuery({ text: '❌ File hilang', show_alert: true });
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

  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery!.message!.message_id!,
      lines.join('\n'),
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text('🗑️ Hapus', `db:epd:${slug}:${type}:${fileName}`)
          .row()
          .text('◀️ Kembali', `db:ep:${slug}`),
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

  const result = await githubDeleteFile(env, path, `chore(cms): delete ${fileName}`);
  if (!result.ok) {
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loadingMsgId,
        `❌ <b>Gagal hapus</b>\n\n<code>${escapeHtml((result.error ?? 'unknown').slice(0, 200))}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('◀️ Kembali', `db:ep:${slug}`),
        }
      )
      .catch(() => {});
    return;
  }

  await invalidateCmsIndex(env);
  await showEpisodesMenu(ctx, env, slug);
}

async function collectFolderFiles(
  env: Env,
  path: string,
  depth = 0
): Promise<string[]> {
  if (depth > 3) return [];
  const files: string[] = [];
  try {
    const items = await githubListDir(env, path);
    for (const item of items) {
      const child = `${path}/${item.name}`;
      if (item.type === 'file') files.push(child);
      else if (item.type === 'dir') files.push(...(await collectFolderFiles(env, child, depth + 1)));
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
  const md = await githubGetFile(env, mdPath).catch(() => null);
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
          reply_markup: new InlineKeyboard().text('◀️ Detail', `db:view:${slug}`),
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
  for (const f of dataFiles.slice(0, 10)) lines.push(`  📁 <code>${escapeHtml(f)}</code>`);
  if (dataFiles.length > 10) lines.push(`  <i>… dan ${dataFiles.length - 10} file lain</i>`);
  lines.push('');
  lines.push('<b>⚠️ Tidak bisa dibatalkan.</b>');

  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      ctx.callbackQuery!.message!.message_id!,
      lines.join('\n'),
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text(`✅ Hapus ${total} file`, `db:dely:${slug}`)
          .row()
          .text('❌ Batal', `db:view:${slug}`),
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

  try {
    const mdPath = `src/content/anime/${slug}.md`;
    const md = await githubGetFile(env, mdPath).catch(() => null);
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
        const r = await githubDeleteFile(env, p, `chore(cms): delete ${slug}`);
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
      for (const e of errors.slice(0, 3)) lines.push(`• <code>${escapeHtml(e.slice(0, 120))}</code>`);
    }

    await ctx.api
      .editMessageText(ctx.chat!.id, loadingMsgId, lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text('🔍 Cari Lagi', 'db:search')
          .text('🏠 Menu', 'db:home'),
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
          reply_markup: new InlineKeyboard().text('◀️ Detail', `db:view:${slug}`),
        }
      )
      .catch(() => {});
  }
}

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
        reply_markup: new InlineKeyboard().text('◀️ Kembali', 'db:home'),
      }
    )
    .catch(() => {});
}

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
          reply_markup: new InlineKeyboard().text('◀️ Kembali', 'db:home'),
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
          reply_markup: new InlineKeyboard().text('◀️ Kembali', 'db:home'),
        }
      )
      .catch(() => {});
  }
}

export async function handleDatabaseText(
  ctx: Context,
  env: Env
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;

  const text = ctx.message?.text ?? '';
  if (!text || text.startsWith('/')) return false;

  const session = await getSession(env.DB, userId);
  if (!session) return false;

  if (session.step === 'awaiting_slug') {
    await handleSlugInput(ctx, env, userId, text);
    return true;
  }

  if (session.step === 'awaiting_value' || session.step === 'awaiting_body') {
    const { slug, activeField } = session;
    if (!slug || !activeField) {
      await clearSession(env.DB, userId);
      return false;
    }

    const field = findField(activeField);
    if (!field) {
      await clearSession(env.DB, userId);
      return false;
    }

    const isBody = session.step === 'awaiting_body';
    const raw = isBody ? text : text.trim();

    if (!isBody) {
      if (field.type === 'number' && isNaN(Number(raw))) {
        await ctx.reply('❌ Harus angka. Coba lagi:');
        return true;
      }
      if (field.type === 'url') {
        try {
          new URL(raw);
        } catch {
          await ctx.reply('❌ URL tidak valid. Coba lagi:');
          return true;
        }
      }
    } else if (raw.trim().length < 10) {
      await ctx.reply('❌ Sinopsis minimal 10 karakter. Coba lagi:');
      return true;
    }

    const newEdits = { ...session.edits, [activeField]: raw };
    await setSession(env.DB, userId, {
      step: 'edit_menu',
      slug,
      edits: newEdits,
    });

    const editMsg = await ctx.reply('✅ Tersimpan. Kembali ke menu edit...', {
      parse_mode: 'HTML',
    });
    void editMsg;

    const lines = buildFieldMenuText(slug, newEdits);
    const kb = buildEditMenuKeyboard(slug, newEdits);
    await ctx.reply(lines, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
    });
    return true;
  }

  return false;
}

export function setupDatabaseCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^db:home$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showMainMenu(ctx, env, true);
  });

  bot.callbackQuery(/^db:search$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    await ctx.answerCallbackQuery().catch(() => {});
    await showSlugPrompt(ctx, env, userId);
  });

  bot.callbackQuery(/^db:view:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await ctx.answerCallbackQuery().catch(() => {});
    await showDetail(ctx, env, slug);
  });

  bot.callbackQuery(/^db:stats$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showStats(ctx, env);
  });

  bot.callbackQuery(/^db:sync$/, async (ctx) => {
    await doSync(ctx, env);
  });

  bot.callbackQuery(/^db:del:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await showDeleteConfirm(ctx, env, slug);
  });

  bot.callbackQuery(/^db:dely:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await execDeleteAnime(ctx, env, slug);
  });

  /* Episodes */
  bot.callbackQuery(/^db:ep:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await ctx.answerCallbackQuery().catch(() => {});
    await showEpisodesMenu(ctx, env, slug);
  });

  bot.callbackQuery(/^db:epv:([^:]+):(meta|streams):([^:]+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    const type = (ctx.match[2] ?? 'meta') as 'meta' | 'streams';
    const fileName = ctx.match[3] ?? '';
    await ctx.answerCallbackQuery().catch(() => {});
    await showChunkPreview(ctx, env, slug, type, fileName);
  });

  bot.callbackQuery(/^db:epd:([^:]+):(meta|streams):([^:]+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    const type = (ctx.match[2] ?? 'meta') as 'meta' | 'streams';
    const fileName = ctx.match[3] ?? '';
    await execDeleteChunk(ctx, env, slug, type, fileName);
  });

  /* Edit */
  bot.callbackQuery(/^db:edit:(.+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const slug = ctx.match[1] ?? '';
    await ctx.answerCallbackQuery().catch(() => {});
    await showEditMenu(ctx, env, userId, slug, {});
  });

  bot.callbackQuery(/^db:edit:back$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const session = await getSession(env.DB, userId);
    if (!session?.slug) {
      await ctx.answerCallbackQuery({ text: '⏱️ Session habis', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    await showEditMenu(ctx, env, userId, session.slug, session.edits);
  });

  bot.callbackQuery(/^db:ef:([a-zA-Z.]+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const key = ctx.match[1] ?? '';
    const session = await getSession(env.DB, userId);
    if (!session?.slug) {
      await ctx.answerCallbackQuery({ text: '⏱️ Session habis', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    await showFieldPrompt(ctx, env, userId, session.slug, key, session.edits);
  });

  bot.callbackQuery(/^db:ev:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const idx = parseInt(ctx.match[1] ?? '-1', 10);
    const session = await getSession(env.DB, userId);
    if (!session?.slug || !session.activeField) {
      await ctx.answerCallbackQuery({ text: '⏱️ Session habis', show_alert: true });
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
    await setSession(env.DB, userId, {
      step: 'edit_menu',
      slug: session.slug,
      edits: newEdits,
    });

    await showEditMenu(ctx, env, userId, session.slug, newEdits);
  });

  bot.callbackQuery(/^db:save$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const session = await getSession(env.DB, userId);
    if (!session?.slug) {
      await ctx.answerCallbackQuery({ text: '⏱️ Session habis', show_alert: true });
      return;
    }
    await saveEdits(ctx, env, userId, session.slug, session.edits);
  });
}

void EDIT_FIELDS;
