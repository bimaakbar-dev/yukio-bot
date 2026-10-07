// src/commands/publish-dba.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import type { AniListMedia } from '../types/anime';
import { githubCommitFile, githubGetFile } from '../lib/github';
import { buildMetadataYaml } from '../services/qimochi-yaml';

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
  metadata: string | null;
  expires_at: number;
}

interface PendingRow {
  session_id: string;
  user_id: number;
  slug: string;
  markdown: string;
  created_at: number;
  expires_at: number;
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
          `CREATE TABLE IF NOT EXISTS pending_dba_metadata (
            session_id  TEXT PRIMARY KEY,
            user_id     INTEGER NOT NULL,
            slug        TEXT NOT NULL,
            markdown    TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            expires_at  INTEGER NOT NULL
          )`
        )
        .run();
      dbReady = true;
    } catch (err) {
      console.error('[PublishDBA] DB init error:', err);
      dbInitPromise = null;
      throw err;
    }
  })();

  return dbInitPromise;
}

async function savePending(
  db: D1Database,
  userId: number,
  slug: string,
  markdown: string
): Promise<string> {
  await ensurePendingDb(db);
  const sessionId = 'pdm_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO pending_dba_metadata
        (session_id, user_id, slug, markdown, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(sessionId, userId, slug, markdown, now, now + TTL_MS)
    .run();

  return sessionId;
}

async function getPending(
  db: D1Database,
  sessionId: string
): Promise<PendingRow | null> {
  await ensurePendingDb(db);

  const row = await db
    .prepare('SELECT * FROM pending_dba_metadata WHERE session_id = ?')
    .bind(sessionId)
    .first<PendingRow>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM pending_dba_metadata WHERE session_id = ?')
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
      .prepare('DELETE FROM pending_dba_metadata WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[PublishDBA] deletePending error:', err);
  }
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

function buildMarkdown(
  session: SessionRow,
  media: AniListMedia
): string {
  const yaml = buildMetadataYaml({
    media,
    malId: session.mal_id ?? null,
    kitsuId: session.kitsu_id ?? null,
  });

  const rawSynopsis = media.description ?? '';
  const body = rawSynopsis
    ? stripHtml(rawSynopsis)
    : '> ⚠️ Sinopsis belum tersedia. Silakan isi manual.';

  return `${yaml}\n\n${body}\n`;
}

async function doPublishDba(
  ctx: Context,
  env: Env,
  session: SessionRow
): Promise<void> {
  if (!session.metadata) {
    await ctx.reply(
      '❌ Session tidak punya metadata. Ulangi <code>/dba &lt;judul&gt;</code> dulu.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  let media: AniListMedia;
  try {
    media = JSON.parse(session.metadata) as AniListMedia;
  } catch {
    await ctx.reply('❌ Gagal parse metadata dari session.');
    return;
  }

  const slug = slugify(session.title);
  const markdown = buildMarkdown(session, media);
  const targetPath = `src/content/anime/${slug}.md`;

  if (!ctx.from?.id) return;

  const pendingId = await savePending(env.DB, ctx.from.id, slug, markdown);

  let existing: Awaited<ReturnType<typeof githubGetFile>> = null;
  try {
    existing = await githubGetFile(env, targetPath, 'yukionime');
  } catch {}

  const sizeKB = Math.max(1, Math.round(markdown.length / 1024));
  const lines: string[] = [];

  lines.push(`📋 <b>Preview Publish DBA</b>`);
  lines.push('');
  lines.push(`📁 <code>${escapeHtml(targetPath)}</code>`);
  lines.push(`📏 ${sizeKB} KB`);
  lines.push(`🎬 ${escapeHtml(session.title)}`);
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
    .text('📤 Push ke yukionime', `pdm:push:${pendingId}`)
    .text('❌ Batal', `pdm:cancel:${pendingId}`);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

export function setupPublishDbaCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^pdm:push:(pdm_[a-z0-9]+)$/, async (ctx) => {
    const pendingId = ctx.match[1] ?? '';
    if (!pendingId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }

    const pending = await getPending(env.DB, pendingId);
    if (!pending) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Kadaluarsa. Ulangi /publish_dba.',
        show_alert: true,
      });
      return;
    }

    if (ctx.from?.id !== pending.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

    const targetPath = `src/content/anime/${pending.slug}.md`;
    const result = await githubCommitFile(
      env,
      targetPath,
      pending.markdown,
      `feat(anime): add ${pending.slug}`,
      'yukionime'
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
          `📁 <code>${escapeHtml(targetPath)}</code>\n` +
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

  bot.callbackQuery(/^pdm:cancel:(pdm_[a-z0-9]+)$/, async (ctx) => {
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

export const publishDbaCommand: CommandDefinition = {
  name: 'publish_dba',
  description: 'Push metadata anime ke yukionime',
  usage: '/publish_dba',
  adminOnly: true,

  handler: async (ctx, env) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = await env.DB
      .prepare(
        `SELECT * FROM qimochi_sessions
         WHERE user_id = ? AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(userId, Date.now())
      .first<SessionRow>();

    if (!session) {
      await ctx.reply(
        '📭 Tidak ada session /dba aktif.\n\n' +
          'Kirim <code>/dba &lt;judul&gt;</code> dulu, lalu jalankan command ini.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    await doPublishDba(ctx, env, session);
  },
};