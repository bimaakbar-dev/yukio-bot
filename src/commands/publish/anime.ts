// src/commands/publish/anime.ts
import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Env } from '../../types/env';
import type { CommandDefinition } from '../registry';
import { githubCommitFile, githubGetFile } from '../../lib/github';
import { escapeHtml } from '../../lib/utils';
import {
  getTempAnime,
  getLatestTempAnimeByUser,
  deleteTempAnime,
  buildAnimeMarkdown,
} from '../../lib/temp-anime';

export async function doPublishAnime(
  ctx: Context,
  env: Env,
  sessionId: string,
  force: boolean
): Promise<void> {
  const session = await getTempAnime(env.DB, sessionId);
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
  const content = buildAnimeMarkdown(session);

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
          `<b>Preview lama:</b>\n` +
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

  await deleteTempAnime(env.DB, sessionId);

  const commitShort = result.sha?.slice(0, 7) ?? '?';

  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      loadingMsg.message_id,
      `✅ <b>Published!</b>\n\n` +
        `📁 <code>${escapeHtml(path)}</code>\n` +
        `🔗 Commit: <code>${commitShort}</code>\n` +
        `⏳ Deploy: ~2 menit`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    )
    .catch(() => {});
}

export const publishAnimeCommand: CommandDefinition = {
  name: 'publish_anime',
  description: 'Push metadata anime ke qimochi',
  usage: '/publish_anime [slug]',
  adminOnly: true,

  handler: async (ctx, env) => {
    const argSlug = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const userId = ctx.from?.id;
    if (!userId) return;

    const row = await getLatestTempAnimeByUser(env.DB, userId);

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
    const content = buildAnimeMarkdown({ ...row, slug });

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

    await deleteTempAnime(env.DB, row.session_id);

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