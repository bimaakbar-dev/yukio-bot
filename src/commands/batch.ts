
// src/commands/batch.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { EpisodeObject } from '../types/anime';
import { getCache, setCache, deleteCache } from '../lib/cache';
import { githubGetFile, githubListDir, githubCommitFile } from '../lib/github';
import {
  BATCH_MAX,
  looksLikeHtml,
  decodeInput,
  buildEpisodeObject,
  fetchUrlViaProxy,
} from '../services/decode-core';

const WIZARD_TTL_MS = 15 * 60 * 1000;

type SiteKey = 'lexanime' | 'animesub' | 'samehadaku';
type WizardSite = SiteKey | 'custom';

interface WizardState {
  step: 'awaiting_slug' | 'awaiting_source' | 'awaiting_range' | 'ready';
  slug: string | null;
  sourceUrl: string | null;
  sourceSite: WizardSite | null;
  /** Untuk site known: slug di situs sumber. Untuk custom: hostname saja. */
  sourceSlug: string | null;
  /** Khusus custom: URL template dengan placeholder `{n}`. */
  customPattern: string | null;
  rangeStart: number | null;
  rangeEnd: number | null;
}

interface SiteConfig {
  host: string;
  episodePath: (slug: string, n: number) => string;
}

const WIZARD_SITES: Record<SiteKey, SiteConfig> = {
  lexanime: {
    host: 'https://lexanime.web.id',
    episodePath: (slug, n) => `/tonton/${slug}/episode-${n}-sub-indo`,
  },
  animesub: {
    host: 'https://animesub.web.id',
    episodePath: (slug, n) => `/tonton/${slug}/episode-${n}-sub-indo`,
  },
  samehadaku: {
    host: 'https://samehadaku.li',
    episodePath: (slug, n) => `/${slug}-episode-${n}-subtitle-indonesia/`,
  },
};

type ParsedSource =
  | { kind: 'known'; site: SiteKey; slug: string }
  | { kind: 'custom'; pattern: string; host: string };

/**
 * Auto-detect pola episode di URL → template dengan `{n}`.
 * Return null kalau tidak ada pola yang bisa dipakai.
 */
function resolveCustomPattern(
  input: string
): { pattern: string; host: string } | null {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;

  // Hostname — substitute {n} biar URL valid untuk parsing.
  let host: string;
  try {
    host = new URL(trimmed.replace(/\{n\}/g, '1')).hostname.toLowerCase();
  } catch {
    return null;
  }

  // 1) User sudah kasih {n} eksplisit
  if (/\{n\}/.test(trimmed)) {
    return { pattern: trimmed, host };
  }

  // 2) "episode-5", "ep_12", "EP.3", dst.
  const m1 = trimmed.match(/^(.*?)(episode|ep|eps)([-_.]?)(\d+)(.*)$/i);
  if (m1) {
    const prefix = m1[1] ?? '';
    const keyword = m1[2] ?? 'episode';
    const sep = m1[3] ?? '';
    const suffix = m1[5] ?? '';
    return { pattern: `${prefix}${keyword}${sep}{n}${suffix}`, host };
  }

  // 3) URL diakhiri segmen angka: /watch/foo/12, /watch/foo/12/, /watch/foo/12?x=1
  const m2 = trimmed.match(/^(.*\/)(\d+)(\D.*)?$/);
  if (m2) {
    const prefix = m2[1] ?? '';
    const suffix = m2[3] ?? '';
    return { pattern: `${prefix}{n}${suffix}`, host };
  }

  return null;
}

