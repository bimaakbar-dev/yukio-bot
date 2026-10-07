// src/commands/publish/callbacks.ts
import { type Bot } from 'grammy';
import type { Env } from '../../types/env';
import { escapeHtml, slugify } from '../../lib/utils';
import {
  githubCommitFile,
  githubCommitMultipleFiles,
  type FileToCommit,
  type RepoTarget,
} from '../../lib/github';
import { getLatestSessionByUser } from '../../lib/dba-session';
import { deleteTempAnime } from '../../lib/temp-anime';
import { deleteBatchSession, getBatchSession } from '../../lib/batch-session';
import { doPublishAnime } from './anime';
import {
  doPublishBatchInitial,
  doPublishBatchPickSlug,
  doPublishBatchPush,
} from './batch';
import {
  deletePendingPublish,
  getPendingPublish,
  updatePendingSelected,
} from './state';
import { buildPreviewLines, buildPreviewKeyboard } from './preview';
import {
  ALL_SECTIONS,
  emptySummary,
  sectionFromPath,
  type PublishSummary,
  type SectionKey,
} from './types';

export function setupPublishCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^pub:an:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishAnime(ctx, env, sessionId, false);
  });

  bot.callbackQuery(/^pub:anforce:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishAnime(ctx, env, sessionId, true);
  });

  bot.callbackQuery(/^pub:skip:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (sessionId) await deleteTempAnime(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageReplyMarkup({ reply_markup: undefined })
      .catch(() => {});
    await ctx
      .reply('❌ <b>Dibatalkan.</b>', { parse_mode: 'HTML' })
      .catch(() => {});
  });

  bot.callbackQuery(/^pub:ba:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishBatchInitial(ctx, env, sessionId);
  });

  bot.callbackQuery(/^pub:bp:(b_[a-z0-9]+):(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const pick = ctx.match[2] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishBatchPickSlug(ctx, env, sessionId, pick);
  });

  bot.callbackQuery(/^pub:bpush:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishBatchPush(ctx, env, sessionId);
  });

  bot.callbackQuery(/^pub:bax:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (sessionId) await deleteBatchSession(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageReplyMarkup({ reply_markup: undefined })
      .catch(() => {});
    await ctx
      .reply('❌ <b>Batch dibatalkan.</b>', { parse_mode: 'HTML' })
      .catch(() => {});
  });

  bot.callbackQuery(/^pub:baadd:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }

    const session = await getBatchSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: '⏱️ Batch kadaluarsa' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '➕ Kirim /batch lagi' });

    await ctx.reply(
      `➕ <b>Tambah Batch</b>\n\n` +
        `Session aktif:\n` +
        `<code>${sessionId}</code>\n\n` +
        `📊 Sekarang: <b>${session.min_ep}-${session.max_ep}</b>\n` +
        (session.slug_hint
          ? `🎬 <code>${escapeHtml(session.slug_hint)}</code>\n`
          : '') +
        `\nKirim <code>/batch &lt;url&gt; &lt;range&gt;</code> lagi.\n` +
        `Episode yang sudah ada akan otomatis di-skip.`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
  });

  bot.callbackQuery(
    /^pp:t:(pp_[a-z0-9]+):(meta|chars|eps|fr|va)$/,
    async (ctx) => {
      try {
        const pendingId = ctx.match[1] ?? '';
        const section = (ctx.match[2] ?? '') as SectionKey;

        if (!pendingId || !ALL_SECTIONS.includes(section)) {
          await ctx.answerCallbackQuery({ text: '❌' });
          return;
        }

        const pending = await getPendingPublish(env.DB, pendingId);
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

        let selected: SectionKey[] = [];
        try {
          if (pending.selected_json) {
            selected = JSON.parse(pending.selected_json) as SectionKey[];
          }
        } catch {
          selected = [];
        }

        const set = new Set(selected);
        if (set.has(section)) {
          set.delete(section);
        } else {
          set.add(section);
        }

        const newSelected = ALL_SECTIONS.filter((s) => set.has(s));
        await updatePendingSelected(env.DB, pendingId, newSelected);

        let summary: PublishSummary;
        try {
          summary = JSON.parse(pending.summary_json) as PublishSummary;
        } catch {
          summary = emptySummary();
        }

        const session = await getLatestSessionByUser(env.DB, pending.user_id);
        const title = session?.title ?? 'unknown';
        const slug = session ? slugify(session.title) : 'unknown';

        const previewText = buildPreviewLines(title, slug, summary, set);
        const kb = buildPreviewKeyboard(pendingId, summary, set);

        await ctx.answerCallbackQuery({
          text: set.has(section) ? `✅ ${section} on` : `⬜ ${section} off`,
        });

        await ctx
          .editMessageText(previewText, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: kb,
          })
          .catch(() => {});
      } catch (err: any) {
        console.error('[Publish] toggle error:', err);
        await ctx
          .answerCallbackQuery({ text: '❌ Gagal toggle' })
          .catch(() => {});
      }
    }
  );

  bot.callbackQuery(/^pp:push:(pp_[a-z0-9]+)$/, async (ctx) => {
    try {
      const pendingId = ctx.match[1] ?? '';
      if (!pendingId) {
        await ctx.answerCallbackQuery({ text: '❌' });
        return;
      }

      const pending = await getPendingPublish(env.DB, pendingId);
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

      let selected: SectionKey[] = [];
      try {
        if (pending.selected_json) {
          selected = JSON.parse(pending.selected_json) as SectionKey[];
        }
      } catch {
        selected = [];
      }

      if (selected.length === 0) {
        await ctx.answerCallbackQuery({
          text: '❌ Tidak ada section dipilih.',
          show_alert: true,
        });
        return;
      }

      await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

      let allFiles: FileToCommit[] = [];
      try {
        allFiles = JSON.parse(pending.files_json) as FileToCommit[];
      } catch {
        allFiles = [];
      }

      const selectedSet = new Set(selected);
      const files = allFiles.filter((f) =>
        selectedSet.has(sectionFromPath(f.path))
      );

      if (files.length === 0) {
        await ctx.reply('❌ Tidak ada file untuk di-push.').catch(() => {});
        return;
      }

      const slug =
        files
          .map(
            (f) =>
              f.path.match(/^data\/anime\/([^/]+)\//)?.[1] ??
              f.path.match(/^src\/content\/anime\/(.+)\.md$/)?.[1]
          )
          .find((s): s is string => !!s) ?? 'unknown';

      const message = `feat: publish data for ${slug}`;

      const groups = new Map<RepoTarget, FileToCommit[]>();
      for (const f of files) {
        const target = f.target ?? 'qimochi';
        if (!groups.has(target)) groups.set(target, []);
        groups.get(target)!.push(f);
      }

      const results: {
        target: RepoTarget;
        ok: boolean;
        sha?: string;
        count: number;
        error?: string;
      }[] = [];

      for (const [target, groupFiles] of groups) {
        let r: {
          ok: boolean;
          sha?: string;
          commitUrl?: string;
          error?: string;
        };

        if (groupFiles.length === 1) {
          const f = groupFiles[0]!;
          if (f.content === null) {
            r = await githubCommitMultipleFiles(
              env,
              groupFiles,
              message,
              target
            );
          } else {
            r = await githubCommitFile(
              env,
              f.path,
              f.content,
              message,
              target
            );
          }
        } else {
          r = await githubCommitMultipleFiles(env, groupFiles, message, target);
        }

        results.push({
          target,
          ok: r.ok,
          sha: r.sha,
          count: groupFiles.length,
          error: r.error,
        });
      }

      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;

      if (okCount === 0) {
        const errLines: string[] = ['❌ <b>Gagal push semua</b>', ''];
        for (const r of results) {
          errLines.push(
            `• <b>${r.target}</b>: <code>${escapeHtml((r.error ?? 'unknown').slice(0, 200))}</code>`
          );
        }
        await ctx
          .editMessageText(errLines.join('\n'), {
            parse_mode: 'HTML',
            reply_markup: undefined,
          })
          .catch(() => {});
        return;
      }

      if (failCount === 0) {
        await deletePendingPublish(env.DB, pendingId);
      }

      const lines: string[] = [];
      lines.push(
        failCount === 0
          ? `✅ <b>Published!</b>`
          : `⚠️ <b>Publish sebagian</b> (${okCount}/${results.length})`
      );
      lines.push('');

      for (const r of results) {
        const status = r.ok ? '✅' : '❌';
        const short = r.sha?.slice(0, 7) ?? '?';
        lines.push(
          `${status} <b>${r.target}</b> — ${r.count} file` +
            (r.ok
              ? ` · <code>${short}</code>`
              : ` · <i>${escapeHtml((r.error ?? 'unknown').slice(0, 100))}</i>`)
        );
      }

      if (failCount === 0) {
        lines.push('');
        lines.push(`⏳ Deploy ~2 menit`);
      } else {
        lines.push('');
        lines.push(
          `<i>Yang sukses tidak di-rollback. Ulangi /publish untuk retry yang gagal.</i>`
        );
      }

      await ctx
        .editMessageText(lines.join('\n'), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: undefined,
        })
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
    if (pendingId) await deletePendingPublish(env.DB, pendingId);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageText('❌ <b>Dibatalkan.</b>', {
        parse_mode: 'HTML',
        reply_markup: undefined,
      })
      .catch(() => {});
  });
}
