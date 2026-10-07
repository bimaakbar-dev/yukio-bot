// src/commands/anime.ts
import type { CommandDefinition } from './registry';
import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { AniListMedia } from '../types/anime';
import type { Env } from '../types/env';
import {
  searchYukionime,
  getYukionimeDetail,
  isYukionimeComplete,
  yukionimeToAniListMedia,
  type YukionimeAnime,
} from '../services/yukionime';
import { getCache, setCache } from '../lib/cache';
import {
  searchAnime,
  detectMissing,
  enrichWithAITimeout,
  buildQimochiHubResult,
  pickTitle,
  isValidHttpUrl,
  type Enriched,
} from '../services/anime-core';
import { escapeHtml, slugify } from '../lib/utils';
import {
  saveTempAnime,
  getTempAnime,
  deleteTempAnime,
} from '../lib/temp-anime';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function buildInfoMessage(media: AniListMedia): string {
  const title = pickTitle(media);
  const year = media.startDate?.year ?? media.seasonYear ?? '-';
  const studio = media.studios?.nodes?.[0]?.name ?? 'Unknown';
  const genres = (media.genres ?? []).slice(0, 3).join(', ') || '-';
  const rating = media.averageScore
    ? (media.averageScore / 10).toFixed(1)
    : '-';

  const FORMAT_MAP: Record<string, string> = {
    TV: 'TV',
    TV_SHORT: 'TV',
    MOVIE: 'Movie',
    SPECIAL: 'Special',
    OVA: 'OVA',
    ONA: 'ONA',
    MUSIC: 'Special',
  };

  const STATUS_MAP: Record<string, string> = {
    FINISHED: 'Completed',
    RELEASING: 'Ongoing',
    NOT_YET_RELEASED: 'Ongoing',
    CANCELLED: 'Hiatus',
    HIATUS: 'Hiatus',
  };

  const status = STATUS_MAP[media.status] ?? media.status;
  const type = FORMAT_MAP[media.format] ?? media.format;

  return (
    `<b>${escapeHtml(title)}</b>\n\n` +
    `📅 Tahun: ${year}\n` +
    `🎬 Tipe: ${type}\n` +
    `📌 Status: ${status}\n` +
    `📼 Episode: ${media.episodes ?? '-'}\n` +
    `🏢 Studio: ${escapeHtml(studio)}\n` +
    `🏷️ Genre: ${escapeHtml(genres)}\n` +
    `⭐ Rating: ${rating}`
  );
}

function isMALUrl(s: string): boolean {
  return /^https?:\/\/(www\.)?myanimelist\.net\/anime\/\d+/i.test(s.trim());
}

