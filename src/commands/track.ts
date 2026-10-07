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
  usage: '/track add | list | remove | pause | resume | check | edit-slug',
  adminOnly: true,

  handler: async (ctx, env) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const parts = arg.split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? '').toLowerCase();

    /* ── /track (no arg) ─────────────────────── */
    if (!sub) {
      await ctx.reply(
        '<b>📡 Track Anime</b>\n\n' +
          '<b>Subcommand:</b>\n' +
          '• <code>/track add</code> — daftar anime baru\n' +
          '• <code>/track list</code> — lihat yang di-track\n' +
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

    /* ── /track add ──────────────────────────── */
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

    /* ── /track list ─────────────────────────── */
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
          lines.push(
            `• <code>${escapeHtml(r.slug)}</code>\n` +
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

      await ctx.reply(lines.join('\n').trim(), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    /* ── /track remove <slug> ────────────────── */
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

    /* ── /track pause|resume <slug> ──────────── */
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

    /* ── /track edit-slug <slug> <new_source_slug> ── */
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

    /* ── /track check <slug> ─────────────────── */
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

/* ============================================================
   TEXT INPUT HANDLER (dipanggil dari index.ts)
   ============================================================ */

export async function handleTrackInput(
  ctx: Context,
  env: Env
): Promise<boolean> {
  return handleTrackTextInput(ctx, env);
}

/* ============================================================
   CALLBACK HANDLERS
   ============================================================ */

export function setupTrackCallbacks(bot: Bot, env: Env): void {
  /* Pilih site */
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

  /* Pilih hari */
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

  /* Simpan */
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

  /* Cancel */
  bot.callbackQuery(/^tr:x:(tr_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    await handleCancel(ctx, env, sessionId);
  });
}
