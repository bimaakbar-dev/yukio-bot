// src/commands/franchises.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import { githubCommitFile, githubGetFile } from '../lib/github';
import { chainRelations } from '../services/qimochi-chain-extras';

const TTL_MS = 30 * 60 * 1000;

const HIDDEN_RELATIONS = new Set([
  'character',
  'adaptation',
  'contains',
  'other',
]);

const RELATION_LABEL: Record<string, string> = {
  sequel: 'Sekuel',
  prequel: 'Prekuel',
  side_story: 'Cerita Sampingan',
  parent_story: 'Cerita Induk',
  alternative: 'Versi Alternatif',
  spin_off: 'Spin-off',
  summary: 'Ringkasan',
  full_story: 'Cerita Lengkap',
  compilation: 'Kompilasi',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
          `CREATE TABLE IF NOT EXISTS pending_franchises (
            session_id     TEXT PRIMARY KEY,
            user_id        INTEGER NOT NULL,
            slug           TEXT NOT NULL,
            json_data      TEXT NOT NULL,
            relation_count INTEGER NOT NULL,
            created_at     INTEGER NOT NULL,
            expires_at     INTEGER NOT NULL
          )`
        )
        .run();
      dbReady = true;
    } catch (err) {
      console.error('[Franchises] DB init error:', err);
      dbInitPromise = null;
      throw err;
    }
  })();

  return dbInitPromise;
}

interface PendingRow {
  session_id: string;
  user_id: number;
  slug: string;
  json_data: string;
  relation_count: number;
  created_at: number;
  expires_at: number;
}

async function savePending(
  db: D1Database,
  userId: number,
  slug: string,
  jsonData: string,
  relationCount: number
): Promise<string> {
  await ensureDb(db);
  const sessionId = 'f_' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO pending_franchises
        (session_id, user_id, slug, json_data, relation_count, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(sessionId, userId, slug, jsonData, relationCount, now, now + TTL_MS)
    .run();

  return sessionId;
}

async function getPending(
  db: D1Database,
  sessionId: string
): Promise<PendingRow | null> {
  await ensureDb(db);

  const row = await db
    .prepare('SELECT * FROM pending_franchises WHERE session_id = ?')
    .bind(sessionId)
    .first<PendingRow>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM pending_franchises WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }

  return row;
}

async function deletePending(db: D1Database, sessionId: string): Promise<void> {
  try {
    await ensureDb(db);
    await db
      .prepare('DELETE FROM pending_franchises WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[Franchises] deletePending error:', err);
  }
}