function extractTitleFromMALUrl(url: string): string | null {
  const m = url.match(/myanimelist\.net\/anime\/\d+\/([^\/\?#]+)/i);
  if (!m) return null;
  const slug = m[1];
  if (!slug) return null;
  return decodeURIComponent(slug).replace(/_/g, ' ').trim() || null;
}

interface YukionimeCheckResult {
  match: YukionimeAnime | null;
  synopsis: string | null;
  complete: boolean;
}

async function checkYukionime(
  query: string
): Promise<YukionimeCheckResult> {
  try {
    const match = await searchYukionime(query);
    if (!match) return { match: null, synopsis: null, complete: false };

    const detail = await getYukionimeDetail(match.id);
    const synopsis = detail?.synopsis ?? null;

    const merged: YukionimeAnime = {
      ...match,
      ...(detail ?? {}),
      synopsis,
    };

    const complete = isYukionimeComplete(merged);

    return { match: merged, synopsis, complete };
  } catch (err) {
    console.warn('[Anime] yukionime check failed:', err);
    return { match: null, synopsis: null, complete: false };
  }
}

function buildYukionimeWarning(
  match: YukionimeAnime,
  synopsis: string | null,
  isComplete: boolean
): string {
  const lines: string[] = [];
  lines.push('⚠️ <b>Sudah ada di database Yukionime!</b>');
  lines.push('');
  lines.push(`🆔 <b>Slug:</b> <code>${escapeHtml(match.id)}</code>`);
  lines.push(`📌 <b>Judul:</b> ${escapeHtml(match.title)}`);

  if (match.year) lines.push(`📅 <b>Tahun:</b> ${match.year}`);
  if (match.type) lines.push(`🎬 <b>Tipe:</b> ${escapeHtml(match.type)}`);
  if (match.status) lines.push(`📊 <b>Status:</b> ${escapeHtml(match.status)}`);

  if (synopsis) {
    const preview =
      synopsis.slice(0, 200) + (synopsis.length > 200 ? '…' : '');
    lines.push('');
    lines.push('📝 <b>Sinopsis:</b>');
    lines.push(`<i>${escapeHtml(preview)}</i>`);
  }

  lines.push('');
  if (isComplete) {
    lines.push('✅ <i>Data lengkap. Langsung dipakai (skip AniList).</i>');
  } else {
    lines.push(
      '⚠️ <i>Data tidak lengkap. Lanjut cari di AniList untuk melengkapi.</i>'
    );
  }

  lines.push('');
  lines.push(
    `🔗 <a href="https://yukionime.pages.dev/anime/${escapeHtml(match.id)}/">Lihat halaman</a>`
  );

  return lines.join('\n');
}

export const animeCommand: CommandDefinition = {
  name: 'anime',
  description: 'Cari metadata anime → tombol convert YAML',
  usage: '/anime nama anime',
  adminOnly: true,

  handler: async (ctx, env) => {
    const T0 = Date.now();

    const argQuery = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const repliedText = ctx.message?.reply_to_message?.text ?? '';
    const query = argQuery || repliedText;

    if (!query) {
      await ctx.reply(
        '<b>🔍 Cari Metadata Anime</b>\n\n' +
          '<b>Contoh:</b>\n' +
          '<code>/anime jujutsu kaisen</code>\n\n' +
          '<b>Atau URL MAL:</b>\n' +
          '<code>/anime https://myanimelist.net/anime/40748</code>\n\n' +
          '<i>Setelah data siap, klik tombol untuk convert ke YAML.</i>',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    const loading = await ctx.reply('🔍 Mencari...');

    try {
      let searchQuery = query;

      if (isMALUrl(query)) {
        const t = extractTitleFromMALUrl(query);
        if (t) searchQuery = t;
      }

      const yukionime = await checkYukionime(searchQuery);

      if (yukionime.match && yukionime.complete) {
        console.log('[Anime] yukionime complete — skip AniList');

        await ctx.api
          .deleteMessage(ctx.chat!.id, loading.message_id)
          .catch(() => {});

        await ctx.reply(
          buildYukionimeWarning(yukionime.match, yukionime.synopsis, true),
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          }
        );

        const media = yukionimeToAniListMedia({
          ...yukionime.match,
          synopsis: yukionime.synopsis,
        });

        const result = buildQimochiHubResult(media, null);
        const slug = yukionime.match.id;

        const sessionId = await saveTempAnime(env.DB, ctx.from!.id, {
          yaml: result.yaml,
          body: result.body,
          missing: result.missing,
          aiUsed: result.aiUsed,
          cover: yukionime.match.image ?? null,
          sourceLabel: '📚 Dari Yukionime (database)',
          slug,
        });

        const keyboard = new InlineKeyboard()
          .text('📋 Convert ke YAML', `an:y:${sessionId}`)
          .text('❌ Batal', `an:x:${sessionId}`);

        await ctx.reply(
          '✅ <b>Data siap!</b> (dari database Yukionime)\n\n' +
            'Klik tombol di bawah untuk convert ke <b>YAML</b> + sinopsis.',
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: keyboard,
          }
        );

        console.log(`[Anime] total: ${Date.now() - T0}ms (yukionime)`);
        return;
      }

      if (yukionime.match) {
        await ctx.reply(
          buildYukionimeWarning(yukionime.match, yukionime.synopsis, false),
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          }
        );
      }

      let media: AniListMedia | null = null;
      let sourceLabel = '';

      const cacheKey = `anime:${searchQuery.toLowerCase().trim()}`;
      media = await getCache<AniListMedia>(env.DB, cacheKey);

      if (media) {
        sourceLabel = '⚡ Dari cache';
        console.log(`[Anime] cache hit at ${Date.now() - T0}ms`);
      } else {
        try {
          const result = await searchAnime(searchQuery);
          media = result.media;
          sourceLabel = `📡 Sumber: ${result.source}`;

          const hasStudio =
            media.studios?.nodes?.[0]?.name &&
            media.studios.nodes[0].name !== 'Unknown';

          if (hasStudio) {
            await setCache(env.DB, cacheKey, media, CACHE_TTL_MS);
            console.log('[Anime] cached (studio present)');
          } else {
            console.log('[Anime] NOT cached (studio missing)');
          }
        } catch (err) {
          console.warn('[Anime] search failed:', err);
        }
        console.log(`[Anime] fetch stage done at ${Date.now() - T0}ms`);
      }

      if (!media) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ Anime "<b>${escapeHtml(searchQuery)}</b>" tidak ditemukan.\n\n` +
            `<i>Kemungkinan:</i>\n` +
            `• Judul tidak ada di database\n` +
            `• Semua API sedang down / rate limit\n\n` +
            `<i>Coba lagi beberapa menit.</i>`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        buildInfoMessage(media),
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );

      let need = detectMissing(media);

      if (yukionime.synopsis) {
        need = need.filter((n) => n !== 'synopsis');
        console.log('[Anime] skip AI synopsis (yukionime punya)');
      }

      console.log(
        `[Anime] missing after merge: [${need.join(', ') || 'none'}]`
      );

      let enriched: Enriched | null = null;

      if (need.length > 0) {
        const aiLoading = await ctx.reply(
          `🤖 AI melengkapi: <code>${need.join(', ')}</code>...`,
          { parse_mode: 'HTML' }
        );

        enriched = await enrichWithAITimeout(
          env,
          pickTitle(media),
          {
            studio: media.studios?.nodes?.[0]?.name,
            rating: media.averageScore ? media.averageScore / 10 : null,
            genre: media.genres,
            releaseDate: media.startDate?.year
              ? `${media.startDate.year}-01-01`
              : null,
            originalSynopsis: media.description,
          },
          need
        );

        console.log(`[Anime] AI stage done at ${Date.now() - T0}ms`);

        if (enriched) {
          await ctx.api
            .editMessageText(
              ctx.chat!.id,
              aiLoading.message_id,
              `✅ AI selesai: <code>${need.join(', ')}</code>`,
              { parse_mode: 'HTML' }
            )
            .catch(() => {});
        } else {
          await ctx.api
            .editMessageText(
              ctx.chat!.id,
              aiLoading.message_id,
              `⚠️ AI tidak bisa melengkapi: <code>${need.join(
                ', '
              )}</code>\n<i>Field ini perlu diisi manual.</i>`,
              { parse_mode: 'HTML' }
            )
            .catch(() => {});
          console.warn('[Anime] AI failed or timeout — no retry');
        }
      } else {
        console.log('[Anime] no AI needed — skipping');
      }

      if (yukionime.synopsis) {
        enriched = { ...(enriched ?? {}), synopsis: yukionime.synopsis };
      }

      const result = buildQimochiHubResult(media, enriched);
      const { yaml, body, missing } = result;
      let aiUsed = result.aiUsed;

      if (yukionime.synopsis) {
        aiUsed = aiUsed.map((f) =>
          f === 'synopsis' ? 'synopsis (dari Yukionime)' : f
        );
      }

      const slug = slugify(pickTitle(media));

      const sessionId = await saveTempAnime(env.DB, ctx.from!.id, {
        yaml,
        body,
        missing,
        aiUsed,
        cover: media.coverImage.extraLarge || media.coverImage.large || null,
        sourceLabel: sourceLabel || null,
        slug,
      });

      const keyboard = new InlineKeyboard()
        .text('📋 Convert ke YAML', `an:y:${sessionId}`)
        .text('❌ Batal', `an:x:${sessionId}`);

      await ctx.reply(
        '✅ <b>Data siap!</b>\n\n' +
          'Klik tombol di bawah untuk convert ke <b>YAML</b> + sinopsis.',
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard,
        }
      );

      console.log(`[Anime] total: ${Date.now() - T0}ms`);
    } catch (err: any) {
      const elapsed = Date.now() - T0;
      console.error(`[Anime] error after ${elapsed}ms:`, err);

      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ <b>Gagal memuat data</b> (${elapsed}ms)\n\n` +
            `Error: <code>${escapeHtml(err?.message ?? 'unknown')}</code>\n\n` +
            `<i>Coba lagi beberapa menit.</i>`,
          { parse_mode: 'HTML' }
        );
      } catch {
        await ctx
          .reply(`❌ Gagal: ${escapeHtml(err?.message ?? 'unknown')}`)
          .catch(() => {});
      }
    }
  },
};

