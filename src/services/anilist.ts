// src/services/anilist.ts
import { fetchWithRetry } from '../lib/http';
import type { AniListMedia } from '../types/anime';

const ANILIST_URL = 'https://bimaakbar--062eb542c0de11f1b2c41607ee4eb77e.web.val.run';
const TIMEOUT = 8000;
const PER_PAGE = 25;
const MAX_PAGES = 8;

export interface AniListVoiceActor {
  anilistId: number;
  name: string;
  nameNative?: string;
  image?: string;
  language: string;
}

export interface AniListCharacter {
  name: string;
  nameNative?: string;
  image?: string;
  role: 'main' | 'supporting';
  voiceActors: AniListVoiceActor[];
}

interface AniListResponse {
  data?: {
    Media?: {
      characters?: {
        pageInfo: {
          hasNextPage: boolean;
          currentPage: number;
          lastPage: number;
          total: number;
        };
        edges: {
          role: string;
          node: {
            id: number;
            name: { full?: string; native?: string };
            image?: { large?: string };
          };
          voiceActors: {
            id: number;
            name: { full?: string; native?: string };
            languageV2?: string;
            image?: { large?: string };
          }[];
        }[];
      };
    };
  };
  errors?: { message: string }[];
}

const QUERY = `
  query ($idMal: Int, $page: Int) {
    Media(idMal: $idMal, type: ANIME) {
      characters(page: $page, perPage: ${PER_PAGE}, sort: [ROLE, RELEVANCE]) {
        pageInfo { hasNextPage currentPage lastPage total }
        edges {
          role
          node {
            id
            name { full native }
            image { large }
          }
          voiceActors(language: JAPANESE) {
            id
            name { full native }
            languageV2
            image { large }
          }
        }
      }
    }
  }
`;

async function fetchPage(
  idMal: number,
  page: number
): Promise<AniListResponse['data'] | null> {
  const res = await fetchWithRetry(
    ANILIST_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'yukio-bot/1.0',
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { idMal, page },
      }),
    },
    { retries: 0, timeout: TIMEOUT }
  );

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(
      `AniList HTTP ${res.status}: ${errBody.slice(0, 150)}`
    );
  }

  const json = (await res.json()) as AniListResponse;

  if (json.errors?.length) {
    throw new Error(`AniList: ${json.errors[0]?.message ?? 'unknown'}`);
  }

  return json.data ?? null;
}

export async function getCharactersFromAniList(
  idMal: number
): Promise<AniListCharacter[] | null> {
  const all: AniListCharacter[] = [];
  const seen = new Set<string>();

  console.log(`[AniList] characters start — idMal: ${idMal}`);

  for (let page = 1; page <= MAX_PAGES; page++) {
    let data: AniListResponse['data'] | null = null;
    try {
      data = await fetchPage(idMal, page);
    } catch (err) {
      console.warn(`[AniList] page ${page} error:`, err);
      break;
    }

    const chars = data?.Media?.characters;
    if (!chars) break;

    const edges = chars.edges ?? [];

    for (const edge of edges) {
      const roleRaw = (edge.role ?? '').toUpperCase();
      if (roleRaw !== 'MAIN' && roleRaw !== 'SUPPORTING') continue;

      const name = edge.node.name?.full?.trim();
      if (!name) continue;
      if (seen.has(name)) continue;
      seen.add(name);

      const vas: AniListVoiceActor[] = [];

      for (const va of edge.voiceActors ?? []) {
        const vaName = va.name?.full?.trim();
        if (!vaName) continue;

        vas.push({
          anilistId: va.id,
          name: vaName,
          nameNative: va.name?.native?.trim() || undefined,
          image: va.image?.large || undefined,
          language: va.languageV2 || 'Japanese',
        });
      }

      all.push({
        name,
        nameNative: edge.node.name?.native?.trim() || undefined,
        image: edge.node.image?.large || undefined,
        role: roleRaw.toLowerCase() as 'main' | 'supporting',
        voiceActors: vas,
      });
    }

    const pageInfo = chars.pageInfo;
    console.log(
      `[AniList] page ${page}/${pageInfo?.lastPage ?? '?'} — got ${edges.length} chars (total so far: ${all.length})`
    );

    if (!pageInfo?.hasNextPage) break;
  }

  console.log(`[AniList] characters done — ${all.length} chars`);

  return all.length > 0 ? all : null;
}

function mapAniListSource(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const map: Record<string, string> = {
    original: 'original',
    manga: 'manga',
    light_novel: 'light_novel',
    visual_novel: 'visual_novel',
    video_game: 'game',
    game: 'game',
    novel: 'novel',
    doujinshi: 'manga',
    anime: 'original',
    web_novel: 'web_novel',
    live_action: 'other',
    comic: 'manga',
    multimedia_project: 'other',
    picture_book: 'picture_book',
    radio: 'radio',
    music: 'music',
    card_game: 'card_game',
    '4_koma_manga': '4_koma_manga',
    book: 'book',
    other: 'other',
  };

  return map[lower] ?? null;
}

