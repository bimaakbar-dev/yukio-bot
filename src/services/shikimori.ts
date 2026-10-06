// src/services/shikimori.ts
import { fetchWithRetry } from '../lib/http';
import type { AniListMedia } from '../types/anime';

const SHIKIMORI_URL = 'https://shikimori.one/api/animes';

export interface ShikimoriVideo {
  id: number;
  url: string;
  image_url?: string;
  player_url?: string;
  name?: string;
  kind?: string;
  hosting?: string;
}

interface ShikimoriAnime {
  id: number;
  name: string;
  russian?: string;
  english?: string | string[] | null;
  japanese?: string | string[] | null;
  synonyms?: string[];
  image?: {
    original?: string;
    preview?: string;
  };
  kind?: string;
  status?: string;
  score?: string;
  episodes?: number;
  episodes_aired?: number;
  duration?: number;
  rating?: string;
  aired_on?: string | null;
  released_on?: string | null;
  description?: string | null;
  description_html?: string | null;
  franchise?: string | null;
  myanimelist_id?: number | null;
  studios?: {
    id: number;
    name: string;
    filtered_name: string;
  }[];
  genres?: {
    id: number;
    name: string;
    russian: string;
  }[];
  videos?: ShikimoriVideo[];
}

export async function searchShikimori(
  title: string
): Promise<ShikimoriAnime | null> {
  const searchUrl = `${SHIKIMORI_URL}?search=${encodeURIComponent(
    title
  )}&limit=1`;

  const searchRes = await fetchWithRetry(
    searchUrl,
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'yukio-bot/1.0',
      },
    },
    { retries: 0, timeout: 4000 }
  );

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

  try {
    const detailUrl = `${SHIKIMORI_URL}/${basic.id}`;
    const detailRes = await fetchWithRetry(
      detailUrl,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'yukio-bot/1.0',
        },
      },
      { retries: 0, timeout: 4000 }
    );

    if (detailRes.ok) {
      const detail = (await detailRes.json()) as ShikimoriAnime;
      console.log(
        `[Shikimori] detail fetched — studios: ${detail.studios?.length ?? 0}, franchise: ${detail.franchise ?? '-'}, videos: ${detail.videos?.length ?? 0}`
      );
      return detail;
    }
  } catch (err) {
    console.warn('[Shikimori] detail fetch failed, using basic:', err);
  }

  return basic;
}

function pickString(
  v: string | string[] | null | undefined
): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}

function mapShikimoriRating(raw: string | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();

  const map: Record<string, string> = {
    g: 'G',
    pg: 'PG',
    pg_13: 'PG-13',
    'pg-13': 'PG-13',
    r: 'R',
    r_plus: 'R+',
    'r+': 'R+',
    rx: 'Rx',
  };

  return map[lower] ?? null;
}

function parseShikimoriDate(dateStr: string | null | undefined): {
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

function extractYoutubeId(url: string | null | undefined): string | null {
  if (!url) return null;

  const patterns = [
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
  ];

  for (const p of patterns) {
    const m = url.match(p);
    if (m && m[1]) return m[1];
  }

  return null;
}

function pickTrailer(videos: ShikimoriVideo[] | undefined): string | null {
  if (!Array.isArray(videos) || videos.length === 0) return null;

  const youtube = videos.find(
    (v) => v.hosting === 'youtube' && v.url && v.kind === 'pv'
  );
  const idFromYoutube = extractYoutubeId(youtube?.url);
  if (idFromYoutube) return idFromYoutube;

  const anyYoutube = videos.find(
    (v) => v.hosting === 'youtube' && v.url
  );
  const idFromAny = extractYoutubeId(anyYoutube?.url);
  if (idFromAny) return idFromAny;

  const first = videos.find((v) => v.url);
  return extractYoutubeId(first?.url);
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

  const airedDate = parseShikimoriDate(s.aired_on);
  const releasedDate = parseShikimoriDate(s.released_on);

  const genres: string[] = Array.isArray(s.genres)
    ? s.genres
        .map((g): string => g?.name ?? '')
        .filter((n: string): boolean => n.length > 0)
    : [];

  const studios: { name: string }[] = Array.isArray(s.studios)
    ? s.studios
        .filter((st): boolean => !!(st && st.name))
        .map((st): { name: string } => ({ name: st.name }))
        .slice(0, 3)
    : [];

  return {
    id: s.id,
    title: {
      romaji: s.name ?? 'Unknown',
      english: pickString(s.english),
      native: pickString(s.japanese),
    },
    coverImage: {
      extraLarge: original,
      large: preview || original,
    },
    description: s.description ?? null,
    format,
    status,
    seasonYear: airedDate?.year ?? null,
    episodes: s.episodes || null,
    genres,
    averageScore,
    studios: { nodes: studios },
    startDate: {
      year: airedDate?.year ?? null,
      month: airedDate?.month ?? null,
      day: airedDate?.day ?? null,
    },

    duration: s.duration && s.duration > 0 ? s.duration : null,
    rating: mapShikimoriRating(s.rating),
    endDate: releasedDate
      ? {
          year: releasedDate.year,
          month: releasedDate.month,
          day: releasedDate.day,
        }
      : null,
    trailer: pickTrailer(s.videos),
    franchise: s.franchise ?? null,
    myanimelistId: s.myanimelist_id ?? s.id,
  };
}