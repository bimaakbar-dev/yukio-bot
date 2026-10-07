// src/commands/publish-data.ts
import type { CommandDefinition } from './registry';
import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import {
  githubCommitFile,
  githubCommitMultipleFiles,
  githubGetFile,
  type FileToCommit,
} from '../lib/github';

const TTL_MS = 30 * 60 * 1000;
const CHAR_PART_SIZE = 50;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface SessionRow {
  session_id: string;
  user_id: number;
  mal_id: number | null;
  kitsu_id: string | null;
  title: string;
  expires_at: number;
}

interface PendingRow {
  session_id: string;
  user_id: number;
  slug: string;
  section: string;
  files_json: string;
  total_items: number;
  file_count: number;
  total_size: number;
  created_at: number;
  expires_at: number;
}

interface PendingFile {
  path: string;
  content: string;
  items: number;
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

let dbReady = false;
let dbInitPromise: Promise<void> | null = null;

async function ensurePendingDb(db: D1Database): Promise<void> {
  if (dbReady) return;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS pending_data_sections (
            session_id  TEXT PRIMARY KEY,
            user_id     INTEGER NOT NULL,
            slug        TEXT NOT NULL,
            section     TEXT NOT NULL,
            files_json  TEXT NOT NULL,
            total_items INTEGER NOT NULL,
            file_count  INTEGER NOT NULL,
            total_size  INTEGER NOT NULL,
            created_at  INTEGER NOT NULL,
            expires_at  INTEGER NOT NULL
          )`
        )
        .run();
      dbReady = true;
    } catch (err) {
      console.error('[PublishData] DB init error:', err);
      dbInitPromise = null;
      throw err;
    }
  })();

  return dbInitPromise;
}

async function savePending(
  db: D1Database,
  data: {
    user_id: number;
    slug: string;
    section: string;
    files: PendingFile[];
    total_items: number;
    total_size: number;
  }
): Promise<string> {
  await ensurePendingDb(db);
  const sessionId = 'pd_' + crypto.randomUUID().replace(/-/g, '').slice(0, 13);
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO pending_data_sections
        (session_id, user_id, slug, section, files_json, total_items, file_count, total_size, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      data.user_id,
      data.slug,
      data.section,
      JSON.stringify(data.files),
      data.total_items,
      data.files.length,
      data.total_size,
      now,
      now + TTL_MS
    )
    .run();

  return sessionId;
}

async function getPending(
  db: D1Database,
  sessionId: string
): Promise<PendingRow | null> {
  await ensurePendingDb(db);

  const row = await db
    .prepare('SELECT * FROM pending_data_sections WHERE session_id = ?')
    .bind(sessionId)
    .first<PendingRow>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM pending_data_sections WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }

  return row;
}

async function deletePending(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await ensurePendingDb(db);
    await db
      .prepare('DELETE FROM pending_data_sections WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[PublishData] deletePending error:', err);
  }
}

async function getSession(
  env: Env,
  userId: number
): Promise<SessionRow | null> {
  return env.DB
    .prepare(
      `SELECT * FROM qimochi_sessions
       WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(userId, Date.now())
    .first<SessionRow>();
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function buildPendingFiles(
  items: unknown[],
  basePath: string,
  chunkSize: number
): PendingFile[] {
  const chunks = chunkArray(items, chunkSize);
  const files: PendingFile[] = [];

  let cursor = 1;
  for (const chunk of chunks) {
    const start = cursor;
    const end = cursor + chunk.length - 1;
    files.push({
      path: `${basePath}/${start}-${end}.json`,
      content: JSON.stringify(chunk, null, 2) + '\n',
      items: chunk.length,
    });
    cursor = end + 1;
  }

  return files;
}

async function countExistingFiles(
  env: Env,
  files: PendingFile[],
  target: 'yukio-data' | 'qimochi' | 'yukionime'
): Promise<number> {
  const results = await Promise.allSettled(
    files.map((f) =>
      Promise.race([
        githubGetFile(env, f.path, target),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ])
    )
  );

  let count = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) count++;
  }
  return count;
}

