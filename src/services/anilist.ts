// src/services/anilist.ts
import { fetchWithRetry } from '../lib/http';
import type { AniListMedia } from '../types/anime';

/**
 * AniList GraphQL diblokir dari CF Workers IP.
 * Pakai Val Town proxy sebagai relay.
 * Limit: 100K runs/day, reset 24 jam.
 */
const ANILIST_URL =
  'https://bimaakbar--062eb542c0de11f1b2c41607ee4eb77e.web.val.run';

const TIMEOUT = 8000;
const PER_PAGE = 25;
const MAX_PAGES = 40; // hard cap 1000 karakter
const PARALLEL_BATCH = 5;
const FETCH_TIME_BUDGET_MS = 12000; // 12s max fetch

/* ============================================================
   TYPES
   ============================================================ */

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

/* ============================================================
   CHARACTERS — Fetch page
   ============================================================ */

interface AniListCharEdge {
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
}

interface CharPageResponse {
  data?: {
    Media?: {
      characters?: {
        pageInfo: {
          hasNextPage: boolean;
          currentPage: number;
          lastPage: number;
          total: number;
        };
        edges: AniListCharEdge[];
      };
    };
  };
  errors?: { message: string }[];
}

const CHARACTERS_QUERY = `
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

async function fetchCharactersPage(
  idMal: number,
  page: number
): Promise<{ edges: AniListCharEdge[]; lastPage: number; total: number } | null> {
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
          query: CHARACTERS_QUERY,
          variables: { idMal, page },
        }),
      },
      { retries: 0, timeout: TIMEOUT }
    );

    if (!res.ok) {
      console.warn(`[AniList] chars page ${page} HTTP ${res.status}`);
      return null;
    }

    const json = (await res.json()) as CharPageResponse;

    if (json.errors?.length) {
      console.warn(`[AniList] chars page ${page} error: ${json.errors[0]?.message}`);
      return null;
    }

    const chars = json.data?.Media?.characters;
    if (!chars) return null;

    return {
      edges: chars.edges ?? [],
      lastPage: chars.pageInfo?.lastPage ?? 1,
      total: chars.pageInfo?.total ?? 0,
    };
  } catch (err) {
    console.warn(`[AniList] chars page ${page} failed:`, err);
    return null;
  }
}

/* ============================================================
   CHARACTERS — Fetch ALL (paralel)
   ============================================================ */

/**
 * Fetch SEMUA characters dari AniList (paralel).
 *
 * Alur:
 *   1. Fetch page 1 → dapat `lastPage`
 *   2. Fetch page 2..lastPage secara paralel (5 per batch)
 *   3. Aggregate semua edges
 *
 * Time budget: FETCH_TIME_BUDGET_MS. Kalau lewat, stop dan return partial.
 */
export async function getCharactersFromAniList(
  idMal: number
): Promise<AniListCharacter[] | null> {
  const startTime = Date.now();

  console.log(`[AniList] characters start — idMal: ${idMal}`);

  // === 1. Fetch page 1 ===
  const first = await fetchCharactersPage(idMal, 1);
  if (!first) {
    console.warn('[AniList] page 1 failed');
    return null;
  }

  const lastPage = Math.min(first.lastPage, MAX_PAGES);
  const totalFromSource = first.total;

  console.log(
    `[AniList] page 1/${lastPage} — ${first.edges.length} edges (total source: ${totalFromSource})`
  );

  const allEdges: AniListCharEdge[] = [...first.edges];
  let truncated = false;

  // === 2. Fetch sisa page (paralel) ===
  if (lastPage > 1) {
    for (let batchStart = 2; batchStart <= lastPage; batchStart += PARALLEL_BATCH) {
      // Time budget check
      const elapsed = Date.now() - startTime;
      if (elapsed > FETCH_TIME_BUDGET_MS) {
        console.warn(
          `[AniList] time budget exceeded (${elapsed}ms) — stop at page ${batchStart}`
        );
        truncated = true;
        break;
      }

      const pages: number[] = [];
      for (let i = 0; i < PARALLEL_BATCH && batchStart + i <= lastPage; i++) {
        pages.push(batchStart + i);
      }

      console.log(
        `[AniList] batch fetch pages ${pages.join(',')} (elapsed: ${elapsed}ms)`
      );

      const results = await Promise.allSettled(
        pages.map((p) => fetchCharactersPage(idMal, p))
      );

      let batchHadError = false;
      for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value) {
          batchHadError = true;
          continue;
        }
        allEdges.push(...r.value.edges);
      }

      if (batchHadError) {
        console.warn(`[AniList] batch ${batchStart} had errors — continue`);
      }
    }
  }

  if (allEdges.length === 0) return null;

  // === 3. Transform ===
  const all: AniListCharacter[] = [];
  const seen = new Set<string>();

  for (const edge of allEdges) {
    const roleRaw = (edge.role ?? '').toUpperCase();
    if (roleRaw !== 'MAIN' && roleRaw !== 'SUPPORTING') continue;

    const name = edge.node.name?.full?.trim();
    if (!name || seen.has(name)) continue;
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

  console.log(
    `[AniList] characters done — ${all.length} chars ` +
      `(source total: ${totalFromSource}, truncated: ${truncated}, ` +
      `time: ${Date.now() - startTime}ms)`
  );

  return all.length > 0 ? all : null;
}

/* ============================================================
   METADATA
   ============================================================ */

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
