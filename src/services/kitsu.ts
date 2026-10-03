import type { AniListMedia } from './anilist';

const KITSU_URL = 'https://kitsu.io/api/edge/anime';

interface KitsuAnime {
  id: string;
  attributes: {
    canonicalTitle: string;
    titles: {
      en?: string;
      en_jp?: string;
      ja_jp?: string;
    };
    posterImage: {
      large: string;
      original: string;
    };
    subtype: string;
    status: string;
    startDate: string | null;
    episodeCount: number | null;
    averageRating: string | null;
    category: string;
  };
}

interface KitsuResponse {
  data: KitsuAnime[];
}

export async function searchKitsu(title: string): Promise<KitsuAnime | null> {
  const url = `${KITSU_URL}?filter[text]=${encodeURIComponent(title)}&page[limit]=1`;

  const res = await fetch(url, {
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
  return json.data?.[0] ?? null;
}

export function kitsuToAniList(kitsu: KitsuAnime): AniListMedia {
  const attr = kitsu.attributes;
  const format = (attr.subtype || 'TV').toUpperCase();

  let status = 'RELEASING';
  if (attr.status === 'finished') status = 'FINISHED';
  else if (attr.status === 'upcoming') status = 'NOT_YET_RELEASED';
  else if (attr.status === 'tba') status = 'NOT_YET_RELEASED';

  const averageScore = attr.averageRating
    ? Math.round(parseFloat(attr.averageRating))
    : null;

  const cover = attr.posterImage.large || attr.posterImage.original || '';
  const date = attr.startDate ? new Date(attr.startDate) : null;

  return {
    id: parseInt(kitsu.id, 10),
    title: {
      romaji: attr.titles.en_jp ?? attr.canonicalTitle,
      english: attr.titles.en ?? null,
      native: attr.titles.ja_jp ?? null,
    },
    coverImage: {
      extraLarge: cover,
      large: cover,
    },
    format,
    status,
    seasonYear: date?.getFullYear() ?? null,
    episodes: attr.episodeCount,
    genres: [],
    averageScore,
    studios: { nodes: [] },
    startDate: {
      year: date?.getFullYear() ?? null,
      month: date ? date.getMonth() + 1 : null,
      day: date?.getDate() ?? null,
    },
  };
}