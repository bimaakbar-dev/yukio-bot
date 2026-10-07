// src/commands/post.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import {
  githubCommitMultipleFiles,
  githubCommitFile,
  githubGetFile,
  type FileToCommit,
} from '../lib/github';
import { escapeHtml } from '../lib/utils';
import {
  getLatestTempAnimeByUser,
  deleteTempAnime,
  buildAnimeMarkdown,
} from '../lib/temp-anime';
import {
  getActiveSession,
  deleteBatchSession,
} from '../lib/batch-session';

interface PostItem {
  type: 'md' | 'eps';
  path: string;
  content: string;
  sizeKB: number;
}

interface CollectResult {
  items: PostItem[];
  tempAnimeSession: string | null;
  batchSession: string | null;
}

async function collectPostItems(
  env: Env,
  userId: number,
  slug: string
): Promise<CollectResult> {
  const items: PostItem[] = [];
  let tempAnimeSession: string | null = null;
  let batchSession: string | null = null;

  const tempAnime = await getLatestTempAnimeByUser(env.DB, userId);
  if (tempAnime && tempAnime.slug === slug) {
    const content = buildAnimeMarkdown(tempAnime);
    const path = `src/content/anime/${slug}.md`;
    items.push({
      type: 'md',
      path,
      content,
      sizeKB: Math.max(1, Math.round(content.length / 1024)),
    });
    tempAnimeSession = tempAnime.session_id;
  }

  const batch = await getActiveSession(env.DB, userId);
  if (batch) {
    const batchSlug = batch.chosen_slug ?? batch.slug_hint;
    if (batchSlug === slug) {
      const path = `src/data/anime/${slug}/episodes/${batch.min_ep}-${batch.max_ep}.json`;
      items.push({
        type: 'eps',
        path,
        content: batch.combined_json,
        sizeKB: Math.max(1, Math.round(batch.combined_json.length / 1024)),
      });
      batchSession = batch.session_id;
    }
  }

  return { items, tempAnimeSession, batchSession };
}

