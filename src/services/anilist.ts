// src/services/anilist.ts
import { fetchWithRetry } from '../lib/http';

const ANILIST_URL = 'https://bimaakbar--062eb542c0de11f1b2c41607ee4eb77e.web.val.run';
const TIMEOUT = 8000;
const PER_PAGE = 25;
const MAX_PAGES = 8; // max 200 karakter

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

/* ============================================================
   FETCH PAGE
   ============================================================ */

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

/* ============================================================
   PUBLIC API
   ============================================================ */

/**
 * Ambil characters + VA (Japanese) dari AniList.
 * Filter: role MAIN + SUPPORTING (BACKGROUND di-skip).
 * Pagination max MAX_PAGES halaman.
 *
 * Return null kalau tidak ada data.
 */
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