async function previewAndSave(
  ctx: any,
  env: Env,
  session: SessionRow,
  slug: string,
  section: string,
  items: unknown[],
  basePath: string,
  chunkSize: number,
  loadingMessageId: number,
  extraInfo?: string
): Promise<void> {
  const files = buildPendingFiles(items, basePath, chunkSize);
  const totalSize = files.reduce((sum, f) => sum + f.content.length, 0);

  const pendingId = await savePending(env.DB, {
    user_id: session.user_id,
    slug,
    section,
    files,
    total_items: items.length,
    total_size: totalSize,
  });

  await ctx.api
    .editMessageText(
      ctx.chat.id,
      loadingMessageId,
      '🔍 Cek file existing...',
      { parse_mode: 'HTML' }
    )
    .catch(() => {});

  let existingCount = 0;
  try {
    existingCount = await countExistingFiles(env, files, 'yukio-data');
  } catch (err) {
    console.warn('[PublishData] countExistingFiles error:', err);
  }

  const sizeKB = Math.max(1, Math.round(totalSize / 1024));

  const lines: string[] = [];
  lines.push(`📋 <b>Preview: ${escapeHtml(section)}</b>`);
  lines.push('');
  lines.push(`🎬 <code>${escapeHtml(session.title)}</code>`);
  lines.push(`📁 <code>${escapeHtml(basePath)}/</code>`);
  lines.push(`📏 ${sizeKB} KB total`);
  lines.push(`📊 ${items.length} item → ${files.length} file`);
  if (extraInfo) lines.push(extraInfo);
  lines.push('');

  if (files.length <= 5) {
    lines.push('<b>File:</b>');
    for (const f of files) {
      const name = f.path.slice(f.path.lastIndexOf('/') + 1);
      lines.push(`• <code>${escapeHtml(name)}</code> (${f.items} item)`);
    }
    lines.push('');
  }

  if (existingCount === files.length && files.length > 0) {
    lines.push('⚠️ <b>Semua file sudah ada.</b> Akan di-overwrite.');
  } else if (existingCount > 0) {
    lines.push(`⚠️ <b>${existingCount}/${files.length} file sudah ada.</b>`);
  } else {
    lines.push('✅ Semua file baru.');
  }

  const kb = new InlineKeyboard()
    .text('📤 Push ke yukio-data', `pd:push:${pendingId}`)
    .text('❌ Batal', `pd:cancel:${pendingId}`);

  await ctx.api.editMessageText(
    ctx.chat.id,
    loadingMessageId,
    lines.join('\n'),
    {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
    }
  );
}

