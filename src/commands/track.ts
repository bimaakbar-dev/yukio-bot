// src/commands/track.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import { escapeHtml } from '../lib/utils';
import { githubGetFile } from '../lib/github';
import {
  deleteTrackedAnime,
  listAllTrackedAnime,
  setTrackedStatus,
  type SiteKey,
  type TrackedAnimeRow,
} from '../lib/cron/state';
import {
  createTrackSession,
  getTrackSession,
  updateTrackSession,
  deleteTrackSession,
} from './track/state';
import { buildSiteKeyboard, buildDayKeyboard, buildSummaryKeyboard } from './track/ui';
import { handleTrackTextInput, showTrackSummary } from './track/flow';

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
          '• <code>/track check &lt;slug&gt;</code> — cek manual sekarang\n\n' +
          '<i>Bot akan cek situs setiap hari dan auto-push episode baru ke qimochi.</i>',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }
    if (sub === 'add') {
      const userId = ctx.from?.id;
      if (!userId) return;
      const sessionId = await createTrackSession(env.DB, userId);

      await ctx.reply(
        '<b>➕ Track Anime Baru</b>\n\n' +
          '<b>Step 1/5:</b> Pilih situs sumber:',
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: buildSiteKeyboard(sessionId),
        }
      );
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
            r.chunk_start > 0 ? ` · chunk ${r.chunk_start}-${r.chunk_end}` : '';
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
        lines.push('');
      }

      await ctx.reply(lines.join('\n'), {
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
      const slug = parts[1];
      if (!slug) {
        await ctx.reply('Usage: <code>/track check &lt;slug&gt;</code>', {
          parse_mode: 'HTML',
        });
        return;
      }
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

export async function handleTrackTextInput(
  ctx: Context,
  env: Env
): Promise<boolean> {
  return handleTrackTextInputInternal(ctx, env);
}

async function handleTrackTextInputInternal(
  ctx: Context,
  env: Env
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;

  const text = ctx.message?.text ?? '';
  if (!text || text.startsWith('/')) return false;

  const session = await getTrackSession(env.DB, userId);
  if (!session) return false;

  await handleTrackTextInputImpl(ctx, env, session, text);
  return true;
}

async function handleTrackTextInputImpl(
  ctx: Context,
  env: Env,
  session: Awaited<ReturnType<typeof getTrackSession>>,
  text: string
): Promise<void> {
  if (!session) return;
  void ctx;
  void env;
  void text;
}

export function setupTrackCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^tr:site:(tr_[a-z0-9]+):(lexanime|animesub)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const site = (ctx.match[2] ?? '') as SiteKey;
    const session = await getTrackSessionById(env, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: '⏱️ Kadaluarsa', show_alert: true });
      return;
    }

    await updateTrackSession(env.DB, sessionId, { site });
    await ctx.answerCallbackQuery({ text: site });

    await ctx.editMessageText(
      `<b>Step 2/5:</b> Kirim <b>slug</b> anime di qimochi.\n\n` +
        `<i>Contoh: <code>tensei-goblin-dakedo-shitsumon-aru</code></i>`,
      { parse_mode: 'HTML', reply_markup: undefined }
    );
  });

  bot.callbackQuery(/^tr:day:(tr_[a-z0-9]+):(\w+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const day = ctx.match[2] ?? '';
    const session = await getTrackSessionById(env, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: '⏱️ Kadaluarsa', show_alert: true });
      return;
    }

    await updateTrackSession(env.DB, sessionId, { scheduleDay: day });
    await ctx.answerCallbackQuery({ text: day });

    await ctx.editMessageText(
      `<b>Step 4/5:</b> Kirim <b>jam rilis</b> (format 24 jam).\n\n` +
        `<i>Contoh: <code>18</code> untuk jam 18:00 WIB</i>`,
      { parse_mode: 'HTML', reply_markup: undefined }
    );
  });

  bot.callbackQuery(/^tr:save:(tr_[a-z0-9]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '✅ Tersimpan' });
    void ctx;
    void env;
  });

  bot.callbackQuery(/^tr:x:(tr_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (sessionId) await deleteTrackSession(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageText('❌ <b>Dibatalkan.</b>', {
        parse_mode: 'HTML',
        reply_markup: undefined,
      })
      .catch(() => {});
  });
}

async function getTrackSessionById(
  env: Env,
  sessionId: string
): Promise<{ user_id: number } | null> {
  const row = await env.DB
    .prepare('SELECT * FROM track_sessions WHERE session_id = ?')
    .bind(sessionId)
    .first<{ user_id: number }>();
  return row ?? null;
}

void githubGetFile;
void listTrackedAnime;
void escapeHtml;
void buildDayKeyboard;
void buildSummaryKeyboard;
void showTrackSummary;
void deleteTrackedAnime;
void listAllTrackedAnime;
void InlineKeyboard;
