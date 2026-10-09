// src/commands/track.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
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
  type TrackedAnimeRow,
} from '../lib/cron/state';
import { createTrackSession, getTrackSession } from './track/state';
import {
  buildSiteKeyboard,
  buildSitePrompt,
  buildMainMenuKeyboard,
  buildMainMenuText,
  buildDeleteMenuKeyboard,
  buildDeleteMenuText,
  buildDeleteSiteActionKeyboard,
  buildDeleteSiteActionText,
  buildDeleteAllConfirmKeyboard,
  buildDeleteAllConfirmText,
  buildDeleteSelectKeyboard,
  buildDeleteSelectText,
  buildDeleteSelectedConfirmKeyboard,
  buildDeleteSelectedConfirmText,
  countBits,
} from './track/ui';
import {
  handleSitePick,
  handleDayPick,
  handleConfirmSave,
  handleCancel,
  handleTrackTextInput,
} from './track/flow';

/* ============================================================
   CONSTANTS
   ============================================================ */

const ALL_SITES: SiteKey[] = ['lexanime', 'animesub', 'samehadaku'];

/* ============================================================
   HELPERS
   ============================================================ */

async function fetchBySite(env: Env, site: SiteKey): Promise<TrackedAnimeRow[]> {
  const all = await listAllTrackedAnime(env.DB);
  return all
    .filter((r) => r.site === site)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

async function countBySite(env: Env): Promise<Record<SiteKey, number>> {
  const all = await listAllTrackedAnime(env.DB);
  const result: Record<SiteKey, number> = {
    lexanime: 0,
    animesub: 0,
    samehadaku: 0,
  };
  for (const r of all) {
    if (r.site in result) result[r.site]++;
  }
  return result;
}

function isValidSite(s: string): s is SiteKey {
  return ALL_SITES.includes(s as SiteKey);
}

/* ============================================================
   MAIN MENU
   ============================================================ */

async function showMainMenu(
  ctx: Context,
  env: Env,
  edit: boolean = false
): Promise<void> {
  const all = await listAllTrackedAnime(env.DB);
  const total = all.length;
  const active = all.filter((r) => r.status === 'active').length;
  const paused = all.filter((r) => r.status === 'paused').length;
  const pending = all.filter(
    (r) => r.status === 'active' && isInScheduleWindow(r)
  ).length;

  const text = buildMainMenuText(total, active, paused, pending);
  const kb = buildMainMenuKeyboard();

  if (edit && ctx.callbackQuery?.message?.message_id) {
    await ctx
      .editMessageText(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      })
      .catch(() => {});
    return;
  }

  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

/* ============================================================
   TRACKED LIST (text)
   ============================================================ */

async function showTrackedList(ctx: Context, env: Env): Promise<void> {
  const rows = await listAllTrackedAnime(env.DB);

  if (rows.length === 0) {
    await ctx.reply(
      '📭 Belum ada anime yang di-track.\n\n' +
        '<i>Klik ➕ Tambah Baru untuk mulai.</i>',
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().text('◀️ Kembali', 'tr:h'),
      }
    );
    return;
  }

  const active = rows.filter((r) => r.status === 'active');
  const paused = rows.filter((r) => r.status === 'paused');
  const finished = rows.filter((r) => r.status === 'finished');

  const lines: string[] = [];
  lines.push(`📋 <b>Tracked Anime (${rows.length})</b>`);
  lines.push('');

  if (active.length > 0) {
    lines.push(`<b>🟢 Active (${active.length})</b>`);
    for (const r of active) {
      const time = formatScheduleTime(r);
      const pending = isInScheduleWindow(r) ? ' ⚠️' : '';
      lines.push(
        `• <code>${escapeHtml(r.slug)}</code>${pending}\n` +
          `  ${r.site} · ${r.schedule_day} ${time} · last ep ${r.last_ep}`
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
    lines.push(`<i>⚠️ ${pendingCount} anime tertinggal.</i>`);
  }

  await ctx.reply(lines.join('\n').trim(), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: new InlineKeyboard().text('◀️ Kembali', 'tr:h'),
  });
}

/* ============================================================
   DELETE FLOW
   ============================================================ */

async function showDeleteMenu(
  ctx: Context,
  env: Env,
  edit: boolean = false
): Promise<void> {
  const counts = await countBySite(env);
  const text = buildDeleteMenuText(counts);
  const kb = buildDeleteMenuKeyboard(counts);

  if (edit && ctx.callbackQuery?.message?.message_id) {
    await ctx
      .editMessageText(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      })
      .catch(() => {});
    return;
  }

  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

async function showDeleteSiteActions(
  ctx: Context,
  env: Env,
  site: SiteKey
): Promise<void> {
  const list = await fetchBySite(env, site);

  if (list.length === 0) {
    await ctx
      .editMessageText(
        `📭 Tidak ada anime dari <b>${site}</b>.`,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard().text('◀️ Kembali', 'tr:dm'),
        }
      )
      .catch(() => {});
    return;
  }

  await ctx
    .editMessageText(buildDeleteSiteActionText(site, list), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: buildDeleteSiteActionKeyboard(site, list.length),
    })
    .catch(() => {});
}