function parseSourceUrl(url: string): ParsedSource | null {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;

  try {
    const u = new URL(trimmed.replace(/\{n\}/g, '1'));
    const host = u.hostname.toLowerCase();

    if (host.includes('lexanime')) {
      const slug = u.pathname.match(/\/tonton\/([^/]+)/)?.[1];
      if (slug) return { kind: 'known', site: 'lexanime', slug };
    }
    if (host.includes('animesub')) {
      const slug = u.pathname.match(/\/tonton\/([^/]+)/)?.[1];
      if (slug) return { kind: 'known', site: 'animesub', slug };
    }
    if (host.includes('samehadaku')) {
      const s1 = u.pathname.match(/\/anime\/([^/]+)/)?.[1];
      if (s1) return { kind: 'known', site: 'samehadaku', slug: s1 };
      const s2 = u.pathname.match(
        /\/([^/]+?)-episode-\d+-subtitle-indonesia/
      )?.[1];
      if (s2) return { kind: 'known', site: 'samehadaku', slug: s2 };
    }
  } catch {
    return null;
  }

  const custom = resolveCustomPattern(trimmed);
  if (custom) {
    return { kind: 'custom', pattern: custom.pattern, host: custom.host };
  }
  return null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function startBatchWizard(ctx: Context, env: Env): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const state: WizardState = {
    step: 'awaiting_slug',
    slug: null,
    sourceUrl: null,
    sourceSite: null,
    sourceSlug: null,
    customPattern: null,
    rangeStart: null,
    rangeEnd: null,
  };
  await setCache(env.DB, `bw:${userId}`, state, WIZARD_TTL_MS);

  await ctx.reply(
    '📦 <b>Batch Wizard</b>\n\n' +
      '<b>Step 1/3</b> · Kirim <b>slug anime</b>.\n\n' +
      '<i>Contoh: <code>jujutsu-kaisen</code></i>\n\n' +
      'Bot akan cek dulu ke repo yukio-data.',
    {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard().text('❌ Batal', 'bw:cancel'),
    }
  );
}

export async function handleBatchWizardText(
  ctx: Context,
  env: Env
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;

  const text = ctx.message?.text?.trim() ?? '';
  if (!text || text.startsWith('/')) return false;

  const state = await getCache<WizardState>(env.DB, `bw:${userId}`);
  if (!state) return false;

  if (state.step === 'awaiting_slug') {
    return handleWizardSlug(ctx, env, userId, state, text);
  }
  if (state.step === 'awaiting_source') {
    return handleWizardSource(ctx, env, userId, state, text);
  }
  if (state.step === 'awaiting_range') {
    return handleWizardRange(ctx, env, userId, state, text);
  }
  return false;
}

async function handleWizardSlug(
  ctx: Context,
  env: Env,
  userId: number,
  state: WizardState,
  text: string
): Promise<boolean> {
  const slug = text.toLowerCase().trim();

  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    await ctx.reply(
      '❌ Slug invalid. Format: <code>lowercase-with-dash</code>\n\nCoba lagi:',
      { parse_mode: 'HTML' }
    );
    return true;
  }

  const loading = await ctx.reply(
    `🔍 Cek <code>${escapeHtml(slug)}</code> ke yukio-data...`,
    { parse_mode: 'HTML' }
  );

  let file: Awaited<ReturnType<typeof githubGetFile>> = null;
  try {
    file = await githubGetFile(env, `src/content/anime/${slug}.md`);
  } catch (err) {
    console.error('[BatchWizard] check failed:', err);
  }

  await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});

  if (!file) {
    await ctx.reply(
      `❌ <b>Slug tidak ditemukan di yukio-data</b>\n\n` +
        `Path: <code>src/content/anime/${escapeHtml(slug)}.md</code>\n\n` +
        `Coba slug lain:`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().text('❌ Batal', 'bw:cancel'),
      }
    );
    return true;
  }

  state.step = 'awaiting_source';
  state.slug = slug;
  await setCache(env.DB, `bw:${userId}`, state, WIZARD_TTL_MS);

  await ctx.reply(
    `✅ <b>Slug ditemukan!</b>\n\n` +
      `<b>Step 2/3</b> · Kirim <b>URL source</b>.\n\n` +
      `🎬 Repo: <code>${escapeHtml(slug)}</code>\n\n` +
      `<b>A. Situs dikenal (slug otomatis):</b>\n` +
      `• <code>https://lexanime.web.id/tonton/{slug}/</code>\n` +
      `• <code>https://animesub.web.id/tonton/{slug}/</code>\n` +
      `• <code>https://samehadaku.li/anime/{slug}/</code>\n\n` +
      `<b>B. Situs lain (custom):</b>\n` +
      `• Kirim URL episode dengan placeholder <code>{n}</code>:\n` +
      `  <code>https://situs.com/foo/episode-{n}</code>\n` +
      `• Atau kirim contoh URL episode (bot auto-detect):\n` +
      `  <code>https://situs.com/foo/episode-1</code>\n` +
      `  <code>https://situs.com/watch/foo/1</code>`,
    {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard().text('❌ Batal', 'bw:cancel'),
    }
  );
  return true;
}

