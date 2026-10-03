import { fetchWithRetry } from '../lib/http';

const ANIMEAPI_URL = 'https://animeapi.my.id';

interface AnimeApiMapping {
  title: string;
  anilist: number | null;
  myanimelist: number | null;
  kitsu: number | null;
  // ... 20+ platform lain
}

/**
 * Mapping ID anime lintas database.
 * Tidak ada rate limit — bebas panggil[reference:5].
 */
export async function getAnimeMapping(
  provider: 'myanimelist' | 'anilist' | 'kitsu',
  id: string | number
): Promise<AnimeApiMapping | null> {
  const url = `${ANIMEAPI_URL}/${provider}/${id}`;
  const res = await fetchWithRetry(url, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`AnimeAPI HTTP ${res.status}`);
  }

  return (await res.json()) as AnimeApiMapping;
}