async function confirmDeleteAll(
  ctx: Context,
  env: Env,
  site: SiteKey
): Promise<void> {
  const list = await fetchBySite(env, site);

  await ctx
    .editMessageText(buildDeleteAllConfirmText(site, list), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: buildDeleteAllConfirmKeyboard(site),
    })
    .catch(() => {});
}

async function executeDeleteAll(
  ctx: Context,
  env: Env,
  site: SiteKey
): Promise<void> {
  const list = await fetchBySite(env, site);

  let deleted = 0;
  for (const r of list) {
    const ok = await deleteTrackedAnime(env.DB, r.slug);
    if (ok) deleted++;
  }

  await ctx
    .editMessageText(
      `✅ <b>Berhasil hapus ${deleted} anime</b>\n\n` +
        `Situs: <b>${escapeHtml(site)}</b>`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text('🗑️ Hapus Lagi', 'tr:dm')
          .text('🏠 Menu Utama', 'tr:h'),
      }
    )
    .catch(() => {});
}

async function showDeleteSelect(
  ctx: Context,
  env: Env,
  site: SiteKey,
  mask: number = 0
): Promise<void> {
  const list = await fetchBySite(env, site);

  await ctx
    .editMessageText(buildDeleteSelectText(site, list, mask), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: buildDeleteSelectKeyboard(site, list, mask),
    })
    .catch(() => {});
}

async function toggleDeleteSelect(
  ctx: Context,
  env: Env,
  site: SiteKey,
  mask: number,
  index: number
): Promise<void> {
  const list = await fetchBySite(env, site);

  if (index < 0 || index >= list.length) {
    await ctx.answerCallbackQuery({ text: '❌ Index tidak valid' });
    return;
  }

  const newMask = mask ^ (1 << index);

  await ctx.answerCallbackQuery({ text: '✓' });

  await showDeleteSelect(ctx, env, site, newMask);
}

async function confirmDeleteSelected(
  ctx: Context,
  env: Env,
  site: SiteKey,
  mask: number
): Promise<void> {
  if (mask === 0) {
    await ctx.answerCallbackQuery({
      text: '❌ Tidak ada yang dipilih',
      show_alert: true,
    });
    return;
  }

  const list = await fetchBySite(env, site);

  await ctx.answerCallbackQuery({ text: '⚠️ Konfirmasi' });

  await ctx
    .editMessageText(buildDeleteSelectedConfirmText(site, list, mask), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: buildDeleteSelectedConfirmKeyboard(site, mask),
    })
    .catch(() => {});
}

