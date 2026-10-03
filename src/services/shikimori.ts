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
  // 1. Search — dapat id + data basic
  const searchUrl = `${SHIKIMORI_URL}?search=${encodeURIComponent(
    title
  )}&limit=1`;

  const searchRes = await fetchWithRetry(searchUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'yukio-bot/1.0',
    },
  });

  if (!searchRes.ok) {
    const errBody = await searchRes.text().catch(() => '');
    throw new Error(
      `Shikimori search HTTP ${searchRes.status}: ${errBody.slice(0, 100)}`
    );
  }

  const list = (await searchRes.json()) as ShikimoriAnime[];
  if (!Array.isArray(list) || list.length === 0) return null;

  const basic = list[0];
  if (!basic?.id) return null;

  // 2. Fetch detail — dapat studios lengkap
  try {
    const detailUrl = `${SHIKIMORI_URL}/${basic.id}`;
    const detailRes = await fetchWithRetry(detailUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'yukio-bot/1.0',
      },
    });

    if (detailRes.ok) {
      const detail = (await detailRes.json()) as ShikimoriAnime;
      console.log(
        `[Shikimori] detail fetched — studios: ${
          detail.studios?.length ?? 0
        }`
      );
      return detail;
    }
  } catch (err) {
    console.warn('[Shikimori] detail fetch failed, using basic:', err);
  }

  // Fallback: pakai data basic
  return basic;
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

  const genres = Array.isArray(s.genres)
    ? s.genres
        .map((g) => g?.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
    : [];

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