function extractFrontmatterField(
  content: string,
  field: string
): string | null {
  const re = new RegExp(`^${field}:\\s*(.+)$`, 'm');
  const m = content.match(re);
  if (!m || !m[1]) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

async function doPublishFranchises(
  ctx: Context,
  env: Env,
  slug: string
): Promise<void> {
  const loading = await ctx.reply(
    `🔍 Fetch data anime <code>${escapeHtml(slug)}</code>...`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );

  const mdPath = `src/content/anime/${slug}.md`;
  let mdFile: Awaited<ReturnType<typeof githubGetFile>> = null;

  try {
    mdFile = await githubGetFile(env, mdPath);
  } catch (err) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      `❌ Gagal fetch <code>${escapeHtml(mdPath)}</code>: <code>${escapeHtml((err as Error).message.slice(0, 200))}</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (!mdFile) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      `❌ File tidak ditemukan: <code>${escapeHtml(mdPath)}</code>\n\n` +
        `Pastikan anime sudah ada di qimochi.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const malIdStr = extractFrontmatterField(mdFile.content, 'malId');
  const titleStr =
    extractFrontmatterField(mdFile.content, 'title') ?? slug;

  const malId = malIdStr ? parseInt(malIdStr, 10) : NaN;

  if (!malIdStr || isNaN(malId)) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      `❌ Field <code>malId</code> kosong di <code>${escapeHtml(mdPath)}</code>.\n\n` +
        `Tambahkan dulu di frontmatter, contoh:\n<code>malId: 40748</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  await ctx.api.editMessageText(
    ctx.chat!.id,
    loading.message_id,
    `🔍 Fetch relations dari Shikimori (MAL ID: <code>${malId}</code>)...`,
    { parse_mode: 'HTML' }
  );

  let relations: { relation: string; slug: string; title: string }[] = [];

  try {
    const result = await chainRelations({
      malId,
      kitsuId: null,
      title: titleStr,
    });

    if (!result.data || result.data.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `⚠️ Tidak ada relations dari Shikimori.\n\n` +
          `Error: <code>${escapeHtml(result.errors.join('; ').slice(0, 300))}</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    relations = result.data;
  } catch (err) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      `❌ Gagal fetch relations: <code>${escapeHtml((err as Error).message.slice(0, 200))}</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const filtered = relations.filter((r) => !HIDDEN_RELATIONS.has(r.relation));
  const hidden = relations.filter((r) => HIDDEN_RELATIONS.has(r.relation));

  if (filtered.length === 0) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      `⚠️ Semua relation (${relations.length}) tidak relevan setelah filter.\n\n` +
        `<b>Difilter:</b>\n` +
        hidden
          .slice(0, 10)
          .map((r) => `• <code>${escapeHtml(r.relation)}</code> → ${escapeHtml(r.slug)}`)
          .join('\n'),
      { parse_mode: 'HTML' }
    );
    return;
  }

  const jsonData = JSON.stringify(filtered, null, 2) + '\n';

  if (!ctx.from?.id) return;

  const sessionId = await savePending(
    env.DB,
    ctx.from.id,
    slug,
    jsonData,
    filtered.length
  );

  const targetPath = `src/data/anime/${slug}/franchises.json`;

  const previewLines = filtered.map((r, i) => {
    const label = RELATION_LABEL[r.relation] ?? r.relation;
    return `${i + 1}. <b>${escapeHtml(label)}</b> → <code>${escapeHtml(r.slug)}</code>`;
  });

  const text =
    `📋 <b>Franchise: ${escapeHtml(titleStr)}</b>\n\n` +
    `🎬 <b>${filtered.length} relation</b> siap di-publish:\n` +
    previewLines.join('\n') +
    (hidden.length > 0
      ? `\n\n⏭️ <i>Difilter (${hidden.length}): ${hidden.map((r) => r.relation).join(', ')}</i>`
      : '') +
    `\n\n📁 Target:\n<code>${escapeHtml(targetPath)}</code>\n` +
    `📏 Size: ${Math.round(jsonData.length / 1024)} KB`;

  const kb = new InlineKeyboard()
    .text('📤 Push ke GitHub', `pf:push:${sessionId}`)
    .text('❌ Batal', `pf:cancel:${sessionId}`);

  await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

export function setupFranchisesCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^pf:push:(f_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }

    const pending = await getPending(env.DB, sessionId);

    if (!pending) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Kadaluarsa. Ulangi /publish_franchises.',
        show_alert: true,
      });
      return;
    }

    if (ctx.from?.id !== pending.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

    const targetPath = `src/data/anime/${pending.slug}/franchises.json`;

    const result = await githubCommitFile(
      env,
      targetPath,
      pending.json_data,
      `feat(franchises): add for ${pending.slug}`
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

    await deletePending(env.DB, sessionId);

    const commitShort = result.sha?.slice(0, 7) ?? '?';

    await ctx
      .editMessageText(
        `✅ <b>Published!</b>\n\n` +
          `📁 <code>${escapeHtml(targetPath)}</code>\n` +
          `📊 ${pending.relation_count} relation\n` +
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

  bot.callbackQuery(/^pf:cancel:(f_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (sessionId) await deletePending(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageText('❌ <b>Dibatalkan.</b>', {
        parse_mode: 'HTML',
        reply_markup: undefined,
      })
      .catch(() => {});
  });
}

export const publishFranchisesCommand: CommandDefinition = {
  name: 'publish_franchises',
  description: 'Push franchises dari Shikimori ke qimochi',
  usage: '/publish_franchises <slug>',
  adminOnly: true,

  handler: async (ctx, env) => {
    const slug = typeof ctx.match === 'string' ? ctx.match.trim() : '';

    if (!slug) {
      await ctx.reply(
        '<b>📋 Publish Franchises</b>\n\n' +
          '<b>Usage:</b>\n' +
          '<code>/publish_franchises &lt;slug&gt;</code>\n\n' +
          '<b>Contoh:</b>\n' +
          '<code>/publish_franchises yozakura-san-chi-no-daisakusen-2nd-season</code>\n\n' +
          '<i>Bot fetch relations dari Shikimori → push ke src/data/anime/{slug}/franchises.json</i>',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    await doPublishFranchises(ctx, env, slug);
  },
};