async function executeDeleteSelected(
  ctx: Context,
  env: Env,
  site: SiteKey,
  mask: number
): Promise<void> {
  const list = await fetchBySite(env, site);
  const selected = list.filter((_, i) => (mask & (1 << i)) !== 0);

  if (selected.length === 0) {
    await ctx.answerCallbackQuery({ text: '❌ Tidak ada yang dipilih' });
    return;
  }

  await ctx.answerCallbackQuery({ text: '🗑️ Menghapus...' });

  let deleted = 0;
  for (const r of selected) {
    const ok = await deleteTrackedAnime(env.DB, r.slug);
    if (ok) deleted++;
  }

  await ctx
    .editMessageText(
      `✅ <b>Berhasil hapus ${deleted} anime</b>\n\n` +
        `Situs: <b>${escapeHtml(site)}</b>`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text('🗑️ Hapus Lagi', 'tr:dm')
          .text('🏠 Menu Utama', 'tr:h'),
      }
    )
    .catch(() => {});
}

/* ============================================================
   CATCHUP (extracted from legacy)
   ============================================================ */

async function handleCatchup(ctx: Context, env: Env): Promise<void> {
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
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    const MAX_PER_RUN = 3;
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
        lines.push(`• <code>${escapeHtml(r.slug)}</code> — ${r.pushed} ep`);
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
        `<i>⏭️ ${remaining} anime lain masih tertinggal. Klik 🔄 lagi.</i>`
      );
    }

    const kb = new InlineKeyboard();
    if (remaining > 0) {
      kb.text('🔄 Lanjut Catch-up', 'tr:c').row();
    }
    kb.text('🏠 Menu Utama', 'tr:h');

    await ctx.api
      .editMessageText(ctx.chat!.id, loading.message_id, lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      })
      .catch(() => {});
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
}

/* ============================================================
   START ADD FLOW
   ============================================================ */

async function startAddFlow(ctx: Context, env: Env): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const sessionId = await createTrackSession(env.DB, userId);

  const text = buildSitePrompt(sessionId);
  const kb = buildSiteKeyboard(sessionId);

  if (ctx.callbackQuery?.message?.message_id) {
    await ctx
      .editMessageText(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      })
      .catch(() => {});
    return;
  }

  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

/* ============================================================
   COMMAND
   ============================================================ */