export function setupAnimeCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^an:y:([a-f0-9]+)$/, async (ctx) => {
    const [, sessionId] = ctx.match as RegExpMatchArray;
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌ Session tidak valid' });
      return;
    }

    const session = await getTempAnime(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Session kadaluarsa. Ulangi /anime.',
        show_alert: true,
      });
      await ctx
        .editMessageReplyMarkup({ reply_markup: undefined })
        .catch(() => {});
      return;
    }

    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '📋 Convert...' });

    await ctx
      .editMessageReplyMarkup({ reply_markup: undefined })
      .catch(() => {});

    const missing: string[] = JSON.parse(session.missing);
    const aiUsed: string[] = JSON.parse(session.ai_used);

    const warnLines: string[] = [];
    if (missing.length > 0) {
      warnLines.push('⚠️ <b>Perlu edit manual:</b>');
      for (const f of missing)
        warnLines.push(`• <code>${escapeHtml(f)}</code>`);
      warnLines.push('');
    }
    if (aiUsed.length > 0) {
      warnLines.push('🤖 <b>Diisi AI / dari sumber (VERIFIKASI):</b>');
      for (const f of aiUsed)
        warnLines.push(`• <code>${escapeHtml(f)}</code>`);
    }
    if (warnLines.length > 0) {
      await ctx.reply(warnLines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    }

    const slug = session.slug ?? 'unknown';
    await ctx.reply(
      `🆔 <b>Slug</b>\n<i>Buat file: <code>${escapeHtml(slug)}.md</code></i>\n\n` +
        `<pre>${escapeHtml(slug)}</pre>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );

    await ctx.reply(
      `📋 <b>YAML Frontmatter</b>\n\n<pre>${escapeHtml(session.yaml)}</pre>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );

    const bodyMax = 3500;
    const bodyPreview =
      session.body.length > bodyMax
        ? session.body.slice(0, bodyMax) + '\n\n… [truncated]'
        : session.body;

    await ctx.reply(
      `📝 <b>Body (Sinopsis)</b>\n\n<pre>${escapeHtml(bodyPreview)}</pre>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );

    if (session.cover && isValidHttpUrl(session.cover)) {
      try {
        await ctx.replyWithPhoto(session.cover);
      } catch (err) {
        console.warn('[Anime] Failed to send cover:', err);
      }
    }

    if (session.source_label) {
      await ctx.reply(session.source_label);
    }

    const targetPath = `src/content/anime/${slug}.md`;

    const pubKb = new InlineKeyboard()
      .text('📤 Publish ke Web', `pub:an:${sessionId}`)
      .text('❌ Batal', `pub:skip:${sessionId}`);

    await ctx.reply(
      `✅ <b>Review selesai?</b>\n\n` +
        `📁 Target:\n<code>${escapeHtml(targetPath)}</code>\n\n` +
        `Kalau cocok, klik tombol Publish di bawah.`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: pubKb,
      }
    );
  });

  bot.callbackQuery(/^an:x:([a-f0-9]+)$/, async (ctx) => {
    const [, sessionId] = ctx.match as RegExpMatchArray;
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌ Session tidak valid' });
      return;
    }

    const session = await getTempAnime(env.DB, sessionId);
    if (session && ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }

    if (sessionId) await deleteTempAnime(env.DB, sessionId);

    await ctx
      .editMessageText('❌ <b>Dibatalkan.</b>', {
        parse_mode: 'HTML',
        reply_markup: undefined,
      })
      .catch(() => {});

    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
  });
}