async function doPublishCharacters(
  ctx: any,
  env: Env,
  session: SessionRow,
  slug: string
): Promise<void> {
  const loading = await ctx.reply('🔍 Cek characters dari session...');

  try {
    let cacheRow: { data: string; total: number; source: string } | null = null;

    try {
      cacheRow = await env.DB
        .prepare(
          `SELECT data, total, source FROM qimochi_char_cache
           WHERE session_id = ?`
        )
        .bind(session.session_id)
        .first<{ data: string; total: number; source: string }>();
    } catch (err) {
      console.warn('[PublishData] char cache query error:', err);
    }

    if (!cacheRow) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        `❌ <b>Characters belum ada di cache.</b>\n\n` +
          `Buka <code>/dba</code> → klik <b>👥 Characters</b> dulu,\n` +
          `lalu jalankan <code>/publish_data</code> lagi.\n\n` +
          `<i>Cache expired setelah 30 menit.</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    let characters: unknown[] = [];

    try {
      const parsed = JSON.parse(cacheRow.data);
      if (Array.isArray(parsed)) characters = parsed;
    } catch {
      characters = [];
    }

    if (characters.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        '❌ Characters kosong di cache.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    await previewAndSave(
      ctx,
      env,
      session,
      slug,
      'characters',
      characters,
      `data/anime/${slug}/characters`,
      CHAR_PART_SIZE,
      loading.message_id,
      `📡 Sumber: ${escapeHtml(cacheRow.source ?? 'unknown')}`
    );
  } catch (err: any) {
    console.error('[PublishData] doPublishCharacters error:', err);
    await ctx.api
      .editMessageText(
        ctx.chat.id,
        loading.message_id,
        `❌ <b>Gagal prepare characters</b>\n\n` +
          `<code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
}

export function setupPublishDataCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^pd:(chars|eps|fr|va):([a-z0-9-]+)$/, async (ctx) => {
    try {
      const section = ctx.match[1] ?? '';
      const slug = ctx.match[2] ?? '';

      const userId = ctx.from?.id;
      if (!userId) return;

      const session = await getSession(env, userId);

      if (!session) {
        await ctx.answerCallbackQuery({
          text: '⏱️ Session kadaluarsa. Ulangi /dba.',
          show_alert: true,
        });
        return;
      }

      await ctx.answerCallbackQuery({ text: `⏳ ${section}...` });

      if (section === 'chars') {
        await doPublishCharacters(ctx, env, session, slug);
        return;
      }

      await ctx.reply(
        `🚧 <b>Section ${escapeHtml(section)}</b> belum diimplementasi.\n\n` +
          `Slug: <code>${escapeHtml(slug)}</code>`,
        { parse_mode: 'HTML' }
      );
    } catch (err: any) {
      console.error('[PublishData] callback error:', err);
      await ctx
        .reply(
          `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^pd:push:(pd_[a-z0-9]+)$/, async (ctx) => {
    try {
      const pendingId = ctx.match[1] ?? '';
      if (!pendingId) {
        await ctx.answerCallbackQuery({ text: '❌' });
        return;
      }

      const pending = await getPending(env.DB, pendingId);
      if (!pending) {
        await ctx.answerCallbackQuery({
          text: '⏱️ Kadaluarsa. Ulangi /publish_data.',
          show_alert: true,
        });
        return;
      }

      if (ctx.from?.id !== pending.user_id) {
        await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
        return;
      }

      await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

      let files: PendingFile[] = [];
      try {
        files = JSON.parse(pending.files_json) as PendingFile[];
      } catch {
        files = [];
      }

      if (files.length === 0) {
        await ctx.reply('❌ Tidak ada file untuk di-push.').catch(() => {});
        return;
      }

      const message = `feat(${pending.section}): add for ${pending.slug}`;

      let result: {
        ok: boolean;
        sha?: string;
        commitUrl?: string;
        error?: string;
      };

      if (files.length === 1) {
        const f = files[0]!;
        result = await githubCommitFile(
          env,
          f.path,
          f.content,
          message,
          'yukio-data'
        );
      } else {
        const payload: FileToCommit[] = files.map((f) => ({
          path: f.path,
          content: f.content,
        }));
        result = await githubCommitMultipleFiles(
          env,
          payload,
          message,
          'yukio-data'
        );
      }

      if (!result.ok) {
        await ctx
          .reply(
            `❌ Gagal push: <code>${escapeHtml(result.error ?? 'unknown')}</code>`,
            { parse_mode: 'HTML' }
          )
          .catch(() => {});
        return;
      }

      await deletePending(env.DB, pendingId);

      const commitShort = result.sha?.slice(0, 7) ?? '?';

      await ctx
        .editMessageText(
          `✅ <b>Published!</b>\n\n` +
            `📁 <code>data/anime/${escapeHtml(pending.slug)}/${escapeHtml(pending.section)}/</code>\n` +
            `📦 ${pending.file_count} file · ${pending.total_items} item\n` +
            `🔗 Commit: <code>${commitShort}</code>\n` +
            `⏳ Deploy ~2 menit`,
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: undefined,
          }
        )
        .catch(() => {});
    } catch (err: any) {
      console.error('[PublishData] push error:', err);
      await ctx
        .reply(
          `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^pd:cancel:(pd_[a-z0-9]+)$/, async (ctx) => {
    try {
      const pendingId = ctx.match[1] ?? '';
      if (pendingId) await deletePending(env.DB, pendingId);
      await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
      await ctx
        .editMessageText('❌ <b>Dibatalkan.</b>', {
          parse_mode: 'HTML',
          reply_markup: undefined,
        })
        .catch(() => {});
    } catch (err) {
      console.error('[PublishData] cancel error:', err);
    }
  });
}

export const publishDataCommand: CommandDefinition = {
  name: 'publish_data',
  description: 'Push JSON data ke yukio-data',
  usage: '/publish_data',
  adminOnly: true,

  handler: async (ctx, env) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = await getSession(env, userId);

    if (!session) {
      await ctx.reply(
        '📭 Tidak ada session /dba aktif.\n\n' +
          'Kirim <code>/dba &lt;judul&gt;</code> dulu.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const slug = slugify(session.title);
    const kb = new InlineKeyboard()
      .text('👥 Characters', `pd:chars:${slug}`)
      .text('🎬 Episodes', `pd:eps:${slug}`)
      .row()
      .text('🔗 Franchises', `pd:fr:${slug}`)
      .text('🎤 Voice Actors', `pd:va:${slug}`)
      .row()
      .text('❌ Batal', `pd:batal:${slug}`);

    await ctx.reply(
      `📤 <b>Publish Data</b>\n\n` +
        `🎬 <code>${escapeHtml(session.title)}</code>\n` +
        `📁 Target: <code>yukio-data</code>\n\n` +
        `Pilih section yang mau di-push:`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      }
    );
  },
};