/**
 * Map format AniList → format schema kita.
 */
function mapAniListFormat(raw: string | null | undefined): string {
  if (!raw) return 'TV';
  const upper = raw.toUpperCase();

  const map: Record<string, string> = {
    TV: 'TV',
    TV_SHORT: 'TV',
    MOVIE: 'MOVIE',
    SPECIAL: 'SPECIAL',
    OVA: 'OVA',
    ONA: 'ONA',
    MUSIC: 'MUSIC',
  };

  return map[upper] ?? 'TV';
}

/**
 * Map status AniList → status schema kita.
 */
function mapAniListStatus(raw: string | null | undefined): string {
  if (!raw) return 'RELEASING';
  const upper = raw.toUpperCase();

  const map: Record<string, string> = {
    FINISHED: 'FINISHED',
    RELEASING: 'RELEASING',
    NOT_YET_RELEASED: 'NOT_YET_RELEASED',
    CANCELLED: 'CANCELLED',
    HIATUS: 'HIATUS',
  };

  return map[upper] ?? 'RELEASING';
}

/**
 * Map rating AniList → rating schema kita.
 */
function mapAniListRating(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const upper = raw.toUpperCase();

  const map: Record<string, string> = {
    G: 'G',
    PG: 'PG',
    'PG-13': 'PG-13',
    R: 'R',
    'R+': 'R+',
    RX: 'Rx',
  };

  return map[upper] ?? null;
}

const METADATA_QUERY = `
  query ($search: String) {
    Media(search: $search, type: ANIME) {
      id
      idMal
      title { romaji english native }
      coverImage { extraLarge large }
      bannerImage
      description
      genres
      studios(isMain: true) { nodes { name } }
      episodes
      duration
      status
      format
      season
      seasonYear
      startDate { year month day }
      endDate { year month day }
      averageScore
      trailer { id site }
      source
    }
  }
`;

interface AniListMetadataResponse {
  data?: {
    Media?: {
      id: number;
      idMal: number | null;
      title: { romaji?: string; english?: string; native?: string };
      coverImage: { extraLarge?: string; large?: string };
      bannerImage: string | null;
      description: string | null;
      genres: string[];
      studios: { nodes: { name: string }[] };
      episodes: number | null;
      duration: number | null;
      status: string;
      format: string;
      season: string | null;
      seasonYear: number | null;
      startDate: { year: number | null; month: number | null; day: number | null };
      endDate: { year: number | null; month: number | null; day: number | null };
      averageScore: number | null;
      trailer: { id: string; site: string } | null;
      source: string | null;
    };
  };
  errors?: { message: string }[];
}

export async function getMetadataFromAniList(
  query: string
): Promise<AniListMedia | null> {
  try {
    const res = await fetchWithRetry(
      ANILIST_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'yukio-bot/1.0',
        },
        body: JSON.stringify({
          query: METADATA_QUERY,
          variables: { search: query },
        }),
      },
      { retries: 0, timeout: TIMEOUT }
    );

    if (!res.ok) {
      console.warn(`[AniList] metadata HTTP ${res.status}`);
      return null;
    }

    const json = (await res.json()) as AniListMetadataResponse;

    if (json.errors?.length) {
      console.warn(`[AniList] metadata error: ${json.errors[0]?.message}`);
      return null;
    }

    const m = json.data?.Media;
    if (!m) return null;

    let trailer: string | null = null;
    if (m.trailer?.site === 'youtube' && m.trailer.id) {
      trailer = m.trailer.id;
    }

    const studios = (m.studios?.nodes ?? [])
      .map((s) => ({ name: s.name }))
      .slice(0, 3);

    return {
      id: m.id,
      title: {
        romaji: m.title.romaji ?? 'Unknown',
        english: m.title.english ?? null,
        native: m.title.native ?? null,
      },
      coverImage: {
        extraLarge: m.coverImage.extraLarge ?? '',
        large: m.coverImage.large ?? '',
      },
      description: m.description ?? null,
      format: mapAniListFormat(m.format),
      status: mapAniListStatus(m.status),
      seasonYear: m.seasonYear ?? null,
      episodes: m.episodes ?? null,
      genres: Array.isArray(m.genres) ? m.genres : [],
      averageScore: m.averageScore ?? null,
      studios: { nodes: studios },
      startDate: {
        year: m.startDate?.year ?? null,
        month: m.startDate?.month ?? null,
        day: m.startDate?.day ?? null,
      },
      duration: m.duration ?? null,
      rating: null,
      endDate: m.endDate?.year
        ? {
            year: m.endDate.year,
            month: m.endDate.month ?? null,
            day: m.endDate.day ?? null,
          }
        : null,
      banner: m.bannerImage ?? null,
      trailer,
      myanimelistId: m.idMal ?? null,
      source: mapAniListSource(m.source),
    };
  } catch (err) {
    console.warn('[AniList] metadata failed:', err);
    return null;
  }
}