async function handleWizardSource(
  ctx: Context,
  env: Env,
  userId: number,
  state: WizardState,
  text: string
): Promise<boolean> {
  const parsed = parseSourceUrl(text);

  if (!parsed) {
    await ctx.reply(
      '❌ URL tidak dikenali.\n\n' +
        '<b>Situs dikenal:</b>\n' +
        '• <code>https://lexanime.web.id/tonton/{slug}/</code>\n' +
        '• <code>https://animesub.web.id/tonton/{slug}/</code>\n' +
        '• <code>https://samehadaku.li/anime/{slug}/</code>\n\n' +
        '<b>Custom URL:</b> pastikan ada nomor episode, atau pakai placeholder:\n' +
        '• <code>https://situs.com/foo/episode-{n}</code>\n' +
        '• <code>https://situs.com/foo/episode-1</code>\n' +
        '• <code>https://situs.com/watch/foo/1</code>\n\n' +
        'Coba lagi:',
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().text('❌ Batal', 'bw:cancel'),
      }
    );
    return true;
  }

  state.step = 'awaiting_range';
  state.sourceUrl = text.trim();

  if (parsed.kind === 'known') {
    state.sourceSite = parsed.site;
    state.sourceSlug = parsed.slug;
    state.customPattern = null;
  } else {
    state.sourceSite = 'custom';
    state.sourceSlug = parsed.host;
    state.customPattern = parsed.pattern;
  }

  await setCache(env.DB, `bw:${userId}`, state, WIZARD_TTL_MS);

  const siteLabel =
    parsed.kind === 'known' ? parsed.site : `custom (${parsed.host})`;

  let patternLabel: string;
  if (parsed.kind === 'known') {
    const cfg = WIZARD_SITES[parsed.site];
    patternLabel = `${cfg.host}${cfg.episodePath(parsed.slug, 1)}`;
  } else {
    patternLabel = parsed.pattern;
  }

  await ctx.reply(
    `✅ <b>Source OK!</b>\n\n` +
      `<b>Step 3/3</b> · Kirim <b>range episode</b>.\n\n` +
      `🎬 Repo: <code>${escapeHtml(state.slug ?? '?')}</code>\n` +
      `🔗 Site: <b>${escapeHtml(siteLabel)}</b>\n` +
      `📼 URL sample ep 1: <code>${escapeHtml(patternLabel)}</code>\n\n` +
      `<b>Contoh range:</b>\n` +
      `• <code>1-6</code> (ep 1 sampai 6)\n` +
      `• <code>4</code> (hanya ep 4)\n\n` +
      `<i>Kalau file existing sudah ada (misal 1-3), bot akan skip.</i>`,
    {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard().text('❌ Batal', 'bw:cancel'),
    }
  );
  return true;
}

