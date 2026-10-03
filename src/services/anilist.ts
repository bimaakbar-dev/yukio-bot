const ANILIST_URL = 'https://graphql.anilist.co';

const ANILIST_QUERY = `
  query ($search: String) {
    Media(search: $search, type: ANIME) {
      id
      title { romaji english native }
      coverImage { extraLarge large }
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
  const res = await fetch(ANILIST_URL, {
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

  // Handle HTTP error (429 rate limit, 403 degraded, 500 server error)
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`AniList HTTP ${res.status}: ${errBody.slice(0, 100)}`);
  }

  const json = (await res.json()) as AniListResponse;

  // GraphQL error meskipun HTTP 200
  if (json.errors?.length) {
    const msg = json.errors[0]?.message ?? 'Unknown GraphQL error';
    throw new Error(`AniList GraphQL: ${msg}`);
  }

  return json.data?.Media ?? null;
}