export const trackCommand: CommandDefinition = {
  name: 'track',
  description: 'Track anime + episode auto-fetch',
  usage: '/track',
  adminOnly: true,

  handler: async (ctx, env) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const parts = arg.split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? '').toLowerCase();

    // No arg → main menu
    if (!sub) {
      await showMainMenu(ctx, env);
      return;
    }

    /* ── /track add ──────────────────────────── */
    if (sub === 'add') {
      await startAddFlow(ctx, env);
      return;
    }

    /* ── /track list ─────────────────────────── */
    if (sub === 'list') {
      await showTrackedList(ctx, env);
      return;
    }

    /* ── /track catchup ──────────────────────── */
    if (sub === 'catchup') {
      await handleCatchup(ctx, env);
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
          ? `✅ <code>${escapeHtml(slug)}</code> dihapus.`
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
          ? `✅ <code>${escapeHtml(slug)}</code> ${sub === 'pause' ? 'di-pause' : 'di-resume'}.`
          : `❌ Tidak ada: <code>${escapeHtml(slug)}</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    /* ── /track edit-slug <slug> <new> ───────── */
    if (sub === 'edit-slug') {
      const slug = parts[1];
      const newSourceSlug = parts[2];

      if (!slug || !newSourceSlug) {
        await ctx.reply(
          'Usage: <code>/track edit-slug &lt;slug&gt; &lt;source_slug&gt;</code>',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const ok = await updateTrackedSourceSlug(env.DB, slug, newSourceSlug);
      await ctx.reply(
        ok
          ? `✅ Slug sumber <code>${escapeHtml(slug)}</code> → <code>${escapeHtml(newSourceSlug)}</code>`
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
            reply_markup: new InlineKeyboard().text('🏠 Menu Utama', 'tr:h'),
          })
          .catch(() => {});
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

    await ctx.reply(
      '❌ Subcommand tidak dikenal.\n\n' +
        '<i>Ketik <code>/track</code> untuk menu utama.</i>',
      { parse_mode: 'HTML' }
    );
  },
};

/* ============================================================
   TEXT INPUT HANDLER
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
  /* ── ADD flow callbacks (existing) ──────── */
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
        text: '⏱️ Kadaluarsa.',
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

  /* ── MAIN MENU callbacks ────────────────── */
  bot.callbackQuery(/^tr:h$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '🏠 Menu' });
    await showMainMenu(ctx, env, true);
  });

  bot.callbackQuery(/^tr:a$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '➕ Tambah' });
    await startAddFlow(ctx, env);
  });

  bot.callbackQuery(/^tr:l$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '📋 List' });
    await showTrackedList(ctx, env);
  });

  bot.callbackQuery(/^tr:c$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '🔄 Catch-up' });
    await handleCatchup(ctx, env);
  });

  /* ── DELETE MENU callbacks ──────────────── */
  bot.callbackQuery(/^tr:dm$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '🗑️ Hapus' });
    await showDeleteMenu(ctx, env, true);
  });

  bot.callbackQuery(/^tr:ds:(\w+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    if (!isValidSite(site)) {
      await ctx.answerCallbackQuery({ text: '❌ Site invalid' });
      return;
    }
    await ctx.answerCallbackQuery({ text: site });
    await showDeleteSiteActions(ctx, env, site);
  });

  bot.callbackQuery(/^tr:dall:(\w+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    if (!isValidSite(site)) {
      await ctx.answerCallbackQuery({ text: '❌ Site invalid' });
      return;
    }
    await ctx.answerCallbackQuery({ text: '⚠️ Konfirmasi' });
    await confirmDeleteAll(ctx, env, site);
  });

  bot.callbackQuery(/^tr:dally:(\w+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    if (!isValidSite(site)) {
      await ctx.answerCallbackQuery({ text: '❌ Site invalid' });
      return;
    }
    await ctx.answerCallbackQuery({ text: '🗑️ Menghapus...' });
    await executeDeleteAll(ctx, env, site);
  });

  bot.callbackQuery(/^tr:dsel:(\w+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    if (!isValidSite(site)) {
      await ctx.answerCallbackQuery({ text: '❌ Site invalid' });
      return;
    }
    await ctx.answerCallbackQuery({ text: '☑️ Select mode' });
    await showDeleteSelect(ctx, env, site, 0);
  });

  bot.callbackQuery(/^tr:dt:(\w+):(\d+):(\d+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    const mask = parseInt(ctx.match[2] ?? '0', 10);
    const index = parseInt(ctx.match[3] ?? '0', 10);

    if (!isValidSite(site)) {
      await ctx.answerCallbackQuery({ text: '❌ Site invalid' });
      return;
    }

    await toggleDeleteSelect(ctx, env, site, mask, index);
  });

  bot.callbackQuery(/^tr:dgo:(\w+):(\d+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    const mask = parseInt(ctx.match[2] ?? '0', 10);

    if (!isValidSite(site)) {
      await ctx.answerCallbackQuery({ text: '❌ Site invalid' });
      return;
    }

    await confirmDeleteSelected(ctx, env, site, mask);
  });

  bot.callbackQuery(/^tr:dgy:(\w+):(\d+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    const mask = parseInt(ctx.match[2] ?? '0', 10);

    if (!isValidSite(site)) {
      await ctx.answerCallbackQuery({ text: '❌ Site invalid' });
      return;
    }

    await executeDeleteSelected(ctx, env, site, mask);
  });
}

void countBits;