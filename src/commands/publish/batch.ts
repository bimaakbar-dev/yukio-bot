// src/commands/publish/batch.ts
import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Env } from '../../types/env';
import type { CommandDefinition } from '../registry';
import { githubCommitFile, githubGetFile } from '../../lib/github';
import { escapeHtml } from '../../lib/utils';
import {
  getBatchSession,
  updateBatchChosenSlug,
  updateBatchSuggestions,
  deleteBatchSession,
  resetBatchSessions,
  findSimilarSlugs,
} from '../../lib/batch-session';

export async function doPublishBatchInitial(
  ctx: Context,
  env: Env,
  sessionId: string
): Promise<void> {
  const session = await getBatchSession(env.DB, sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({
      text: '⏱️ Batch kadaluarsa. Ulangi /batch.',
      show_alert: true,
    });
    return;
  }

  if (ctx.from?.id !== session.user_id) {
    await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
    return;
  }

  await ctx.answerCallbackQuery({ text: '🔍 Cari slug...' });

  const slugHint = session.slug_hint ?? '';
  const suggestions = slugHint ? await findSimilarSlugs(env, slugHint) : [];

  await updateBatchSuggestions(
    env.DB,
    sessionId,
    suggestions.map((s) => s.slug)
  );

  const lines: string[] = [];
  lines.push(`📦 <b>Publish Batch</b>`);
  lines.push('');
  lines.push(`🎬 <code>${escapeHtml(slugHint || '(slug hint kosong)')}</code>`);
  lines.push(`📊 <b>${session.min_ep}-${session.max_ep}</b>`);
  if (session.total_urls) lines.push(`🎬 URL: <b>${session.total_urls}</b>`);
  lines.push('');

  const kb = new InlineKeyboard();

  if (suggestions.length > 0) {
    lines.push('🔍 <b>Slug mirip di repo:</b>');
    suggestions.forEach((s, i) => {
      const pct = Math.round(s.score * 100);
      lines.push(`${i + 1}. <code>${escapeHtml(s.slug)}</code> (${pct}%)`);
      const label = s.slug.length > 26 ? s.slug.slice(0, 24) + '…' : s.slug;
      kb.text(`📁 ${label} (${pct}%)`, `pub:bp:${sessionId}:${i}`).row();
    });
    lines.push('');
  } else {
    lines.push('⚠️ Tidak ada slug mirip di repo.');
    lines.push('');
  }

  if (slugHint) {
    kb.text('✨ Pakai slug dari URL', `pub:bp:${sessionId}:url`).row();
  }
  kb.text('✏️ Custom slug', `pub:bp:${sessionId}:custom`).row();
  kb.text('❌ Batal', `pub:bax:${sessionId}`);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

export async function doPublishBatchPickSlug(
  ctx: Context,
  env: Env,
  sessionId: string,
  pick: string
): Promise<void> {
  const session = await getBatchSession(env.DB, sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: '⏱️ Batch kadaluarsa' });
    return;
  }

  let slug: string | null = null;

  if (pick === 'url') {
    slug = session.slug_hint;
  } else if (pick === 'custom') {
    await ctx.answerCallbackQuery({ text: '✏️ Kirim slug manual' });
    await ctx.reply(
      `✏️ Kirim slug baru via command:\n\n` +
        `<code>/publish_batch ${sessionId} slug-baru-kamu</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  } else {
    const idx = parseInt(pick, 10);
    let arr: string[] = [];
    try {
      arr = session.suggestions
        ? (JSON.parse(session.suggestions) as string[])
        : [];
    } catch {
      arr = [];
    }
    slug = arr[idx] ?? null;
  }

  if (!slug) {
    await ctx.answerCallbackQuery({ text: '❌ Slug tidak valid' });
    return;
  }

  await updateBatchChosenSlug(env.DB, sessionId, slug);
  await ctx.answerCallbackQuery({ text: `✅ ${slug.slice(0, 30)}` });

  await doPublishBatchPreview(ctx, env, sessionId, slug);
}

export async function doPublishBatchPreview(
  ctx: Context,
  env: Env,
  sessionId: string,
  slug: string
): Promise<void> {
  const session = await getBatchSession(env.DB, sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: '⏱️ Batch kadaluarsa' });
    return;
  }

  const path = `src/data/anime/${slug}/episodes/${session.min_ep}-${session.max_ep}.json`;
  const sizeKB = Math.round(session.combined_json.length / 1024);

  let episodes: { number: number }[] = [];
  try {
    episodes = JSON.parse(session.combined_json) as { number: number }[];
  } catch {
    episodes = [];
  }

  const episodeCount = episodes.length;
  const rangeExpected = session.max_ep - session.min_ep + 1;
  const hasGap = episodeCount !== rangeExpected;

  let existing: Awaited<ReturnType<typeof githubGetFile>> = null;
  try {
    existing = await githubGetFile(env, path);
  } catch {}

  const lines: string[] = [];
  lines.push(`📋 <b>Preview Publish</b>`);
  lines.push('');
  lines.push(`📁 <code>${escapeHtml(path)}</code>`);
  lines.push(`📏 ${sizeKB} KB`);
  lines.push(`📊 ${episodeCount} episode (Ep ${session.min_ep}-${session.max_ep})`);
  if (hasGap) {
    lines.push(
      `⚠️ <i>Ada gap — hanya ${episodeCount} dari ${rangeExpected} episode.</i>`
    );
  }
  if (session.total_urls) lines.push(`🎬 URL: <b>${session.total_urls}</b>`);
  lines.push('');

  if (existing) {
    lines.push(
      `⚠️ <b>File sudah ada!</b> (${Math.round(existing.content.length / 1024)} KB)`
    );
    lines.push('Akan di-overwrite.');
  } else {
    lines.push('✅ File baru.');
  }

  const kb = new InlineKeyboard()
    .text('📤 Push ke GitHub', `pub:bpush:${sessionId}`)
    .text('❌ Batal', `pub:bax:${sessionId}`);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

export async function doPublishBatchPush(
  ctx: Context,
  env: Env,
  sessionId: string
): Promise<void> {
  const session = await getBatchSession(env.DB, sessionId);
  if (!session || !session.chosen_slug) {
    await ctx.answerCallbackQuery({
      text: '⏱️ Batch kadaluarsa atau slug belum dipilih',
      show_alert: true,
    });
    return;
  }

  const slug = session.chosen_slug;
  const path = `src/data/anime/${slug}/episodes/${session.min_ep}-${session.max_ep}.json`;

  await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

  const loading = await ctx.reply(
    `📤 <b>Push ke GitHub...</b>\n\n📁 <code>${escapeHtml(path)}</code>`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );

  const commitMsg = `feat: add episodes ${session.min_ep}-${session.max_ep} for ${slug}`;
  const result = await githubCommitFile(
    env,
    path,
    session.combined_json,
    commitMsg
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

  await deleteBatchSession(env.DB, sessionId);

  const commitShort = result.sha?.slice(0, 7) ?? '?';
  const siteUrl = `https://qimochi.pages.dev/anime/${slug}/`;

  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      loading.message_id,
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

export const publishBatchCommand: CommandDefinition = {
  name: 'publish_batch',
  description: 'Push batch episode ke repo web',
  usage: '/publish_batch [session_id] [slug]',
  adminOnly: true,

  handler: async (ctx, env) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const parts = arg.split(/\s+/).filter(Boolean);

    if (parts.length === 2 && parts[0] && parts[1]) {
      const sessionId = parts[0];
      const customSlug = parts[1];
      const session = await getBatchSession(env.DB, sessionId);
      if (!session) {
        await ctx.reply('❌ Session batch tidak ditemukan / kadaluarsa.');
        return;
      }
      if (session.user_id !== ctx.from?.id) {
        await ctx.reply('⛔ Bukan sesi Anda.');
        return;
      }

      await updateBatchChosenSlug(env.DB, sessionId, customSlug);
      await doPublishBatchPreview(ctx, env, sessionId, customSlug);
      return;
    }

    await ctx.reply(
      '<b>📦 Publish Batch</b>\n\n' +
        '<b>Auto:</b> dari tombol di akhir <code>/batch</code>\n\n' +
        '<b>Manual:</b>\n' +
        '<code>/publish_batch &lt;session_id&gt; &lt;slug&gt;</code>\n\n' +
        '<i>Session ID ada di pesan batch selesai.</i>',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
  },
};

export const batchResetCommand: CommandDefinition = {
  name: 'batch_reset',
  description: 'Hapus semua session batch aktif',
  adminOnly: true,

  handler: async (ctx, env) => {
    if (!ctx.from?.id) return;
    const count = await resetBatchSessions(env.DB, ctx.from.id);
    if (count === 0) {
      await ctx.reply('📭 Tidak ada session batch aktif.');
      return;
    }
    await ctx.reply(`✅ <b>${count}</b> session batch dihapus.`, {
      parse_mode: 'HTML',
    });
  },
};