async function handleWizardRange(
  ctx: Context,
  env: Env,
  userId: number,
  state: WizardState,
  text: string
): Promise<boolean> {
  const m = text.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!m) {
    await ctx.reply(
      '❌ Format range salah. Contoh: <code>1-6</code> atau <code>4</code>\n\nCoba lagi:',
      { parse_mode: 'HTML' }
    );
    return true;
  }

  const start = parseInt(m[1] ?? '0', 10);
  const end = m[2] ? parseInt(m[2], 10) : start;

  if (start < 1 || end < start || end - start + 1 > BATCH_MAX) {
    await ctx.reply(
      `❌ Range tidak valid (max ${BATCH_MAX} ep). Contoh: <code>1-6</code>`,
      { parse_mode: 'HTML' }
    );
    return true;
  }

  state.step = 'ready';
  state.rangeStart = start;
  state.rangeEnd = end;
  await setCache(env.DB, `bw:${userId}`, state, WIZARD_TTL_MS);

  const siteLabel = state.sourceSite ?? '-';
  const sourceLabel =
    state.sourceSite === 'custom'
      ? (state.customPattern ?? '-')
      : (state.sourceSlug ?? '-');

  await ctx.reply(
    `📋 <b>Konfirmasi Batch</b>\n\n` +
      `🎬 Repo: <code>${escapeHtml(state.slug ?? '?')}</code>\n` +
      `🔗 Site: <b>${escapeHtml(siteLabel)}</b>\n` +
      `📼 Source: <code>${escapeHtml(sourceLabel)}</code>\n` +
      `📊 Range: <b>${start}-${end}</b> (${end - start + 1} ep)\n\n` +
      `<i>Bot akan cek file existing di <code>episodes/streams/</code>, fetch yang belum ada, lalu merge.</i>`,
    {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .text('🔄 Proses', 'bw:go')
        .text('❌ Batal', 'bw:cancel'),
    }
  );
  return true;
}

