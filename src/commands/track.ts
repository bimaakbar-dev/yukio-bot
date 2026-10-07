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
  type SiteKey,
} from '../lib/cron/state';
import {
  createTrackSession,
  getTrackSession,
  updateTrackSession,
} from './track/state';
import {
  buildSiteKeyboard,
  buildSitePrompt,
} from './track/ui';
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
  usage: '/track add | list | remove | pause | resume',
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
          '• <code>/track remove &lt;slug&gt;</code> — hapus dari tracking\n' +
          '• <code>/track pause &lt;slug&gt;</code> — pause\n' +
          '• <code>/track resume &lt;slug&gt;</code> — resume\n' +
          '• <code>/track check &lt;slug&gt;</code> — cek manual (coming soon)\n\n' +
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
          lines.push(
            `• <code>${escapeHtml(r.slug)}</code>\n` +
              `  ${r.site} · ${r.schedule_day} ${String(r.schedule_hour).padStart(2, '0')}:00 · last ep ${r.last_ep}${chunkInfo}`
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

      await ctx.reply(lines.join('\n').trim(), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
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
          ? `✅ <code>${escapeHtml(slug)}</code> ${sub === 'pause' ? 'di-pause' : 'di-resume'}.`
          : `❌ Tidak ada: <code>${escapeHtml(slug)}</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (sub === 'check') {
      await ctx.reply(
        '🚧 <i>Manual check akan tersedia di Fase B.</i>',
        { parse_mode: 'HTML' }
      );
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
    /^tr:site:(tr_[a-z0-9]+):(lexanime|animesub)$/,
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
