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
  };
  relationships?: {
    categories?: { data: { type: string; id: string }[] };
    studios?: { data: { type: string; id: string }[] };
  };
}

interface KitsuIncluded {
  id: string;
  type: string;
  attributes: {
    title?: string;   // untuk categories
    name?: string;    // untuk studios
  };
}

interface KitsuResponse {
  data: KitsuAnime[];
  included?: KitsuIncluded[];
}

interface KitsuSearchResult {
  anime: KitsuAnime;
  genres: string[];
  studio: string | null;
}

export async function searchKitsu(title: string): Promise<KitsuSearchResult | null> {
  // include=categories,studios → fetch genre & studio sekaligus
  const url = `${KITSU_URL}?filter[text]=${encodeURIComponent(title)}&include=categories,studios&page[limit]=1`;

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
  const anime = json.data?.[0];
  if (!anime) return null;

  const included = json.included ?? [];

  // Extract genre dari included
  const categoryIds = (anime.relationships?.categories?.data ?? []).map(
    (r) => r.id
  );
  const genres = included
    .filter(
      (i) => i.type === 'categories' && categoryIds.includes(i.id)
    )
    .map((i) => i.attributes.title)
    .filter((t): t is string => !!t)
    .slice(0, 5);

  // Extract studio dari included
  const studioIds = (anime.relationships?.studios?.data ?? []).map(
    (r) => r.id
  );
  const studioMatch = included.find(
    (i) => i.type === 'studios' && studioIds.includes(i.id)
  );
  const studio = studioMatch?.attributes.name ?? null;

  return { anime, genres, studio };
}

export function kitsuToAniList(result: KitsuSearchResult): AniListMedia {
  const { anime, genres, studio } = result;
  const attr = anime.attributes;

  const format = (attr.subtype || 'TV').toUpperCase();

  let status = 'RELEASING';
  if (attr.status === 'finished') status = 'FINISHED';
  else if (attr.status === 'upcoming') status = 'NOT_YET_RELEASED';
  else if (attr.status === 'tba') status = 'NOT_YET_RELEASED';
  else if (attr.status === 'current') status = 'RELEASING';

  const averageScore = attr.averageRating
    ? Math.round(parseFloat(attr.averageRating))
    : null;

  const cover = attr.posterImage.large || attr.posterImage.original || '';
  const date = attr.startDate ? new Date(attr.startDate) : null;

  return {
    id: parseInt(anime.id, 10),
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
    genres,
    averageScore,
    studios: {
      nodes: studio ? [{ name: studio }] : [],
    },
    startDate: {
      year: date?.getFullYear() ?? null,
      month: date ? date.getMonth() + 1 : null,
      day: date?.getDate() ?? null,
    },
  };
}