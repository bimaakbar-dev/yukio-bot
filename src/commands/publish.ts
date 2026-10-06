// src/commands/publish.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import { githubCommitFile, githubGetFile } from '../lib/github';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    if (!row) return null;
    return row;
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

/**
 * Bangun markdown final dari session.
 */
function buildMarkdown(session: SessionRow): string {
  const body = session.body.trim();
  return `${session.yaml}\n\n${body}\n`;
}

/**
 * Proses push ke GitHub — dipakai untuk callback `pub:an:*` dan `pub:anforce:*`.
 */
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

  // Cek existing
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
          `📏 Ukuran lama: <b>${existing.content.length}</b> char\n` +
          `📏 Ukuran baru: <b>${content.length}</b> char\n\n` +
          `<b>Preview lama (300 char pertama):</b>\n` +
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

  // Push!
  await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

  const loadingMsg = await ctx.reply(
    `📤 <b>Push ke GitHub...</b>\n\n` +
      `📁 <code>${escapeHtml(path)}</code>\n` +
      `📏 ${content.length} char`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );

  const commitMsg = `feat: add anime ${slug}`;
  const result = await githubCommitFile(env, path, content, commitMsg);

  if (!result.ok) {
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        `❌ <b>Gagal push</b>\n\n` +
          `<code>${escapeHtml(result.error ?? 'unknown')}</code>\n\n` +
          `<i>Cek token, repo, atau branch.</i>`,
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
        (result.commitUrl
          ? `<a href="${result.commitUrl}">Lihat commit</a>\n`
          : '') +
        `🌐 <a href="${siteUrl}">${escapeHtml(siteUrl)}</a>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    )
    .catch(() => {});
}

/**
 * Setup callback untuk tombol Publish dari /anime.
 */
export function setupPublishCallbacks(bot: Bot, env: Env): void {
  // Publish anime (tanpa force)
  bot.callbackQuery(/^pub:an:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌ Session invalid' });
      return;
    }
    await doPublishAnime(ctx, env, sessionId, false);
  });

  // Publish anime (force overwrite)
  bot.callbackQuery(/^pub:anforce:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌ Session invalid' });
      return;
    }
    await doPublishAnime(ctx, env, sessionId, true);
  });

  // Skip / batal
  bot.callbackQuery(/^pub:skip:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (sessionId) {
      await deleteSession(env.DB, sessionId);
    }
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageReplyMarkup({ reply_markup: undefined })
      .catch(() => {});
    await ctx.reply('❌ <b>Dibatalkan.</b>', { parse_mode: 'HTML' }).catch(() => {});
  });
}

/**
 * Command /publish-anime [slug]
 * Push session /anime terbaru tanpa lewat tombol.
 */
export const publishAnimeCommand: CommandDefinition = {
  name: 'publish-anime',
  description: 'Push metadata anime ke repo web',
  usage: '/publish-anime [slug]',
  adminOnly: true,

  handler: async (ctx, env) => {
    const argSlug = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const userId = ctx.from?.id;
    if (!userId) return;

    // Ambil session terbaru user
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

    // Kalau user kasih slug manual, override
    const slug = argSlug || row.slug;
    if (!slug) {
      await ctx.reply(
        '❌ Session tidak punya slug. Kirim slug manual:\n' +
          '<code>/publish-anime my-slug-here</code>',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const path = `src/content/anime/${slug}.md`;
    const content = buildMarkdown({ ...row, slug });

    const loading = await ctx.reply(
      `📤 <b>Push ke GitHub...</b>\n\n` +
        `📁 <code>${escapeHtml(path)}</code>\n` +
        `📏 ${content.length} char`,
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
          `❌ <b>Gagal push</b>\n\n` +
            `<code>${escapeHtml(result.error ?? 'unknown')}</code>`,
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