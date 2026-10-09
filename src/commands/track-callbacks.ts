// src/commands/track-callbacks.ts
import type { Bot, Context } from 'grammy';
import type { Env } from '../types/env';
import { escapeHtml } from '../lib/utils';
import {
  deleteTrackedAnime,
  listAllTrackedAnime,
  isInScheduleWindow,
  type SiteKey,
  type TrackedAnimeRow,
} from '../lib/cron/state';
import { updateTrackedAnime } from '../lib/cron/state-extra';
import {
  createSession,
  getSession,
  getLatestSession,
  updateSession,
  deleteSession,
  type TrackSessionRow,
} from './track';
import { githubGetFile } from '../lib/github';

const ALL_SITES: SiteKey[] = ['lexanime', 'animesub', 'samehadaku'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

function isValidSite(s: string): s is SiteKey {
  return ALL_SITES.includes(s as SiteKey);
}

function countBits(n: number): number {
  let c = 0, x = n;
  while (x > 0) {
    c += x & 1;
    x >>>= 1;
  }
  return c;
}

function extractSamehadakuSlug(url: string): string | null {
  const t = url.trim();
  const m1 = t.match(/\/anime\/([a-z0-9-]+)\/?/i);
  if (m1?.[1]) return m1[1].toLowerCase();
  const m2 = t.match(/\/([a-z0-9-]+?)-episode-\d+-subtitle-indonesia\/?/i);
  if (m2?.[1]) return m2[1].toLowerCase();
  return null;
}

async function fetchBySite(env: Env, site: SiteKey): Promise<TrackedAnimeRow[]> {
  const all = await listAllTrackedAnime(env.DB);
  return all.filter((r) => r.site === site).sort((a, b) => a.slug.localeCompare(b.slug));
}

export function setupTrackCmsCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^tr:v:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await ctx.answerCallbackQuery().catch(() => {});
    await import('./track').then((m) => m.showDetailPublic(ctx, env, slug, true));
  });

  bot.callbackQuery(/^tr:e:(.+):(\w+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    const field = ctx.match[2] ?? '';
    const userId = ctx.from?.id;
    if (!userId) return;

    await import('./track').then((m) =>
      m.promptEditPublic(ctx, env, userId, slug, field)
    );
  });

  bot.callbackQuery(/^tr:set:(ts_[a-z0-9]+):(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const value = ctx.match[2] ?? '';

    const session = await getSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Session kadaluarsa',
        show_alert: true,
      });
      return;
    }
    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }
    if (!session.slug || !session.edit_field) {
      await ctx.answerCallbackQuery({ text: '❌ Data tidak lengkap' });
      return;
    }

    const patch: Record<string, unknown> = {};
    const field = session.edit_field;

    if (field === 'site') {
      if (!isValidSite(value)) {
        await ctx.answerCallbackQuery({ text: '❌ Site invalid' });
        return;
      }
      patch.site = value;
    } else if (field === 'status') {
      if (!['active', 'paused', 'finished'].includes(value)) {
        await ctx.answerCallbackQuery({ text: '❌ Status invalid' });
        return;
      }
      patch.status = value;
    } else if (field === 'schedule_day') {
      patch.schedule_day = value;
    } else {
      await ctx.answerCallbackQuery({ text: '❌ Field butuh input teks' });
      return;
    }

    await updateTrackedAnime(env.DB, session.slug, patch);
    await deleteSession(env.DB, sessionId);

    await ctx.answerCallbackQuery({ text: '✅ Tersimpan' });

    await import('./track').then((m) =>
      m.showDetailPublic(ctx, env, session.slug!, true)
    );
  });

  bot.callbackQuery(/^tr:cx:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await ctx.answerCallbackQuery({ text: '🔄 Cek...' });

    const loading = await ctx.reply(
      `🔍 Cek <code>${escapeHtml(slug)}</code>...`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );

    try {
      const { runManualCheck } = await import('../lib/cron/runner');
      const result = await runManualCheck(env, slug);

      const lines: string[] = [];
      lines.push(`📡 <b>Check: ${escapeHtml(slug)}</b>`);
      lines.push('');
      lines.push(`🔍 Dicek: <b>${result.animeChecked}</b>`);
      lines.push(`📼 Push: <b>${result.episodesPushed}</b> episode`);

      if (result.errors.length > 0) {
        lines.push('');
        lines.push('⚠️ <b>Error:</b>');
        for (const e of result.errors.slice(0, 3)) {
          lines.push(`• <code>${escapeHtml(e.slice(0, 150))}</code>`);
        }
      }

      await ctx.api
        .editMessageText(ctx.chat!.id, loading.message_id, lines.join('\n'), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: new (require('grammy').InlineKeyboard)()
            .text('◀️ Kembali', `tr:v:${slug}`),
        })
        .catch(() => {});
    } catch (err: any) {
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 200))}</code>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^tr:rs:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';

    await updateTrackedAnime(env.DB, slug, {
      last_ep: 0,
      chunk_start: 0,
      chunk_end: 0,
    });

    await ctx.answerCallbackQuery({ text: '♻️ Progress di-reset' });

    await import('./track').then((m) =>
      m.showDetailPublic(ctx, env, slug, true)
    );
  });

  bot.callbackQuery(/^tr:dv:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    const { InlineKeyboard } = await import('grammy');

    await ctx.answerCallbackQuery({ text: '⚠️ Konfirmasi' });
    await ctx
      .editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery!.message!.message_id!,
        `⚠️ <b>Hapus anime?</b>\n\n` +
          `<code>${escapeHtml(slug)}</code>\n\n` +
          `<i>Anime bisa di-add ulang lewat ➕ Tambah Baru.</i>`,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard()
            .text('✅ Ya, Hapus', `tr:dvy:${slug}`)
            .text('❌ Batal', `tr:v:${slug}`),
        }
      )
      .catch(() => {});
  });

  bot.callbackQuery(/^tr:dvy:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await deleteTrackedAnime(env.DB, slug);
    await ctx.answerCallbackQuery({ text: '🗑️ Terhapus' });
    await import('./track').then((m) => m.showListPublic(ctx, env, 0));
  });

  bot.callbackQuery(/^tr:lp:(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1] ?? '0', 10);
    await ctx.answerCallbackQuery().catch(() => {});
    await import('./track').then((m) => m.showListPublic(ctx, env, page));
  });

  bot.callbackQuery(/^tr:h$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '🏠' });
    await import('./track').then((m) => m.showMainMenuPublic(ctx, env, true));
  });

  bot.callbackQuery(/^tr:l$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await import('./track').then((m) => m.showListPublic(ctx, env, 0));
  });

  bot.callbackQuery(/^tr:a$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    await ctx.answerCallbackQuery({ text: '➕' });
    await import('./track').then((m) => m.startAddFlowPublic(ctx, env, userId));
  });

  bot.callbackQuery(/^tr:c$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '🔄' });
    await import('./track').then((m) => m.handleCatchupPublic(ctx, env));
  });

  bot.callbackQuery(/^tr:dm$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await import('./track-delete').then((m) => m.showDeleteMenuPublic(ctx, env));
  });

  bot.callbackQuery(/^tr:ds:(\w+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    if (!isValidSite(site)) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    await import('./track-delete').then((m) => m.showDeleteSitePublic(ctx, env, site));
  });

  bot.callbackQuery(/^tr:dall:(\w+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    if (!isValidSite(site)) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await ctx.answerCallbackQuery({ text: '⚠️' });
    await import('./track-delete').then((m) => m.confirmDeleteAllPublic(ctx, env, site));
  });

  bot.callbackQuery(/^tr:dally:(\w+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    if (!isValidSite(site)) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await ctx.answerCallbackQuery({ text: '🗑️' });
    await import('./track-delete').then((m) => m.execDeleteAllPublic(ctx, env, site));
  });

  bot.callbackQuery(/^tr:dsel:(\w+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    if (!isValidSite(site)) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    await import('./track-delete').then((m) => m.showDeleteSelectPublic(ctx, env, site, 0));
  });

  bot.callbackQuery(/^tr:dt:(\w+):(\d+):(\d+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    const mask = parseInt(ctx.match[2] ?? '0', 10);
    const idx = parseInt(ctx.match[3] ?? '0', 10);
    if (!isValidSite(site)) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await import('./track-delete').then((m) =>
      m.toggleDeleteSelectPublic(ctx, env, site, mask, idx)
    );
  });

  bot.callbackQuery(/^tr:dgo:(\w+):(\d+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    const mask = parseInt(ctx.match[2] ?? '0', 10);
    if (!isValidSite(site)) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await import('./track-delete').then((m) =>
      m.confirmDeleteSelectedPublic(ctx, env, site, mask)
    );
  });

  bot.callbackQuery(/^tr:dgy:(\w+):(\d+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    const mask = parseInt(ctx.match[2] ?? '0', 10);
    if (!isValidSite(site)) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await import('./track-delete').then((m) =>
      m.execDeleteSelectedPublic(ctx, env, site, mask)
    );
  });

  /* ADD flow existing */
  bot.callbackQuery(
    /^tr:site:(ts_[a-z0-9]+):(lexanime|animesub|samehadaku)$/,
    async (ctx) => {
      const sessionId = ctx.match[1] ?? '';
      const site = (ctx.match[2] ?? '') as SiteKey;

      const session = await getSession(env.DB, sessionId);
      if (!session) {
        await ctx.answerCallbackQuery({ text: '⏱️ Kadaluarsa', show_alert: true });
        return;
      }
      if (ctx.from?.id !== session.user_id) {
        await ctx.answerCallbackQuery({ text: '⛔' });
        return;
      }

      await updateSession(env.DB, sessionId, { site, step: 'add_slug' });
      await ctx.answerCallbackQuery({ text: site });

      const { InlineKeyboard } = await import('grammy');
      await ctx
        .editMessageText(
          '<b>Step 2/5</b> · Kirim <b>slug anime</b> qimochi.\n\n' +
            '<i>Contoh: <code>tensei-goblin-dakedo-shitsumon-aru</code></i>\n\n' +
            '<i>Markdown harus sudah ada di repo qimochi.</i>',
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: new InlineKeyboard().text('❌ Batal', `tr:x:${sessionId}`),
          }
        )
        .catch(() => {});
    }
  );

  bot.callbackQuery(/^tr:day:(ts_[a-z0-9]+):([A-Za-z]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const day = ctx.match[2] ?? '';
    const session = await getSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: '⏱️', show_alert: true });
      return;
    }
    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔' });
      return;
    }

    await updateSession(env.DB, sessionId, { schedule_day: day, step: 'add_hour' });
    await ctx.answerCallbackQuery({ text: day });

    const { InlineKeyboard } = await import('grammy');
    await ctx
      .editMessageText(
        `<b>Step 5/5</b> · Hari: <b>${day}</b>\n\n` +
          `Kirim <b>jam rilis</b> (WIB, format 24 jam):\n\n` +
          `• <code>18</code> → 18:00 WIB\n` +
          `• <code>18:30</code> → 18:30 WIB\n` +
          `• <code>18.15</code> → 18:15 WIB\n\n` +
          `<i>Bot akan cek mulai jam + buffer 60 menit.</i>`,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard().text('❌ Batal', `tr:x:${sessionId}`),
        }
      )
      .catch(() => {});
  });

  bot.callbackQuery(/^tr:save:(ts_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const session = await getSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: '⏱️', show_alert: true });
      return;
    }
    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔' });
      return;
    }

    if (
      !session.site ||
      !session.slug ||
      !session.source_slug ||
      !session.schedule_day ||
      session.schedule_hour === null
    ) {
      await ctx.answerCallbackQuery({ text: '❌ Data kurang', show_alert: true });
      return;
    }

    const { saveTrackedAnime } = await import('../lib/cron/state');
    const site = session.site as SiteKey;
    const fallbackSite: SiteKey | null =
      site === 'lexanime' ? 'animesub' : site === 'animesub' ? 'lexanime' : null;

    await saveTrackedAnime(env.DB, {
      slug: session.slug,
      site,
      sourceSlug: session.source_slug,
      fallbackSite,
      scheduleDay: session.schedule_day,
      scheduleHour: session.schedule_hour,
      scheduleMinute: session.schedule_minute ?? 0,
      bufferMin: session.buffer_min,
    });

    await deleteSession(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '✅ Tersimpan' });

    const hh = String(session.schedule_hour).padStart(2, '0');
    const mm = String(session.schedule_minute ?? 0).padStart(2, '0');

    await ctx
      .editMessageText(
        `✅ <b>Anime di-track!</b>\n\n` +
          `🆔 <code>${escapeHtml(session.slug)}</code>\n` +
          `🎬 ${site}\n` +
          `📅 ${session.schedule_day} ${hh}:${mm} WIB`,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: undefined,
        }
      )
      .catch(() => {});
  });

  bot.callbackQuery(/^tr:x:(ts_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    await deleteSession(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '🗑️' });
    await ctx
      .editMessageText('❌ <b>Dibatalkan.</b>', {
        parse_mode: 'HTML',
        reply_markup: undefined,
      })
      .catch(() => {});
  });
}

