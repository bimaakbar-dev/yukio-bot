import type { CommandDefinition } from './registry';
import { searchAniList, type AniListMedia } from '../services/anilist';
import { searchJikan, jikanToAniList } from '../services/jikan';
import { getCache, setCache } from '../lib/cache';

// Cache TTL: 30 hari
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ──────────────────────────────────────────────────────────
// Mapping helpers
// ──────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────
// Format helpers
// ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

  // Quote title kalau mengandung karakter YAML spesial
  const needsQuote = /[:#&*!|>'"%@`{}[\],]/.test(title);
  const safeTitle = needsQuote
    ? `"${title.replace(/"/g, '\\"')}"`
    : title;

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

// ──────────────────────────────────────────────────────────
// Fetch metadata dengan fallback
// ──────────────────────────────────────────────────────────

async function fetchMetadata(query: string): Promise<{
  media: AniListMedia;
  source: 'anilist' | 'jikan';
} | null> {
  // 1. Coba AniList (data paling lengkap)
  try {
    const media = await searchAniList(query);
    if (media) return { media, source: 'anilist' };
  } catch (err) {
    console.warn('[Anime] AniList failed:', err);
  }

  // 2. Fallback ke Jikan (MAL)
  try {
    const jikan = await searchJikan(query);
    if (jikan) return { media: jikanToAniList(jikan), source: 'jikan' };
  } catch (err) {
    console.warn('[Anime] Jikan failed:', err);
  }

  return null;
}

// ──────────────────────────────────────────────────────────
// Command definition
// ──────────────────────────────────────────────────────────

export const animeCommand: CommandDefinition = {
  name: 'anime',
  description: 'Cari metadata anime',
  usage: '/anime jujutsu kaisen',
  adminOnly: true,

  handler: async (ctx, env) => {
    // Ambil query dari arg atau dari pesan yang di-reply
    const argQuery = ctx.match?.trim() ?? '';
    const repliedText = ctx.message?.reply_to_message?.text ?? '';
    const query = argQuery || repliedText;

    if (!query) {
      await ctx.reply(
        'Kasih judul anime-nya.\n\n' +
          '<b>Contoh:</b>\n' +
          '<code>/anime jujutsu kaisen</code>\n\n' +
          'Atau reply ke pesan yang berisi judul, lalu kirim <code>/anime</code>.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const loading = await ctx.reply('🔍 Mencari...');

    try {
      // Cek cache D1 dulu
      const cacheKey = `anime:${query.toLowerCase().trim()}`;
      let media = await getCache<AniListMedia>(env.DB, cacheKey);
      let fromCache = !!media;

      if (!media) {
        const result = await fetchMetadata(query);
        if (!result) {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            loading.message_id,
            `❌ Anime "${escapeHtml(query)}" tidak ditemukan.`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        media = result.media;
        await setCache(env.DB, cacheKey, media, CACHE_TTL_MS);
      }

      // ── Edit loading → info card
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        buildInfoMessage(media),
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );

      // ── Kirim YAML frontmatter
      const yaml = buildYaml(media);
      await ctx.reply(
        `<b>YAML Frontmatter</b>\n\n<pre><code class="language-yaml">${escapeHtml(yaml)}</code></pre>`,
        { parse_mode: 'HTML' }
      );

      // ── Kirim cover image
      const cover = media.coverImage.extraLarge || media.coverImage.large;
      if (cover) {
        try {
          await ctx.replyWithPhoto(cover);
        } catch (err) {
          console.warn('[Anime] Failed to send cover:', err);
        }
      }

      // ── Info kalau dari cache
      if (fromCache) {
        await ctx.reply('⚡ Dari cache');
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