// src/commands/publish-data.ts
import type { CommandDefinition } from './registry';
import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import { githubCommitFile, githubGetFile } from '../lib/github';

const TTL_MS = 30 * 60 * 1000;

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
  json_data: string;
  item_count: number;
  target_path: string;
  created_at: number;
  expires_at: number;
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
            json_data   TEXT NOT NULL,
            item_count  INTEGER NOT NULL,
            target_path TEXT NOT NULL,
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
  data: Omit<PendingRow, 'session_id' | 'created_at' | 'expires_at'>
): Promise<string> {
  await ensurePendingDb(db);
  const sessionId = 'pd_' + crypto.randomUUID().replace(/-/g, '').slice(0, 13);
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO pending_data_sections
        (session_id, user_id, slug, section, json_data, item_count, target_path, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      data.user_id,
      data.slug,
      data.section,
      data.json_data,
      data.item_count,
      data.target_path,
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

async function doPublishCharacters(
  ctx: any,
  env: Env,
  session: SessionRow,
  slug: string
): Promise<void> {
  const loading = await ctx.reply('🔍 Cek characters dari session...');

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
      ctx.chat!.id,
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
      ctx.chat!.id,
      loading.message_id,
      '❌ Characters kosong di cache.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const jsonData = JSON.stringify(characters, null, 2) + '\n';
  const targetPath = `data/anime/${slug}/characters.json`;

  const pendingId = await savePending(env.DB, {
    user_id: session.user_id,
    slug,
    section: 'characters',
    json_data: jsonData,
    item_count: characters.length,
    target_path: targetPath,
  });

  let existing: Awaited<ReturnType<typeof githubGetFile>> = null;
  try {
    existing = await githubGetFile(env, targetPath, 'yukio-data');
  } catch {}

  const sizeKB = Math.max(1, Math.round(jsonData.length / 1024));

  const lines: string[] = [];
  lines.push(`📋 <b>Preview: Characters</b>`);
  lines.push('');
  lines.push(`🎬 <code>${escapeHtml(session.title)}</code>`);
  lines.push(`📁 <code>${escapeHtml(targetPath)}</code>`);
  lines.push(`📏 ${sizeKB} KB`);
  lines.push(`👥 ${characters.length} karakter`);
  lines.push(`📡 Sumber: ${escapeHtml(cacheRow.source ?? 'unknown')}`);
  lines.push('');

  if (existing) {
    lines.push(
      `⚠️ <b>File sudah ada!</b> (${Math.max(1, Math.round(existing.content.length / 1024))} KB)`
    );
    lines.push('Akan di-overwrite.');
  } else {
    lines.push('✅ File baru.');
  }

  const kb = new InlineKeyboard()
    .text('📤 Push ke yukio-data', `pd:push:${pendingId}`)
    .text('❌ Batal', `pd:cancel:${pendingId}`);

  await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

export function setupPublishDataCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^pd:(chars|eps|fr|va):([a-z0-9-]+)$/, async (ctx) => {
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
  });

  bot.callbackQuery(/^pd:push:(pd_[a-z0-9]+)$/, async (ctx) => {
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

    const result = await githubCommitFile(
      env,
      pending.target_path,
      pending.json_data,
      `feat(${pending.section}): add for ${pending.slug}`,
      'yukio-data'
    );

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
          `📁 <code>${escapeHtml(pending.target_path)}</code>\n` +
          `📊 ${pending.item_count} item\n` +
          `🔗 Commit: <code>${commitShort}</code>\n` +
          `⏳ Deploy ~2 menit`,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: undefined,
        }
      )
      .catch(() => {});
  });

  bot.callbackQuery(/^pd:cancel:(pd_[a-z0-9]+)$/, async (ctx) => {
    const pendingId = ctx.match[1] ?? '';
    if (pendingId) await deletePending(env.DB, pendingId);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageText('❌ <b>Dibatalkan.</b>', {
        parse_mode: 'HTML',
        reply_markup: undefined,
      })
      .catch(() => {});
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