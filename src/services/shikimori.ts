import { fetchWithRetry } from '../lib/http';
import type { AniListMedia } from './anilist';

const SHIKIMORI_URL = 'https://shikimori.one/api/animes';

interface ShikimoriAnime {
  id: number;
  name: string;
  russian?: string;
  english?: string | null;
  japanese?: string | null;
  image?: {
    original?: string;
    preview?: string;
  };
  kind?: string;
  status?: string;
  score?: string;
  episodes?: number;
  duration?: number;
  aired_on?: string | null;
  released_on?: string | null;
  studios?: {
    id: number;
    name: string;
    filtered_name: string;
    real: boolean;
  }[];
  genres?: {
    id: number;
    name: string;
    russian: string;
  }[];
}

export async function searchShikimori(
  title: string
): Promise<ShikimoriAnime | null> {
  const url = `${SHIKIMORI_URL}?search=${encodeURIComponent(title)}&limit=1`;

  const res = await fetchWithRetry(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'yukio-bot/1.0',
    },
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Shikimori HTTP ${res.status}: ${errBody.slice(0, 100)}`);
  }

  const json = (await res.json()) as ShikimoriAnime[];
  if (!Array.isArray(json)) return null;
  return json[0] ?? null;
}

export function shikimoriToAniList(s: ShikimoriAnime): AniListMedia {
  let status = 'RELEASING';
  if (s.status === 'released') status = 'FINISHED';
  else if (s.status === 'anons') status = 'NOT_YET_RELEASED';
  else if (s.status === 'ongoing') status = 'RELEASING';

  const kindMap: Record<string, string> = {
    tv: 'TV',
    movie: 'MOVIE',
    ova: 'OVA',
    ona: 'ONA',
    special: 'SPECIAL',
    tv_special: 'SPECIAL',
  };
  const format = kindMap[s.kind ?? ''] ?? 'TV';

  const averageScore = s.score ? Math.round(parseFloat(s.score) * 10) : null;

  // Image defensive
  const imgOrig = s.image?.original ?? '';
  const imgPrev = s.image?.preview ?? '';
  const original = imgOrig
    ? imgOrig.startsWith('http')
      ? imgOrig
      : `https://shikimori.one${imgOrig}`
    : '';
  const preview = imgPrev
    ? imgPrev.startsWith('http')
      ? imgPrev
      : `https://shikimori.one${imgPrev}`
    : '';

  const date = s.aired_on ? new Date(s.aired_on) : null;

  // Genres defensive
  const genres = Array.isArray(s.genres)
    ? s.genres
        .map((g) => g?.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
    : [];

  // Studios defensive
  const studios = Array.isArray(s.studios)
    ? s.studios
        .filter((st) => st && st.real && st.name)
        .map((st) => ({ name: st.name }))
        .slice(0, 3)
    : [];

  return {
    id: s.id,
    title: {
      romaji: s.name ?? 'Unknown',
      english: s.english ?? null,
      native: s.japanese ?? null,
    },
    coverImage: {
      extraLarge: original,
      large: preview || original,
    },
    description: null,
    format,
    status,
    seasonYear: date?.getFullYear() ?? null,
    episodes: s.episodes || null,
    genres,
    averageScore,
    studios: { nodes: studios },
    startDate: {
      year: date?.getFullYear() ?? null,
      month: date ? date.getMonth() + 1 : null,
      day: date ? date.getDate() : null,
    },
  };
}