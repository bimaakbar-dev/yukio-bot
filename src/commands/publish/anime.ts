// src/commands/publish/anime.ts
import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Env } from '../../types/env';
import type { AniListMedia } from '../../types/anime';
import type { CommandDefinition } from '../registry';
import {
  githubCommitFile,
  githubCommitMultipleFiles,
  githubGetFile,
  type FileToCommit,
} from '../../lib/github';
import { escapeHtml } from '../../lib/utils';
import { safeFetch } from '../../lib/dba-common';
import { filterFranchises } from '../../lib/franchises';
import { chainRelations } from '../../services/qimochi-chain-extras';
import {
  getTempAnime,
  getLatestTempAnimeByUser,
  deleteTempAnime,
  buildAnimeMarkdown,
} from '../../lib/temp-anime';
import { RELATION_FETCH_TIMEOUT_MS } from './types';

async function pushAnime(
  ctx: Context,
  env: Env,
  sessionId: string,
  force: boolean,
  withFranchises: boolean
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

  const mdPath = `src/content/anime/${slug}.md`;
  const mdContent = buildAnimeMarkdown(session);

  if (!force) {
    let existing: Awaited<ReturnType<typeof githubGetFile>> = null;
    try {
      existing = await githubGetFile(env, mdPath, 'qimochi');
    } catch (err) {
      console.warn('[Publish] getFile failed:', err);
    }

    if (existing) {
      const previewOld = existing.content.slice(0, 300);
      await ctx.answerCallbackQuery({ text: '⚠️ File sudah ada' });

      const confirmId = withFranchises ? 'pub:anallforce' : 'pub:anforce';

      const kb = new InlineKeyboard()
        .text('✅ Overwrite', `${confirmId}:${sessionId}`)
        .text('❌ Batal', `pub:skip:${sessionId}`);

      await ctx.reply(
        `⚠️ <b>File sudah ada di repo!</b>\n\n` +
          `📁 <code>${escapeHtml(mdPath)}</code>\n` +
          `📏 Lama: <b>${existing.content.length}</b> char\n` +
          `📏 Baru: <b>${mdContent.length}</b> char\n\n` +
          `<b>Preview lama:</b>\n` +
          `<pre>${escapeHtml(previewOld)}</pre>\n\n` +
          `Overwrite${withFranchises ? ' + push franchises' : ''}?`,
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

  const loading = await ctx.reply(
    withFranchises
      ? `📤 <b>Fetch franchises + push...</b>\n\n🆔 <code>${escapeHtml(slug)}</code>`
      : `📤 <b>Push ke GitHub...</b>\n\n📁 <code>${escapeHtml(mdPath)}</code>`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );

  const files: FileToCommit[] = [];
  const notes: string[] = [];

  files.push({
    path: mdPath,
    content: mdContent,
    target: 'qimochi',
  });
  notes.push('📄 Markdown');

  if (withFranchises) {
    let malId: number | null = null;
    if (session.metadata_json) {
      try {
        const media = JSON.parse(session.metadata_json) as AniListMedia;
        malId = media.myanimelistId ?? null;
      } catch {}
    }

    if (malId) {
      const { data: result } = await safeFetch(
        () =>
          chainRelations({
            malId: malId!,
            kitsuId: null,
            title: session.slug ?? slug,
          }),
        RELATION_FETCH_TIMEOUT_MS
      );

      if (result && result.data && result.data.length > 0) {
        const filtered = filterFranchises(result.data);
        if (filtered.length > 0) {
          files.push({
            path: `src/data/anime/${slug}/franchises.json`,
            content: JSON.stringify(filtered, null, 2) + '\n',
            target: 'qimochi',
          });
          notes.push(`🔗 Franchises (${filtered.length} relation)`);
        }
      }
    }
  }

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
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ <b>Gagal push</b>\n\n<code>${escapeHtml(result.error ?? 'unknown')}</code>`,
        { parse_mode: 'HTML', reply_markup: undefined }
      )
      .catch(() => {});
    return;
  }

  await deleteTempAnime(env.DB, sessionId);

  const commitShort = result.sha?.slice(0, 7) ?? '?';
  const siteUrl = `https://qimochi.pages.dev/anime/${slug}/`;

  const lines: string[] = [];
  lines.push(
    withFranchises
      ? `✅ <b>Posted ke qimochi!</b>`
      : `✅ <b>Published!</b>`
  );
  lines.push('');
  lines.push(`🆔 <code>${escapeHtml(slug)}</code>`);
  lines.push(`📦 ${files.length} file`);
  for (const n of notes) lines.push(`• ${n}`);
  lines.push(`🔗 Commit: <code>${commitShort}</code>`);
  if (result.commitUrl) {
    lines.push(`<a href="${result.commitUrl}">Lihat commit</a>`);
  }
  lines.push('');
  lines.push(`⏳ Deploy ~2 menit`);
  if (withFranchises) {
    lines.push(`🌐 <a href="${siteUrl}">${escapeHtml(siteUrl)}</a>`);
  }

  await ctx.api
    .editMessageText(ctx.chat!.id, loading.message_id, lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: undefined,
    })
    .catch(() => {});
}

export async function doPublishAnime(
  ctx: Context,
  env: Env,
  sessionId: string,
  force: boolean
): Promise<void> {
  await pushAnime(ctx, env, sessionId, force, false);
}

export async function doPublishAnimeAll(
  ctx: Context,
  env: Env,
  sessionId: string,
  force: boolean
): Promise<void> {
  await pushAnime(ctx, env, sessionId, force, true);
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