async function execBatchWizard(
  ctx: Context,
  env: Env,
  userId: number
): Promise<void> {
  const state = await getCache<WizardState>(env.DB, `bw:${userId}`);
  if (!state || state.step !== 'ready') {
    await ctx.answerCallbackQuery({
      text: '⏱️ Session kadaluarsa',
      show_alert: true,
    });
    return;
  }

  const slug = state.slug;
  const sourceSite = state.sourceSite;
  const rangeStart = state.rangeStart;
  const rangeEnd = state.rangeEnd;

  if (
    !slug ||
    !sourceSite ||
    rangeStart === null ||
    rangeEnd === null
  ) {
    await ctx.answerCallbackQuery({
      text: '⏱️ Session kadaluarsa',
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery({ text: '🔄 Memproses...' });

  const loadingMsgId = ctx.callbackQuery!.message!.message_id!;
  const chatId = ctx.chat!.id;
  const total = rangeEnd - rangeStart + 1;

  /* ── Build URL builder ───────────────────────────────── */
  let epUrlBuilder: (n: number) => string;

  if (sourceSite === 'custom') {
    const pattern = state.customPattern;
    if (!pattern) {
      await ctx.api
        .editMessageText(
          chatId,
          loadingMsgId,
          '❌ Pattern custom hilang. Ulangi /batch.',
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
      return;
    }
    epUrlBuilder = (n) => pattern.replace(/\{n\}/g, String(n));
  } else {
    // TS narrow sourceSite → SiteKey
    const siteConfig = WIZARD_SITES[sourceSite];
    const sourceSlug = state.sourceSlug;
    if (!sourceSlug) {
      await ctx.api
        .editMessageText(
          chatId,
          loadingMsgId,
          '❌ Source slug hilang. Ulangi /batch.',
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
      return;
    }
    epUrlBuilder = (n) =>
      `${siteConfig.host}${siteConfig.episodePath(sourceSlug, n)}`;
  }

  /* ── Read existing chunks ────────────────────────────── */
  const existing = new Map<number, EpisodeObject>();
  try {
    const dir = await githubListDir(env, `data/anime/${slug}/episodes/streams`);
    for (const item of dir) {
      if (item.type !== 'file' || !item.name.endsWith('.json')) continue;
      const file = await githubGetFile(
        env,
        `data/anime/${slug}/episodes/streams/${item.name}`
      );
      if (!file) continue;
      try {
        const eps = JSON.parse(file.content) as unknown;
        if (Array.isArray(eps)) {
          for (const ep of eps as EpisodeObject[]) {
            if (typeof ep.number === 'number') existing.set(ep.number, ep);
          }
        }
      } catch {
        /* ignore malformed */
      }
    }
  } catch (err) {
    console.warn('[BatchWizard] read existing failed:', err);
  }

  /* ── Fetch loop ──────────────────────────────────────── */
  const merged: EpisodeObject[] = [];
  const errors: { number: number; error: string }[] = [];
  const added: number[] = [];
  const skipped: number[] = [];

  for (let n = rangeStart; n <= rangeEnd; n++) {
    const cached = existing.get(n);
    if (cached) {
      merged.push(cached);
      skipped.push(n);
      continue;
    }

    await ctx.api
      .editMessageText(
        chatId,
        loadingMsgId,
        `📦 <b>Batch ${rangeStart}-${rangeEnd}</b>\n\n` +
          `⏳ [${n - rangeStart + 1}/${total}] Episode ${n}...`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      )
      .catch(() => {});

    const epUrl = epUrlBuilder(n);
    const { body, debug } = await fetchUrlViaProxy(env, epUrl);

    if (!body) {
      errors.push({ number: n, error: debug.error ?? 'fetch failed' });
      continue;
    }

    const sourceType: 'base64' | 'html' = looksLikeHtml(body) ? 'html' : 'base64';
    const processed = decodeInput(body, sourceType);
    if (!processed) {
      errors.push({ number: n, error: `no video URLs (${body.length} char)` });
      continue;
    }

    merged.push(buildEpisodeObject(processed.videos, n));
    added.push(n);
  }

  merged.sort((a, b) => a.number - b.number);

  const first = merged[0];
  const last = merged[merged.length - 1];
  if (!first || !last) {
    await ctx.api
      .editMessageText(
        chatId,
        loadingMsgId,
        '❌ Tidak ada episode yang berhasil di-fetch.',
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
    return;
  }

  const minEp = first.number;
  const maxEp = last.number;
  const combinedJson = JSON.stringify(merged, null, 2) + '\n';
  const totalUrls = merged.reduce(
    (sum, r) => sum + r.streams.reduce((s, q) => s + q.servers.length, 0),
    0
  );

  const targetPath = `data/anime/${slug}/episodes/streams/${minEp}-${maxEp}.json`;

  try {
    const result = await githubCommitFile(
      env,
      targetPath,
      combinedJson,
      `feat(streams): batch ${minEp}-${maxEp} for ${slug}`
    );

    if (!result.ok) {
      await ctx.api
        .editMessageText(
          chatId,
          loadingMsgId,
          `❌ <b>Gagal push</b>\n\n<code>${escapeHtml(result.error ?? 'unknown')}</code>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
      return;
    }

    const lines: string[] = [];
    lines.push(`✅ <b>Batch ${minEp}-${maxEp} selesai & pushed!</b>`);
    lines.push('');
    lines.push(`🎬 <code>${escapeHtml(slug)}</code>`);
    lines.push(`📁 <code>${escapeHtml(targetPath)}</code>`);
    lines.push('');
    lines.push(`📦 Total: <b>${merged.length}</b> ep (${minEp}-${maxEp})`);
    lines.push(`🎬 URL: <b>${totalUrls}</b>`);

    if (skipped.length > 0) {
      lines.push(`⏭️ Skip (existing): Ep ${skipped.join(', ')}`);
    }
    if (added.length > 0) {
      lines.push(`➕ Baru: Ep ${added.join(', ')}`);
    }

    if (errors.length > 0) {
      lines.push('');
      lines.push(`⚠️ Gagal: ${errors.length} ep`);
      for (const e of errors.slice(0, 3)) {
        lines.push(`   • Ep ${e.number}: ${escapeHtml(e.error.slice(0, 60))}`);
      }
    }

    lines.push('');
    lines.push(`🔗 Commit: <code>${result.sha?.slice(0, 7) ?? '?'}</code>`);
    lines.push('');
    lines.push('<i>Lanjut range berikutnya? Slug & source tetap.</i>');

    await ctx.api
      .editMessageText(chatId, loadingMsgId, lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text('🔄 Range Baru', 'bw:next')
          .text('➕ Anime Baru', 'bw:start')
          .row()
          .text('🏠 Close', 'bw:close'),
      })
      .catch(() => {});

    // Retain slug + source, reset range
    const nextState: WizardState = {
      step: 'awaiting_range',
      slug: state.slug,
      sourceUrl: state.sourceUrl,
      sourceSite: state.sourceSite,
      sourceSlug: state.sourceSlug,
      customPattern: state.customPattern,
      rangeStart: null,
      rangeEnd: null,
    };
    await setCache(env.DB, `bw:${userId}`, nextState, WIZARD_TTL_MS);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('[BatchWizard] push failed:', err);
    await ctx.api
      .editMessageText(
        chatId,
        loadingMsgId,
        `❌ <b>Error:</b> <code>${escapeHtml(msg.slice(0, 300))}</code>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
}

export function setupBatchWizardCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^bw:start$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '📦' });
    await startBatchWizard(ctx, env);
  });

  bot.callbackQuery(/^bw:next$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = await getCache<WizardState>(env.DB, `bw:${userId}`);
    if (!state || !state.slug || !state.sourceSite) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Session habis. Kirim /batch lagi.',
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: '🔄' });

    const siteLabel =
      state.sourceSite === 'custom'
        ? `custom (${state.sourceSlug ?? '-'})`
        : state.sourceSite;
    const sourceLabel =
      state.sourceSite === 'custom'
        ? (state.customPattern ?? '-')
        : (state.sourceSlug ?? '-');

    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        ctx.callbackQuery!.message!.message_id!,
        `🔄 <b>Range Baru</b>\n\n` +
          `🎬 Repo: <code>${escapeHtml(state.slug)}</code>\n` +
          `🔗 Site: <b>${escapeHtml(siteLabel)}</b>\n` +
          `📼 Source: <code>${escapeHtml(sourceLabel)}</code>\n\n` +
          `Kirim <b>range episode</b> baru.\n` +
          `Contoh: <code>7-12</code> atau <code>13</code>`,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard().text('❌ Batal', 'bw:cancel'),
        }
      )
      .catch(() => {});
  });

  bot.callbackQuery(/^bw:go$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    await execBatchWizard(ctx, env, userId);
  });

  bot.callbackQuery(/^bw:cancel$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) await deleteCache(env.DB, `bw:${userId}`);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageText('❌ <b>Batch dibatalkan.</b>', {
        parse_mode: 'HTML',
        reply_markup: undefined,
      })
      .catch(() => {});
  });

  bot.callbackQuery(/^bw:close$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) await deleteCache(env.DB, `bw:${userId}`);
    await ctx.answerCallbackQuery({ text: '🏠' });
    await ctx
      .editMessageReplyMarkup({ reply_markup: undefined })
      .catch(() => {});
  });
}

export const batchCommand: CommandDefinition = {
  name: 'batch',
  description: 'Batch scrape episode (wizard)',
  usage: '/batch',
  adminOnly: true,

  handler: async (ctx, env) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';

    if (arg.toLowerCase() === 'reset') {
      const userId = ctx.from?.id;
      if (!userId) return;
      await deleteCache(env.DB, `bw:${userId}`);
      await ctx.reply('✅ Session batch di-reset.', { parse_mode: 'HTML' });
      return;
    }

    await startBatchWizard(ctx, env);
  },
};