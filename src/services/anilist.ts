import { fetchWithRetry } from '../lib/http';

const ANILIST_URL = 'https://graphql.anilist.co';

const ANILIST_QUERY = `
  query ($search: String) {
    Media(search: $search, type: ANIME) {
      id
      title { romaji english native }
      coverImage { extraLarge large }
      description
      format
      status
      seasonYear
      episodes
      genres
      averageScore
      studios(isMain: true) { nodes { name } }
      startDate { year month day }
    }
  }
`;

export interface AniListMedia {
  id: number;
  title: {
    romaji: string;
    english: string | null;
    native: string | null;
  };
  coverImage: {
    extraLarge: string;
    large: string;
  };
  description: string | null;
  format: string;
  status: string;
  seasonYear: number | null;
  episodes: number | null;
  genres: string[];
  averageScore: number | null;
  studios: {
    nodes: { name: string }[];
  };
  startDate: {
    year: number | null;
    month: number | null;
    day: number | null;
  };
}

interface AniListResponse {
  data?: {
    Media: AniListMedia | null;
  };
  errors?: {
    message: string;
    status?: number;
  }[];
}

/**
 * Cari anime di AniList berdasarkan judul.
 * Return null kalau tidak ada hasil.
 * Throw error kalau API error (rate limit, dll).
 */
export async function searchAniList(
  title: string
): Promise<AniListMedia | null> {
  const res = await fetchWithRetry(ANILIST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      query: ANILIST_QUERY,
      variables: { search: title },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`AniList HTTP ${res.status}: ${errBody.slice(0, 100)}`);
  }

  const json = (await res.json()) as AniListResponse;

  if (json.errors?.length) {
    const msg = json.errors[0]?.message ?? 'Unknown GraphQL error';
    throw new Error(`AniList GraphQL: ${msg}`);
  }

  return json.data?.Media ?? null;
}