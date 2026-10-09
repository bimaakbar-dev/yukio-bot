// src/commands/track.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { type Bot } from 'grammy';
import type { Env } from '../types/env';
import { escapeHtml } from '../lib/utils';
import {
  deleteTrackedAnime,
  listAllTrackedAnime,
  setTrackedStatus,
  updateTrackedSourceSlug,
  formatScheduleTime,
  isInScheduleWindow,
  type SiteKey,
} from '../lib/cron/state';
import { createTrackSession, getTrackSession } from './track/state';
import { buildSiteKeyboard, buildSitePrompt } from './track/ui';
import {
  handleSitePick,
  handleDayPick,
  handleConfirmSave,
  handleCancel,
  handleTrackTextInput,
} from './track/flow';

export const trackCommand: CommandDefinition = {
  name: 'track',
  description: 'Auto-fetch episode baru dari situs streaming',
  usage: '/track add | list | remove | pause | resume | check | catchup | edit-slug',
  adminOnly: true,

  handler: async (ctx, env) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const parts = arg.split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? '').toLowerCase();
    if (!sub) {
      await ctx.reply(
        '<b>📡 Track Anime</b>\n\n' +
          '<b>Subcommand:</b>\n' +
          '• <code>/track add</code> — daftar anime baru\n' +
          '• <code>/track list</code> — lihat yang di-track\n' +
          '• <code>/track catchup</code> — cek semua anime yang tertinggal\n' +
          '• <code>/track remove &lt;slug&gt;</code> — hapus dari tracking\n' +
          '• <code>/track pause &lt;slug&gt;</code> — pause\n' +
          '• <code>/track resume &lt;slug&gt;</code> — resume\n' +
          '• <code>/track check &lt;slug&gt;</code> — cek manual sekarang\n' +
          '• <code>/track edit-slug &lt;slug&gt; &lt;source_slug&gt;</code> — perbaiki slug situs\n\n' +
          '<i>Bot cek situs setiap hari &amp; auto-push episode baru ke qimochi.</i>',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }
    if (sub === 'add') {
      const userId = ctx.from?.id;
      if (!userId) return;
      const sessionId = await createTrackSession(env.DB, userId);

      await ctx.reply(buildSitePrompt(sessionId), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: buildSiteKeyboard(sessionId),
      });
      return;
    }
    if (sub === 'list') {
      const rows = await listAllTrackedAnime(env.DB);
      if (rows.length === 0) {
        await ctx.reply(
          '📭 Belum ada anime yang di-track.\n\n' +
            '<i>Ketik <code>/track add</code> untuk mulai.</i>',
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
        );
        return;
      }

      const active = rows.filter((r) => r.status === 'active');
      const paused = rows.filter((r) => r.status === 'paused');
      const finished = rows.filter((r) => r.status === 'finished');

      const lines: string[] = [];
      lines.push(`<b>📡 Tracked Anime (${rows.length})</b>`);
      lines.push('');

      if (active.length > 0) {
        lines.push(`<b>🟢 Active (${active.length})</b>`);
        for (const r of active) {
          const chunkInfo =
            r.chunk_start > 0
              ? ` · chunk ${r.chunk_start}-${r.chunk_end}`
              : '';
          const time = formatScheduleTime(r);
          const pending = isInScheduleWindow(r) ? ' ⚠️' : '';
          lines.push(
            `• <code>${escapeHtml(r.slug)}</code>${pending}\n` +
              `  ${r.site} · ${r.schedule_day} ${time} · last ep ${r.last_ep}${chunkInfo}`
          );
        }
        lines.push('');
      }

      if (paused.length > 0) {
        lines.push(`<b>⏸️ Paused (${paused.length})</b>`);
        for (const r of paused) {
          lines.push(`• <code>${escapeHtml(r.slug)}</code> — ${r.site}`);
        }
        lines.push('');
      }

      if (finished.length > 0) {
        lines.push(`<b>✅ Finished (${finished.length})</b>`);
        for (const r of finished) {
          lines.push(
            `• <code>${escapeHtml(r.slug)}</code> — ${r.site} · ${r.last_ep} ep`
          );
        }
      }

      const pendingCount = active.filter(isInScheduleWindow).length;
      if (pendingCount > 0) {
        lines.push('');
        lines.push(
          `<i>⚠️ ${pendingCount} anime tertinggal. Jalankan <code>/track catchup</code>.</i>`
        );
      }

      await ctx.reply(lines.join('\n').trim(), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return;
    }
    if (sub === 'catchup') {
      const loading = await ctx.reply('🔍 Mencari anime yang tertinggal...');

      try {
        const all = await listAllTrackedAnime(env.DB);
        const active = all.filter((r) => r.status === 'active');
        const candidates = active.filter(isInScheduleWindow);

        if (candidates.length === 0) {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            loading.message_id,
            `✅ <b>Semua anime up-to-date.</b>\n\n` +
              `<i>Total aktif: ${active.length} anime, tidak ada yang tertinggal.</i>`,
            {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
            }
          );
          return;
        }

        const MAX_PER_RUN = 5;
        const batch = candidates.slice(0, MAX_PER_RUN);
        const remaining = candidates.length - batch.length;

        const results: { slug: string; pushed: number; error?: string }[] = [];
        let totalPushed = 0;

        for (let i = 0; i < batch.length; i++) {
          const row = batch[i]!;

          await ctx.api
            .editMessageText(
              ctx.chat!.id,
              loading.message_id,
              `🔄 <b>Catch-up</b> [${i + 1}/${batch.length}]\n\n` +
                `🎬 <code>${escapeHtml(row.slug)}</code>\n` +
                `📅 ${row.schedule_day} ${String(row.schedule_hour).padStart(2, '0')}:${String(row.schedule_minute ?? 0).padStart(2, '0')}`,
              {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
              }
            )
            .catch(() => {});

          try {
            const { runManualCheck } = await import('../lib/cron/runner');
            const res = await runManualCheck(env, row.slug);
            totalPushed += res.episodesPushed;
            results.push({
              slug: row.slug,
              pushed: res.episodesPushed,
              error: res.errors.length > 0 ? res.errors[0] : undefined,
            });
          } catch (err: any) {
            results.push({
              slug: row.slug,
              pushed: 0,
              error: err?.message ?? 'unknown',
            });
          }
        }

        const lines: string[] = [];
        lines.push(`✅ <b>Catch-up selesai</b>`);
        lines.push('');
        lines.push(`📼 Total episode di-push: <b>${totalPushed}</b>`);
        lines.push(`🔍 Dicek: <b>${batch.length}</b> anime`);

        const success = results.filter((r) => !r.error);
        const failed = results.filter((r) => r.error);

        if (success.length > 0) {
          lines.push('');
          lines.push(`<b>✅ Sukses (${success.length}):</b>`);
          for (const r of success.slice(0, 10)) {
            lines.push(
              `• <code>${escapeHtml(r.slug)}</code> — ${r.pushed} ep`
            );
          }
        }

        if (failed.length > 0) {
          lines.push('');
          lines.push(`<b>⚠️ Gagal (${failed.length}):</b>`);
          for (const r of failed.slice(0, 5)) {
            lines.push(
              `• <code>${escapeHtml(r.slug)}</code> — <i>${escapeHtml((r.error ?? '').slice(0, 80))}</i>`
            );
          }
        }

        if (remaining > 0) {
          lines.push('');
          lines.push(
            `<i>⏭️ ${remaining} anime lain masih tertinggal. Jalankan /track catchup lagi.</i>`
          );
        }

        await ctx.api.editMessageText(
          ctx.chat!.id,
          loading.message_id,
          lines.join('\n'),
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          }
        );
      } catch (err: any) {
        await ctx.api
          .editMessageText(
            ctx.chat!.id,
            loading.message_id,
            `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
            { parse_mode: 'HTML' }
          )
          .catch(() => {});
      }
      return;
    }
    if (sub === 'remove') {
      const slug = parts[1];
      if (!slug) {
        await ctx.reply('Usage: <code>/track remove &lt;slug&gt;</code>', {
          parse_mode: 'HTML',
        });
        return;
      }
      const ok = await deleteTrackedAnime(env.DB, slug);
      await ctx.reply(
        ok
          ? `✅ <code>${escapeHtml(slug)}</code> dihapus dari tracking.`
          : `❌ Tidak ada: <code>${escapeHtml(slug)}</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    if (sub === 'pause' || sub === 'resume') {
      const slug = parts[1];
      if (!slug) {
        await ctx.reply(`Usage: <code>/track ${sub} &lt;slug&gt;</code>`, {
          parse_mode: 'HTML',
        });
        return;
      }
      const status = sub === 'pause' ? 'paused' : 'active';
      const ok = await setTrackedStatus(env.DB, slug, status);
      await ctx.reply(
        ok
          ? `✅ <code>${escapeHtml(slug)}</code> ${
              sub === 'pause' ? 'di-pause' : 'di-resume'
            }.`
          : `❌ Tidak ada: <code>${escapeHtml(slug)}</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    if (sub === 'edit-slug') {
      const slug = parts[1];
      const newSourceSlug = parts[2];

      if (!slug || !newSourceSlug) {
        await ctx.reply(
          'Usage: <code>/track edit-slug &lt;qimochi_slug&gt; &lt;source_slug_baru&gt;</code>\n\n' +
            '<b>Contoh:</b>\n' +
            '<code>/track edit-slug tensei-goblin-dakedo-shitsumon-aru tensei-goblin-shitsumon-sub-indo</code>',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const ok = await updateTrackedSourceSlug(env.DB, slug, newSourceSlug);
      await ctx.reply(
        ok
          ? `✅ Slug sumber untuk <code>${escapeHtml(slug)}</code> diupdate:\n<code>${escapeHtml(newSourceSlug)}</code>`
          : `❌ Tidak ada: <code>${escapeHtml(slug)}</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    if (sub === 'check') {
      const slug = parts[1];
      if (!slug) {
        await ctx.reply('Usage: <code>/track check &lt;slug&gt;</code>', {
          parse_mode: 'HTML',
        });
        return;
      }

      const loading = await ctx.reply(
        `🔍 Cek <code>${escapeHtml(slug)}</code>...`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );

      try {
        const { runManualCheck } = await import('../lib/cron/runner');
        const result = await runManualCheck(env, slug);

        const lines: string[] = [];
        lines.push(`📡 <b>Manual Check: ${escapeHtml(slug)}</b>`);
        lines.push('');
        lines.push(`🔍 Dicek: <b>${result.animeChecked}</b>`);
        lines.push(`📼 Push: <b>${result.episodesPushed}</b> episode baru`);

        if (result.errors.length > 0) {
          lines.push('');
          lines.push(`⚠️ <b>Error:</b>`);
          for (const e of result.errors) {
            lines.push(`• <code>${escapeHtml(e.slice(0, 200))}</code>`);
          }
        }

        await ctx.api
          .editMessageText(ctx.chat!.id, loading.message_id, lines.join('\n'), {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          })
          .catch(() => {});
      } catch (err: any) {
        await ctx.api
          .editMessageText(
            ctx.chat!.id,
            loading.message_id,
            `❌ <b>Error:</b> <code>${escapeHtml(
              (err?.message ?? 'unknown').slice(0, 300)
            )}</code>`,
            { parse_mode: 'HTML' }
          )
          .catch(() => {});
      }
      return;
    }

    await ctx.reply('❌ Subcommand tidak dikenal. Ketik <code>/track</code>.', {
      parse_mode: 'HTML',
    });
  },
};

export async function handleTrackInput(
  ctx: Context,
  env: Env
): Promise<boolean> {
  return handleTrackTextInput(ctx, env);
}

export function setupTrackCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(
  /^tr:site:(tr_[a-z0-9]+):(lexanime|animesub|samehadaku)$/,
    async (ctx) => {
      const sessionId = ctx.match[1] ?? '';
      const site = (ctx.match[2] ?? '') as SiteKey;
      if (!sessionId) {
        await ctx.answerCallbackQuery({ text: '❌' });
        return;
      }

      const session = await getTrackSession(env.DB, sessionId);
      if (!session) {
        await ctx.answerCallbackQuery({
          text: '⏱️ Kadaluarsa. /track add ulang.',
          show_alert: true,
        });
        return;
      }
      if (ctx.from?.id !== session.user_id) {
        await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
        return;
      }

      await ctx.answerCallbackQuery({ text: site });
      await handleSitePick(ctx, env, session, site);
    }
  );

  bot.callbackQuery(/^tr:day:(tr_[a-z0-9]+):([A-Za-z]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const day = ctx.match[2] ?? '';
    if (!sessionId || !day) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }

    const session = await getTrackSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Kadaluarsa. /track add ulang.',
        show_alert: true,
      });
      return;
    }
    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }

    await ctx.answerCallbackQuery({ text: day });
    await handleDayPick(ctx, env, session, day);
  });

  bot.callbackQuery(/^tr:save:(tr_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }

    const session = await getTrackSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Kadaluarsa. /track add ulang.',
        show_alert: true,
      });
      return;
    }
    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }

    await handleConfirmSave(ctx, env, session);
  });

  bot.callbackQuery(/^tr:x:(tr_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    await handleCancel(ctx, env, sessionId);
  });
}
