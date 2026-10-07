// src/commands/track/flow.ts
import type { Context } from 'grammy';
import type { Env } from '../../types/env';
import { githubGetFile } from '../../lib/github';
import { escapeHtml } from '../../lib/utils';
import { saveTrackedAnime, type SiteKey } from '../../lib/cron/state';
import {
  deleteTrackSession,
  getLatestTrackSessionByUser,
  updateTrackSession,
  type TrackSessionRow,
} from './state';
import {
  buildConfirmKeyboard,
  buildDayKeyboard,
  buildDayPrompt,
  buildHourPrompt,
  buildSitePrompt,
  buildSlugPrompt,
  buildSourceSlugPrompt,
  buildSummary,
} from './ui';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export async function handleTrackTextInput(
  ctx: Context,
  env: Env
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;

  const text = ctx.message?.text?.trim() ?? '';
  if (!text || text.startsWith('/')) return false;

  const session = await getLatestTrackSessionByUser(env.DB, userId);
  if (!session) return false;

  switch (session.step) {
    case 'slug':
      await handleSlugInput(ctx, env, session, text);
      return true;
    case 'source_slug':
      await handleSourceSlugInput(ctx, env, session, text);
      return true;
    case 'hour':
      await handleHourInput(ctx, env, session, text);
      return true;
    default:
      return false;
  }
}

async function handleSlugInput(
  ctx: Context,
  env: Env,
  session: TrackSessionRow,
  slug: string
): Promise<void> {
  if (!SLUG_RE.test(slug)) {
    await ctx.reply(
      '❌ Slug tidak valid. Hanya <code>a-z</code>, <code>0-9</code>, dan <code>-</code>.\n\n' +
        'Coba lagi:',
      { parse_mode: 'HTML' }
    );
    return;
  }
  const path = `src/content/anime/${slug}.md`;
  let file: Awaited<ReturnType<typeof githubGetFile>> = null;
  try {
    file = await githubGetFile(env, path, 'qimochi');
  } catch (err) {
    console.warn('[Track] githubGetFile error:', err);
  }

  if (!file) {
    await ctx.reply(
      `❌ <b>Markdown belum ada di qimochi.</b>\n\n` +
        `Path: <code>${escapeHtml(path)}</code>\n\n` +
        `<i>Push dulu via /anime → 📦 Post ke qimochi.</i>\n\n` +
        `<i>Kalau salah ketik, kirim slug lagi. Atau /track add ulang untuk reset.</i>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  await updateTrackSession(env.DB, session.session_id, {
    slug,
    source_slug: slug,
    step: 'source_slug',
  });

  await ctx.reply(buildSourceSlugPrompt(slug, session.site ?? '-'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

async function handleSourceSlugInput(
  ctx: Context,
  env: Env,
  session: TrackSessionRow,
  input: string
): Promise<void> {
  const sourceSlug = input === '-' ? session.slug ?? '' : input;

  if (!SLUG_RE.test(sourceSlug)) {
    await ctx.reply(
      '❌ Slug tidak valid. Hanya <code>a-z</code>, <code>0-9</code>, dan <code>-</code>.\n\n' +
        'Atau kirim <code>-</code> kalau sama dengan qimochi.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  await updateTrackSession(env.DB, session.session_id, {
    source_slug: sourceSlug,
    step: 'day',
  });

  await ctx.reply(buildDayPrompt(), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: buildDayKeyboard(session.session_id),
  });
}

async function handleHourInput(
  ctx: Context,
  env: Env,
  session: TrackSessionRow,
  input: string
): Promise<void> {
  const hour = parseInt(input, 10);
  if (isNaN(hour) || hour < 0 || hour > 23) {
    await ctx.reply(
      '❌ Jam tidak valid. Kirim angka <code>0</code>–<code>23</code>.\n\n' +
        'Contoh: <code>18</code>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  await updateTrackSession(env.DB, session.session_id, {
    schedule_hour: hour,
    step: 'confirm',
  });

  const updated: TrackSessionRow = {
    ...session,
    schedule_hour: hour,
    step: 'confirm',
  };

  let existsInRepo = false;
  if (updated.slug) {
    try {
      const f = await githubGetFile(
        env,
        `src/content/anime/${updated.slug}.md`,
        'qimochi'
      );
      existsInRepo = !!f;
    } catch {}
  }

  await ctx.reply(buildSummary(updated, existsInRepo), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: buildConfirmKeyboard(session.session_id),
  });
}

export async function handleSitePick(
  ctx: Context,
  env: Env,
  session: TrackSessionRow,
  site: SiteKey
): Promise<void> {
  await updateTrackSession(env.DB, session.session_id, {
    site,
    step: 'slug',
  });
  await ctx.editMessageText(buildSlugPrompt(), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

export async function handleDayPick(
  ctx: Context,
  env: Env,
  session: TrackSessionRow,
  day: string
): Promise<void> {
  await updateTrackSession(env.DB, session.session_id, {
    schedule_day: day,
    step: 'hour',
  });
  await ctx.editMessageText(buildHourPrompt(day), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

export async function handleConfirmSave(
  ctx: Context,
  env: Env,
  session: TrackSessionRow
): Promise<void> {
  if (
    !session.site ||
    !session.slug ||
    !session.source_slug ||
    !session.schedule_day ||
    session.schedule_hour === null
  ) {
    await ctx.answerCallbackQuery({
      text: '❌ Data belum lengkap',
      show_alert: true,
    });
    return;
  }

  const site = session.site as SiteKey;
  const fallbackSite: SiteKey | null =
    site === 'lexanime' ? 'animesub' : 'lexanime';

  try {
    await saveTrackedAnime(env.DB, {
      slug: session.slug,
      site,
      sourceSlug: session.source_slug,
      fallbackSite,
      scheduleDay: session.schedule_day,
      scheduleHour: session.schedule_hour,
      bufferMin: session.buffer_min,
    });
  } catch (err: any) {
    await ctx.answerCallbackQuery({
      text: `❌ Gagal simpan: ${err?.message ?? 'unknown'}`,
      show_alert: true,
    });
    return;
  }

  await deleteTrackSession(env.DB, session.session_id);
  await ctx.answerCallbackQuery({ text: '✅ Tersimpan' });

  const lines: string[] = [];
  lines.push('✅ <b>Anime di-track!</b>');
  lines.push('');
  lines.push(`🆔 <code>${escapeHtml(session.slug)}</code>`);
  lines.push(`🎬 ${site}${fallbackSite ? ` (fallback: ${fallbackSite})` : ''}`);
  lines.push(
    `📅 ${session.schedule_day} ${String(session.schedule_hour).padStart(2, '0')}:00 WIB`
  );
  lines.push('');
  lines.push(
    `<i>Bot akan cek situs mulai ${session.schedule_day} jam ${
      session.schedule_hour + 1
    }:00 WIB (buffer +60m).</i>`
  );

  await ctx
    .editMessageText(lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: undefined,
    })
    .catch(() => {});
}

export async function handleCancel(
  ctx: Context,
  env: Env,
  sessionId: string | null
): Promise<void> {
  if (sessionId && sessionId !== 'noop') {
    await deleteTrackSession(env.DB, sessionId);
  }
  await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
  await ctx
    .editMessageText('❌ <b>Dibatalkan.</b>', {
      parse_mode: 'HTML',
      reply_markup: undefined,
    })
    .catch(() => {});
}

export function buildInitialPrompt(sessionId: string): string {
  return buildSitePrompt(sessionId);
}
