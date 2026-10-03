import { fetchWithRetry } from '../lib/http';
import type { AniListMedia } from '../types/anime';

const JIKAN_URL = 'https://api.jikan.moe/v4/anime';

interface JikanAnime {
  mal_id: number;
  title: string;
  title_english?: string | null;
  title_japanese?: string | null;
  synopsis?: string | null;
  images?: {
    jpg?: {
      large_image_url?: string;
      image_url?: string;
    };
  };
  type?: string | null;
  status?: string | null;
  year?: number | null;
  episodes?: number | null;
  genres?: { name: string }[];
  score?: number | null;
  studios?: { name: string }[];
  aired?: {
    from?: string | null;
    prop?: {
      from?: {
        year?: number | null;
        month?: number | null;
        day?: number | null;
      };
    };
  };
}

interface JikanResponse {
  data: JikanAnime[];
}

export async function searchJikan(title: string): Promise<JikanAnime | null> {
  const url = `${JIKAN_URL}?q=${encodeURIComponent(title)}&limit=1`;

  const res = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'yukio-bot/1.0',
      },
    },
    { retries: 0, timeout: 4000 }
  );

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Jikan HTTP ${res.status}: ${errBody.slice(0, 100)}`);
  }

  const json = (await res.json()) as JikanResponse;
  return json.data?.[0] ?? null;
}

export function jikanToAniList(jikan: JikanAnime): AniListMedia {
  let status = 'RELEASING';
  if (jikan.status?.includes('Finished')) status = 'FINISHED';
  else if (jikan.status?.includes('Not yet')) status = 'NOT_YET_RELEASED';
  else if (jikan.status?.includes('On Hiatus')) status = 'HIATUS';

  const format = (jikan.type || 'TV').toUpperCase();
  const averageScore = jikan.score ? Math.round(jikan.score * 10) : null;

  const cover =
    jikan.images?.jpg?.large_image_url || jikan.images?.jpg?.image_url || '';

  const genres: string[] = Array.isArray(jikan.genres)
    ? jikan.genres
        .map((g): string => g?.name ?? '')
        .filter((n: string): boolean => n.length > 0)
    : [];

  const studios: { name: string }[] = Array.isArray(jikan.studios)
    ? jikan.studios
        .map((s): string => s?.name ?? '')
        .filter((n: string): boolean => n.length > 0)
        .map((name: string): { name: string } => ({ name }))
    : [];

  const from = jikan.aired?.prop?.from;

  return {
    id: jikan.mal_id,
    title: {
      romaji: jikan.title ?? 'Unknown',
      english: jikan.title_english ?? null,
      native: jikan.title_japanese ?? null,
    },
    coverImage: {
      extraLarge: cover,
      large: cover,
    },
    description: jikan.synopsis ?? null,
    format,
    status,
    seasonYear: jikan.year ?? null,
    episodes: jikan.episodes ?? null,
    genres,
    averageScore,
    studios: { nodes: studios },
    startDate: {
      year: from?.year ?? null,
      month: from?.month ?? null,
      day: from?.day ?? null,
    },
  };
}