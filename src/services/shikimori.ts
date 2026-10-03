import { fetchWithRetry } from '../lib/http';
import type { AniListMedia } from './anilist';

const SHIKIMORI_URL = 'https://shikimori.one/api/anime';

interface ShikimoriAnime {
  id: number;
  name: string;
  russian: string;
  english: string | null;
  japanese: string | null;
  image: {
    original: string;
    preview: string;
  };
  kind: string;
  status: string;
  score: string;
  episodes: number;
  duration: number;
  aired_on: string | null;
  released_on: string | null;
  studios: {
    id: number;
    name: string;
    filtered_name: string;
    real: boolean;
  }[];
  genres: {
    id: number;
    name: string;
    russian: string;
  }[];
}

/**
 * Cari anime di Shikimori.
 * Rate limit: 5 req/detik, 90 req/menit — longgar.
 * Docs: https://shikimori.one/api/doc/1.0/animes/index
 */
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
  return json[0] ?? null;
}

/**
 * Convert Shikimori response ke format AniListMedia.
 */
export function shikimoriToAniList(s: ShikimoriAnime): AniListMedia {
  // ─── Status mapping ───
  let status = 'RELEASING';
  if (s.status === 'released') status = 'FINISHED';
  else if (s.status === 'anons') status = 'NOT_YET_RELEASED';
  else if (s.status === 'ongoing') status = 'RELEASING';

  // ─── Kind mapping ───
  const kindMap: Record<string, string> = {
    tv: 'TV',
    movie: 'MOVIE',
    ova: 'OVA',
    ona: 'ONA',
    special: 'SPECIAL',
    tv_special: 'SPECIAL',
  };
  const format = kindMap[s.kind] ?? 'TV';

  // ─── Rating: 0-10 → 0-100 ───
  const averageScore = s.score ? Math.round(parseFloat(s.score) * 10) : null;

  // ─── Cover URL: relative → absolute ───
  const original = s.image.original.startsWith('http')
    ? s.image.original
    : `https://shikimori.one${s.image.original}`;
  const preview = s.image.preview.startsWith('http')
    ? s.image.preview
    : `https://shikimori.one${s.image.preview}`;

  // ─── Date ───
  const date = s.aired_on ? new Date(s.aired_on) : null;

  return {
    id: s.id,
    title: {
      romaji: s.name,
      english: s.english,
      native: s.japanese,
    },
    coverImage: {
      extraLarge: original,
      large: preview,
    },
    description: null, // Shikimori tidak kasih synopsis di list endpoint
    format,
    status,
    seasonYear: date?.getFullYear() ?? null,
    episodes: s.episodes || null,
    genres: s.genres.map((g) => g.name),
    averageScore,
    studios: {
      nodes: s.studios
        .filter((st) => st.real)
        .map((st) => ({ name: st.name }))
        .slice(0, 3),
    },
    startDate: {
      year: date?.getFullYear() ?? null,
      month: date ? date.getMonth() + 1 : null,
      day: date?.getDate() ?? null,
    },
  };
}