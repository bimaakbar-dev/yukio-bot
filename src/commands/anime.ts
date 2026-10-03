import type { CommandDefinition } from './registry';
import { searchAniList, type AniListMedia } from '../services/anilist';
import { searchJikan, jikanToAniList } from '../services/jikan';
import { getCache, setCache } from '../lib/cache';
import {
  scrapeMALById,
  isMALUrl,
  extractMALId,
} from '../services/scraper';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pickTitle(media: AniListMedia): string {
  return (
    media.title.romaji ||
    media.title.english ||
    media.title.native ||
    'Unknown'
  );
}

function buildInfoMessage(media: AniListMedia): string {
  const title = pickTitle(media);
  const year = media.startDate?.year ?? media.seasonYear ?? '-';
  const studio = media.studios?.nodes?.[0]?.name ?? 'Unknown';
  const genres = (media.genres ?? []).slice(0, 3).join(', ') || '-';
  const rating = media.averageScore
    ? (media.averageScore / 10).toFixed(1)
    : '-';
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

function buildYaml(media: AniListMedia): string {
  const title = pickTitle(media);
  const cover = media.coverImage.extraLarge || media.coverImage.large;
  const type = FORMAT_MAP[media.format] ?? 'TV';
  const status = STATUS_MAP[media.status] ?? 'Ongoing';
  const studio = media.studios?.nodes?.[0]?.name ?? 'Unknown';
  const genres = (media.genres ?? []).slice(0, 3).join(', ');
  const rating = media.averageScore
    ? (media.averageScore / 10).toFixed(1)
    : '0';

  const y = media.startDate?.year ?? media.seasonYear ?? 2020;
  const mo = String(media.startDate?.month ?? 1).padStart(2, '0');
  const d = String(media.startDate?.day ?? 1).padStart(2, '0');
  const releaseDate = `${y}-${mo}-${d}`;
  const addedAt = new Date().toISOString().split('T')[0];
  const needsQuote = /[:#&*!|>'"%@`{}[\],]/.test(title);
  const safeTitle = needsQuote ? `"${title.replace(/"/g, '\\"')}"` : title;

  return `---
title: ${safeTitle}
cover: ${cover}
type: ${type}
status: ${status}
genre: [${genres}]
studio: ${studio}
releaseDate: ${releaseDate}
addedAt: ${addedAt}
rating: ${rating}
episodes: []
---`;
}

async function fetchMetadata(query: string): Promise<{
  media: AniListMedia;
  source: 'anilist' | 'jikan';
} | null> {
  // 1. AniList
  try {
    const media = await searchAniList(query);
    if (media) return { media, source: 'anilist' };
  } catch (err) {
    console.warn(
      '[Anime] AniList failed:',
      err instanceof Error ? err.message : String(err)
    );
  }

  // 2. Jikan
  try {
    const jikan = await searchJikan(query);
    if (jikan) return { media: jikanToAniList(jikan), source: 'jikan' };
  } catch (err) {
    console.warn(
      '[Anime] Jikan failed:',
      err instanceof Error ? err.message : String(err)
    );
  }

  return null;
}

export const animeCommand: CommandDefinition = {
  name: 'anime',
  description: 'Cari metadata anime',
  usage: '/anime jujutsu kaisen\n/anime https://myanimelist.net/anime/40748',
  adminOnly: true,

  handler: async (ctx, env) => {
    const argQuery = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const repliedText = ctx.message?.reply_to_message?.text ?? '';
    const query = argQuery || repliedText;

    if (!query) {
      await ctx.reply(
        'Kasih judul anime-nya.\n\n' +
          '<b>Contoh:</b>\n' +
          '<code>/anime jujutsu kaisen</code>\n\n' +
          '<b>Atau URL MyAnimeList:</b>\n' +
          '<code>/anime https://myanimelist.net/anime/40748</code>',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const loading = await ctx.reply('🔍 Mencari...');

    try {
      let media: AniListMedia | null = null;
      let sourceLabel = '';
      let fromCache = false;

      // ─── Mode 1: MAL URL ───
      if (isMALUrl(query)) {
        const malId = extractMALId(query);
        if (!malId) {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            loading.message_id,
            '❌ URL MyAnimeList tidak valid.'
          );
          return;
        }

        media = await scrapeMALById(malId);
        sourceLabel = '📥 Scraped dari MyAnimeList';

        if (media) {
          // Cache juga biar bisa di-search nanti
          const cacheKey = `anime:${pickTitle(media).toLowerCase().trim()}`;
          await setCache(env.DB, cacheKey, media, CACHE_TTL_MS);
        }
      }
      // ─── Mode 2: Judul (cari via API) ───
      else {
        const cacheKey = `anime:${query.toLowerCase().trim()}`;
        media = await getCache<AniListMedia>(env.DB, cacheKey);
        fromCache = !!media;

        if (!media) {
          const result = await fetchMetadata(query);
          if (result) {
            media = result.media;
            sourceLabel = `📡 Sumber: ${result.source}`;
            await setCache(env.DB, cacheKey, media, CACHE_TTL_MS);
          }
        } else {
          sourceLabel = '⚡ Dari cache';
        }
      }

      // ─── Tidak ketemu ───
      if (!media) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ Anime "${escapeHtml(query)}" tidak ditemukan.\n\n` +
            `<i>Coba:</i>\n` +
            `• Pakai URL MAL langsung\n` +
            `• Tunggu beberapa menit (API sedang down)`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // ─── Info card ───
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        buildInfoMessage(media),
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );

      // ─── YAML ───
      const yaml = buildYaml(media);
      await ctx.reply(
        `<b>YAML Frontmatter</b>\n\n<pre><code class="language-yaml">${escapeHtml(yaml)}</code></pre>`,
        { parse_mode: 'HTML' }
      );

      // ─── Cover ───
      const cover = media.coverImage.extraLarge || media.coverImage.large;
      if (cover) {
        try {
          await ctx.replyWithPhoto(cover);
        } catch (err) {
          console.warn('[Anime] Failed to send cover:', err);
        }
      }

      // ─── Source label ───
      if (sourceLabel) {
        await ctx.reply(sourceLabel);
      }
    } catch (err: any) {
      console.error('[Anime] error:', err);
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ Error: ${escapeHtml(err?.message ?? 'unknown')}`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    }
  },
};