/* ============================================================
   TEXT INPUT HANDLER
   ============================================================ */

export async function handleTrackTextV2(
  ctx: Context,
  env: Env
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;

  const text = ctx.message?.text?.trim() ?? '';
  if (!text || text.startsWith('/')) return false;

  const session = await getLatestSession(env.DB, userId);
  if (!session) return false;

  switch (session.step) {
    case 'add_slug':
      return await handleAddSlug(ctx, env, session, text);
    case 'add_source':
      return await handleAddSource(ctx, env, session, text);
    case 'add_hour':
      return await handleAddHour(ctx, env, session, text);
    case 'edit_value':
      return await handleEditValue(ctx, env, session, text);
    default:
      return false;
  }
}

async function handleAddSlug(
  ctx: Context,
  env: Env,
  session: TrackSessionRow,
  slug: string
): Promise<boolean> {
  if (!SLUG_RE.test(slug)) {
    await ctx.reply('❌ Slug invalid. Coba lagi:');
    return true;
  }

  const path = `src/content/anime/${slug}.md`;
  let file: Awaited<ReturnType<typeof githubGetFile>> = null;
  try {
    file = await githubGetFile(env, path, 'qimochi');
  } catch {}

  if (!file) {
    await ctx.reply(
      `❌ <b>Markdown belum ada di qimochi.</b>\n\n` +
        `Path: <code>${escapeHtml(path)}</code>\n\n` +
        `<i>Push dulu via /anime → Post ke qimochi.</i>\n` +
        `<i>Kirim slug lagi kalau salah ketik.</i>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return true;
  }

  await updateSession(env.DB, session.session_id, {
    slug,
    source_slug: slug,
    step: 'add_source',
  });

  const isSamehadaku = session.site === 'samehadaku';
  const prompt = isSamehadaku
    ? `<b>Step 3/5</b> · Slug di <b>samehadaku</b>\n\n` +
      `🆔 Qimochi: <code>${escapeHtml(slug)}</code>\n\n` +
      `<b>Opsi input:</b>\n` +
      `• URL anime Samehadaku\n` +
      `• Slug langsung\n` +
      `• Kirim <code>-</code> kalau sama dengan qimochi`
    : `<b>Step 3/5</b> · Slug di <b>${session.site}</b>\n\n` +
      `🆔 Qimochi: <code>${escapeHtml(slug)}</code>\n\n` +
      `<b>Kalau sama:</b> kirim <code>-</code>\n` +
      `<b>Kalau beda:</b> kirim slug situs`;

  await ctx.reply(prompt, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
  return true;
}

async function handleAddSource(
  ctx: Context,
  env: Env,
  session: TrackSessionRow,
  input: string
): Promise<boolean> {
  let sourceSlug: string;

  if (input === '-') {
    sourceSlug = session.slug ?? '';
  } else if (session.site === 'samehadaku' && /^https?:\/\//i.test(input)) {
    const extracted = extractSamehadakuSlug(input);
    if (!extracted) {
      await ctx.reply(
        '❌ URL Samehadaku invalid. Format:\n' +
          '• <code>https://samehadaku.li/anime/{slug}/</code>\n' +
          '• <code>https://samehadaku.li/{slug}-episode-N-subtitle-indonesia/</code>',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return true;
    }
    sourceSlug = extracted;
    await ctx.reply(`✅ Slug: <code>${escapeHtml(sourceSlug)}</code>`, {
      parse_mode: 'HTML',
    });
  } else {
    sourceSlug = input.trim();
  }

  if (!SLUG_RE.test(sourceSlug)) {
    await ctx.reply('❌ Slug invalid. Kirim ulang:');
    return true;
  }

  await updateSession(env.DB, session.session_id, {
    source_slug: sourceSlug,
    step: 'add_day',
  });

  const { InlineKeyboard } = await import('grammy');
  const DAYS_ORDER = [
    'Senin',
    'Selasa',
    'Rabu',
    'Kamis',
    'Jumat',
    'Sabtu',
    'Minggu',
  ];
  const DAYS_SHORT = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

  const kb = new InlineKeyboard();
  for (let i = 0; i < 7; i++) {
    kb.text(DAYS_SHORT[i]!, `tr:day:${session.session_id}:${DAYS_ORDER[i]}`);
    if ((i + 1) % 4 === 0) kb.row();
  }
  kb.text('🎲 Random', `tr:day:${session.session_id}:Random`).row();
  kb.text('❌ Batal', `tr:x:${session.session_id}`);

  await ctx.reply('<b>Step 4/5</b> · Pilih hari rilis:', {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
  return true;
}

async function handleAddHour(
  ctx: Context,
  env: Env,
  session: TrackSessionRow,
  input: string
): Promise<boolean> {
  const cleaned = input.trim().replace(/[.,]/g, ':');
  const parts = cleaned.split(':');
  let hour: number | null = null;
  let minute = 0;

  if (parts.length === 1) {
    const h = parseInt(parts[0] ?? '', 10);
    if (!isNaN(h) && h >= 0 && h <= 23) hour = h;
  } else if (parts.length === 2) {
    const h = parseInt(parts[0] ?? '', 10);
    const m = parseInt(parts[1] ?? '', 10);
    if (!isNaN(h) && !isNaN(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      hour = h;
      minute = m;
    }
  }

  if (hour === null) {
    await ctx.reply(
      '❌ Format jam invalid.\n\nContoh: <code>18</code> / <code>18:30</code> / <code>18.15</code>',
      { parse_mode: 'HTML' }
    );
    return true;
  }

  await updateSession(env.DB, session.session_id, {
    schedule_hour: hour,
    schedule_minute: minute,
    step: 'add_confirm',
  });

  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');

  const { InlineKeyboard } = await import('grammy');
  await ctx.reply(
    `📋 <b>Konfirmasi</b>\n\n` +
      `🎬 Site: <b>${session.site}</b>\n` +
      `🆔 Slug: <code>${escapeHtml(session.slug ?? '-')}</code>\n` +
      `🔗 Source: <code>${escapeHtml(session.source_slug ?? '-')}</code>\n` +
      `📅 ${session.schedule_day} ${hh}:${mm} WIB\n\n` +
      `<i>Klik Simpan untuk konfirmasi.</i>`,
    {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .text('✅ Simpan', `tr:save:${session.session_id}`)
        .text('❌ Batal', `tr:x:${session.session_id}`),
    }
  );
  return true;
}

async function handleEditValue(
  ctx: Context,
  env: Env,
  session: TrackSessionRow,
  input: string
): Promise<boolean> {
  const slug = session.slug;
  const field = session.edit_field;

  if (!slug || !field) {
    await deleteSession(env.DB, session.session_id);
    return false;
  }

  const patch: Record<string, unknown> = {};
  let error: string | null = null;

  if (field === 'schedule_hour') {
    const cleaned = input.trim().replace(/[.,]/g, ':');
    const parts = cleaned.split(':');
    if (parts.length === 1) {
      const h = parseInt(parts[0] ?? '', 10);
      if (!isNaN(h) && h >= 0 && h <= 23) {
        patch.schedule_hour = h;
        patch.schedule_minute = 0;
      } else error = 'Jam harus 0-23';
    } else if (parts.length === 2) {
      const h = parseInt(parts[0] ?? '', 10);
      const m = parseInt(parts[1] ?? '', 10);
      if (!isNaN(h) && !isNaN(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        patch.schedule_hour = h;
        patch.schedule_minute = m;
      } else error = 'Format jam invalid';
    } else {
      error = 'Format invalid. Contoh: 18 atau 18:30';
    }
  } else if (field === 'last_ep') {
    const n = parseInt(input.trim(), 10);
    if (!isNaN(n) && n >= 0 && n <= 9999) {
      patch.last_ep = n;
    } else error = 'Angka 0-9999';
  } else if (field === 'chunk') {
    const m = input.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      patch.chunk_start = parseInt(m[1] ?? '0', 10);
      patch.chunk_end = parseInt(m[2] ?? '0', 10);
    } else error = 'Format: 2-6';
  } else if (field === 'buffer_min') {
    const n = parseInt(input.trim(), 10);
    if (!isNaN(n) && n >= 5 && n <= 480) {
      patch.buffer_min = n;
    } else error = 'Angka 5-480';
  } else if (field === 'source_slug') {
    let s = input.trim();
    if (session.site === 'samehadaku' && /^https?:\/\//i.test(s)) {
      const extracted = extractSamehadakuSlug(s);
      if (extracted) s = extracted;
    }
    if (SLUG_RE.test(s)) {
      patch.source_slug = s;
    } else error = 'Slug invalid';
  }

  if (error) {
    await ctx.reply(`❌ ${error}\n\nCoba lagi:`);
    return true;
  }

  await updateTrackedAnime(env.DB, slug, patch);
  await deleteSession(env.DB, session.session_id);

  await ctx.reply(`✅ <b>Updated:</b> <code>${escapeHtml(slug)}</code>`, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });

  const mod = await import('./track');
  await mod.showDetailPublic(ctx, env, slug, false);
  return true;
}