async function handlePostCommand(
  ctx: Context,
  env: Env,
  slug: string
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const loading = await ctx.reply(
    `🔍 Cari data untuk slug <code>${escapeHtml(slug)}</code>...`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );

  try {
    const { items } = await collectPostItems(env, userId, slug);

    if (items.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ <b>Tidak ada data untuk slug <code>${escapeHtml(slug)}</code>.</b>\n\n` +
          `Pastikan:\n` +
          `• Sudah <code>/anime &lt;judul&gt;</code> → klik 📋 Convert ke YAML, atau\n` +
          `• Sudah <code>/batch &lt;url&gt; &lt;range&gt;</code> dengan slug yang sama\n\n` +
          `Slug harus <b>sama persis</b> dengan yang muncul di session.`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    const existing: string[] = [];
    for (const item of items) {
      try {
        const ex = await githubGetFile(env, item.path, 'qimochi');
        if (ex) {
          const kb = Math.max(1, Math.round(ex.content.length / 1024));
          existing.push(
            `⚠️ <code>${escapeHtml(item.path)}</code> (${kb} KB → akan di-overwrite)`
          );
        }
      } catch {}
    }

    const lines: string[] = [];
    lines.push(`📋 <b>Preview Post → qimochi</b>`);
    lines.push('');
    lines.push(`🆔 <code>${escapeHtml(slug)}</code>`);
    lines.push('');
    for (const item of items) {
      const label = item.type === 'md' ? '📄 Markdown' : '🎬 Episodes';
      lines.push(
        `• ${label} → <code>${escapeHtml(item.path)}</code> (${item.sizeKB} KB)`
      );
    }
    lines.push('');
    lines.push(`📦 <b>${items.length} file</b>`);
    if (existing.length > 0) {
      lines.push('');
      lines.push('<b>⚠️ File existing:</b>');
      lines.push(...existing);
    } else {
      lines.push('');
      lines.push('✅ Semua file baru.');
    }

    const kb = new InlineKeyboard()
      .text('📤 Post ke qimochi', `po:push:${slug}`)
      .text('❌ Batal', `po:cancel:${slug}`);

    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      lines.join('\n'),
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      }
    );
  } catch (err: any) {
    console.error('[Post] error:', err);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
}

export const postCommand: CommandDefinition = {
  name: 'post',
  description: 'Post final ke qimochi (setelah /anime atau /batch)',
  usage: '/post <slug>',
  adminOnly: true,

  handler: async (ctx, env) => {
    const slug = typeof ctx.match === 'string' ? ctx.match.trim() : '';

    if (!slug) {
      await ctx.reply(
        '<b>📤 Post ke qimochi</b>\n\n' +
          'Push data yang sudah disiapkan ke repo <code>qimochi</code>.\n\n' +
          '<b>Usage:</b>\n' +
          '<code>/post &lt;slug&gt;</code>\n\n' +
          '<b>Contoh:</b>\n' +
          '<code>/post jujutsu-kaisen</code>\n\n' +
          '<i>Sumber data:</i>\n' +
          '• <b>Markdown</b> dari <code>/anime</code> → Convert ke YAML\n' +
          '• <b>Episodes JSON</b> dari <code>/batch</code>\n\n' +
          '<i>Kalau dua-duanya ada dengan slug yang sama, digabung dalam 1 commit.</i>',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    await handlePostCommand(ctx, env, slug);
  },
};

export function setupPostCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^po:push:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    if (!slug) {
      await ctx.answerCallbackQuery({ text: '❌ Slug tidak valid' });
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

    try {
      const { items, tempAnimeSession, batchSession } = await collectPostItems(
        env,
        userId,
        slug
      );

      if (items.length === 0) {
        await ctx
          .editMessageText(
            `❌ Tidak ada data untuk slug <code>${escapeHtml(slug)}</code> (mungkin sudah dihapus / kadaluarsa).`,
            { parse_mode: 'HTML', reply_markup: undefined }
          )
          .catch(() => {});
        return;
      }

      const files: FileToCommit[] = items.map((it) => ({
        path: it.path,
        content: it.content,
        target: 'qimochi',
      }));

      const message = `feat: post ${slug}`;

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
          'qimochi'
        );
      } else {
        result = await githubCommitMultipleFiles(
          env,
          files,
          message,
          'qimochi'
        );
      }

      if (!result.ok) {
        await ctx
          .editMessageText(
            `❌ <b>Gagal push</b>\n\n<code>${escapeHtml((result.error ?? 'unknown').slice(0, 300))}</code>`,
            { parse_mode: 'HTML', reply_markup: undefined }
          )
          .catch(() => {});
        return;
      }

      if (tempAnimeSession) {
        await deleteTempAnime(env.DB, tempAnimeSession);
      }
      if (batchSession) {
        await deleteBatchSession(env.DB, batchSession);
      }

      const commitShort = result.sha?.slice(0, 7) ?? '?';
      const siteUrl = `https://qimochi.pages.dev/anime/${slug}/`;

      const lines: string[] = [];
      lines.push(`✅ <b>Posted ke qimochi!</b>`);
      lines.push('');
      lines.push(`🆔 <code>${escapeHtml(slug)}</code>`);
      lines.push(`📦 ${files.length} file`);
      lines.push(`🔗 Commit: <code>${commitShort}</code>`);
      if (result.commitUrl) {
        lines.push(`<a href="${result.commitUrl}">Lihat commit</a>`);
      }
      lines.push('');
      lines.push(`⏳ Deploy ~2 menit`);
      lines.push(`🌐 <a href="${siteUrl}">${escapeHtml(siteUrl)}</a>`);

      await ctx
        .editMessageText(lines.join('\n'), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: undefined,
        })
        .catch(() => {});
    } catch (err: any) {
      console.error('[Post] push error:', err);
      await ctx
        .editMessageText(
          `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
          { parse_mode: 'HTML', reply_markup: undefined }
        )
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^po:cancel:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageText('❌ <b>Dibatalkan.</b>', {
        parse_mode: 'HTML',
        reply_markup: undefined,
      })
      .catch(() => {});
  });
}