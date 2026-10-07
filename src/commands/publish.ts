// src/commands/publish.ts
import type { CommandDefinition } from './registry';
import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import type { AniListMedia } from '../types/anime';
import { githubCommitFile, type FileToCommit } from '../lib/github';
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
  summary: string | null;
  expires_at: number;
}

interface PendingRow {
  session_id: string;
  user_id: number;
  files_json: string;
  summary_json: string;
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

let dbReady = false;
let dbInitPromise: Promise<void> | null = null;

async function ensurePendingDb(db: D1Database): Promise<void> {
  if (dbReady) return;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
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
      dbReady = true;
    } catch (err) {
      console.error('[Publish] DB init error:', err);
      dbInitPromise = null;
      throw err;
    }
  })();

  return dbInitPromise;
}

interface PublishSummary {
  yukionime: { metadata: boolean; files: number };
  yukioData: { characters: number; episodes: number; franchises: number; actors: number; files: number };
  qimochi: { franchises: number; files: number };
}

async function savePending(
  db: D1Database,
  userId: number,
  files: FileToCommit[],
  summary: PublishSummary
): Promise<string> {
  await ensurePendingDb(db);
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
    .prepare('SELECT * FROM pending_publish WHERE session_id = ?')
    .bind(sessionId)
    .first<PendingRow>();

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

async function deletePending(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await ensurePendingDb(db);
    await db
      .prepare('DELETE FROM pending_publish WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[Publish] deletePending error:', err);
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

async function buildMetadataFile(
  env: Env,
  session: SessionRow,
  slug: string
): Promise<FileToCommit | null> {
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
  };
}

async function doPublish(ctx: any, env: Env): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const loading = await ctx.reply('🔍 Scan session...');

  try {
    const session = await getSession(env, userId);

    if (!session) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        '📭 Tidak ada session `/dba` aktif.\n\n' +
          'Kirim <code>/dba &lt;judul&gt;</code> dulu.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const slug = slugify(session.title);
    const files: FileToCommit[] = [];
    const summary: PublishSummary = {
      yukionime: { metadata: false, files: 0 },
      yukioData: { characters: 0, episodes: 0, franchises: 0, actors: 0, files: 0 },
      qimochi: { franchises: 0, files: 0 },
    };

    const metaFile = await buildMetadataFile(env, session, slug);
    if (metaFile) {
      files.push(metaFile);
      summary.yukionime.metadata = true;
      summary.yukionime.files = 1;
    }

    if (files.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        `⚠️ <b>Tidak ada data siap di-publish.</b>\n\n` +
          `Buka <code>/dba</code> → klik <b>📋 Metadata</b> atau section lain dulu.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const pendingId = await savePending(env.DB, userId, files, summary);

    const lines: string[] = [];
    lines.push(`📋 <b>Preview Publish</b>`);
    lines.push('');
    lines.push(`🎬 <code>${escapeHtml(session.title)}</code>`);
    lines.push(`🆔 <code>${slug}</code>`);
    lines.push('');

    if (summary.yukionime.metadata) {
      lines.push(`📄 <b>Metadata + Summary</b> → yukionime`);
    }

    lines.push('');
    lines.push(`📦 Total: <b>${files.length}</b> file`);

    const kb = new InlineKeyboard()
      .text('📤 Push', `pp:push:${pendingId}`)
      .text('❌ Batal', `pp:cancel:${pendingId}`);

    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
    });
  } catch (err: any) {
    console.error('[Publish] scan error:', err);
    await ctx.api
      .editMessageText(
        ctx.chat.id,
        loading.message_id,
        `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
}

export function setupPublishCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^pp:push:(pp_[a-z0-9]+)$/, async (ctx) => {
    try {
      const pendingId = ctx.match[1] ?? '';
      if (!pendingId) {
        await ctx.answerCallbackQuery({ text: '❌' });
        return;
      }

      const pending = await getPending(env.DB, pendingId);
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

      const metaFile = files.find((f) => f.path.startsWith('src/content/anime/'));

      if (!metaFile) {
        await ctx.reply('❌ Metadata tidak ada di pending.').catch(() => {});
        return;
      }

      const slug = metaFile.path.split('/').pop()?.replace(/\.md$/, '') ?? '';

      const result = await githubCommitFile(
        env,
        metaFile.path,
        metaFile.content,
        `feat(anime): add ${slug}`,
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
            `📄 <code>${escapeHtml(metaFile.path)}</code>\n` +
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

export const publishCommand: CommandDefinition = {
  name: 'publish',
  description: 'Push semua data ke yukionime + yukio-data',
  usage: '/publish',
  adminOnly: true,

  handler: async (ctx, env) => {
    await doPublish(ctx, env);
  },
};