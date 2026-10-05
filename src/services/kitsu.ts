// src/services/kitsu.ts
import { fetchWithRetry } from '../lib/http';
import type { AniListMedia } from '../types/anime';

const KITSU_URL = 'https://kitsu.io/api/edge/anime';

interface KitsuAnime {
  id: string;
  attributes?: {
    canonicalTitle?: string;
    titles?: {
      en?: string;
      en_jp?: string;
      ja_jp?: string;
    };
    posterImage?: {
      large?: string;
      original?: string;
    };
    coverImage?: {
      large?: string;
      original?: string;
    } | null;
    subtype?: string;
    status?: string;
    startDate?: string | null;
    endDate?: string | null;
    episodeCount?: number | null;
    episodeLength?: number | null;
    averageRating?: string | null;
    ageRating?: string | null;
    youtubeVideoId?: string | null;
    synopsis?: string | null;
  };
  relationships?: {
    categories?: { data?: { type: string; id: string }[] };
  };
}

interface KitsuIncluded {
  id: string;
  type: string;
  attributes?: {
    title?: string;
    name?: string;
  };
}

interface KitsuResponse {
  data?: KitsuAnime[];
  included?: KitsuIncluded[];
}

interface KitsuSearchResult {
  anime: KitsuAnime;
  genres: string[];
}

export async function searchKitsu(
  title: string
): Promise<KitsuSearchResult | null> {
  const params = new URLSearchParams();
  params.set('filter[text]', title);
  params.set('include', 'categories');
  params.set('page[limit]', '1');

  const url = `${KITSU_URL}?${params.toString()}`;

  console.log(`[Kitsu] URL: ${url}`);

  const res = await fetchWithRetry(url, {
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      'User-Agent': 'yukio-bot/1.0',
    },
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Kitsu HTTP ${res.status}: ${errBody.slice(0, 100)}`);
  }

  const json = (await res.json()) as KitsuResponse;
  const anime = json.data?.[0];
  if (!anime) return null;

  const included = Array.isArray(json.included) ? json.included : [];

  const categoryIds = (anime.relationships?.categories?.data ?? []).map(
    (r): string => r.id
  );

  const genres: string[] = included
    .filter((i): boolean => i.type === 'categories' && categoryIds.includes(i.id))
    .map((i): string => i.attributes?.title ?? '')
    .filter((t: string): boolean => t.length > 0)
    .slice(0, 5);

  return { anime, genres };
}

/* ============================================================
   HELPERS
   ============================================================ */

function parseKitsuDate(dateStr: string | null | undefined): {
  year: number | null;
  month: number | null;
  day: number | null;
} | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

/**
 * Map age rating Kitsu → enum QimochiDB.
 * Kitsu: G, PG, R, R18, PG-13 (jarang)
 * QimochiDB: G, PG, PG-13, R, R+, Rx
 */
function mapKitsuRating(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();

  const map: Record<string, string> = {
    g: 'G',
    pg: 'PG',
    'pg-13': 'PG-13',
    pg13: 'PG-13',
    r: 'R',
    'r+': 'R+',
    r18: 'Rx',
    rx: 'Rx',
  };

  return map[lower] ?? null;
}

function buildYoutubeUrl(videoId: string | null | undefined): string | null {
  if (!videoId || videoId.trim() === '') return null;
  return `https://youtu.be/${videoId.trim()}`;
}

/* ============================================================
   MAPPER
   ============================================================ */

export function kitsuToAniList(result: KitsuSearchResult): AniListMedia {
  const { anime, genres } = result;
  const attr = anime.attributes ?? {};

  const format = (attr.subtype || 'TV').toUpperCase();

  let status = 'RELEASING';
  if (attr.status === 'finished') status = 'FINISHED';
  else if (attr.status === 'upcoming') status = 'NOT_YET_RELEASED';
  else if (attr.status === 'tba') status = 'NOT_YET_RELEASED';
  else if (attr.status === 'current') status = 'RELEASING';

  const averageScore = attr.averageRating
    ? Math.round(parseFloat(attr.averageRating))
    : null;

  const cover = attr.posterImage?.large || attr.posterImage?.original || '';

  const startDate = parseKitsuDate(attr.startDate);
  const endDate = parseKitsuDate(attr.endDate);

  // Banner = coverImage (landscape) — beda dari posterImage (portrait)
  const banner =
    attr.coverImage?.large || attr.coverImage?.original || null;

  const duration =
    attr.episodeLength && attr.episodeLength > 0
      ? attr.episodeLength
      : null;

  const rating = mapKitsuRating(attr.ageRating);
  const trailer = buildYoutubeUrl(attr.youtubeVideoId);

  return {
    id: parseInt(anime.id, 10),
    title: {
      romaji: attr.titles?.en_jp ?? attr.canonicalTitle ?? 'Unknown',
      english: attr.titles?.en ?? null,
      native: attr.titles?.ja_jp ?? null,
    },
    coverImage: {
      extraLarge: cover,
      large: cover,
    },
    description: attr.synopsis ?? null,
    format,
    status,
    seasonYear: startDate?.year ?? null,
    episodes: attr.episodeCount ?? null,
    genres: Array.isArray(genres) ? genres : [],
    averageScore,
    studios: { nodes: [] },
    startDate: {
      year: startDate?.year ?? null,
      month: startDate?.month ?? null,
      day: startDate?.day ?? null,
    },

    /* === Extended === */
    duration,
    rating,
    endDate: endDate
      ? {
          year: endDate.year,
          month: endDate.month,
          day: endDate.day,
        }
      : null,
    banner,
    trailer,
    // franchise & myanimelistId tidak ada di Kitsu
    // source tidak ada di Kitsu (bisa di-enrich AI)
  };
}