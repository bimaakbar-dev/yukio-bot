// src/services/qimochi-chain.ts
import type { AniListMedia } from '../types/anime';
import { searchJikan, jikanToAniList } from './jikan';
import { searchKitsu, kitsuToAniList } from './kitsu';
import { searchShikimori, shikimoriToAniList } from './shikimori';

const TIMEOUT_PER_SOURCE = 7000;

export interface ChainSearchResult {
  media: AniListMedia;
  malId: number | null;
  kitsuId: string | null;
  source: string;
  tried: string[];
  errors: string[];
}

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number
): Promise<T | null> {
  try {
    return await Promise.race([
      fn(),
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

/**
 * Cari anime dari 3 sumber secara berurutan:
 * Jikan → Kitsu → Shikimori
 *
 * Return data dari sumber pertama yang berhasil.
 * Kalau semua gagal, throw error.
 */
export async function chainSearch(query: string): Promise<ChainSearchResult> {
  const tried: string[] = [];
  const errors: string[] = [];

  // === 1. JIKAN ===
  tried.push('Jikan');
  const jikan = await withTimeout(() => searchJikan(query), TIMEOUT_PER_SOURCE);

  if (jikan) {
    return {
      media: jikanToAniList(jikan),
      malId: jikan.mal_id,
      kitsuId: null,
      source: 'Jikan (MAL)',
      tried,
      errors,
    };
  }
  errors.push('Jikan: timeout atau gagal');

  // === 2. KITSU ===
  tried.push('Kitsu');
  const kitsuResult = await withTimeout(
    () => searchKitsu(query),
    TIMEOUT_PER_SOURCE
  );

  if (kitsuResult) {
    const media = kitsuToAniList(kitsuResult);
    return {
      media,
      malId: null,
      kitsuId: kitsuResult.anime.id,
      source: 'Kitsu',
      tried,
      errors,
    };
  }
  errors.push('Kitsu: timeout atau gagal');

  // === 3. SHIKIMORI ===
  tried.push('Shikimori');
  const shikimori = await withTimeout(
    () => searchShikimori(query),
    TIMEOUT_PER_SOURCE
  );

  if (shikimori) {
    return {
      media: shikimoriToAniList(shikimori),
      malId: null,
      kitsuId: null,
      source: 'Shikimori',
      tried,
      errors,
    };
  }
  errors.push('Shikimori: timeout atau gagal');

  // === SEMUA GAGAL ===
  throw new Error(
    `Semua sumber gagal.\n\n` +
      `Sudah dicoba:\n` +
      errors.map((e) => `• ${e}`).join('\n')
  );
}

/**
 * Chain untuk search by title — kalau kita cuma tahu title
 * dan butuh malId/kitsuId (untuk fetch characters/episodes).
 */
export async function resolveAnimeIds(
  query: string
): Promise<{
  malId: number | null;
  kitsuId: string | null;
  title: string;
  source: string;
}> {
  const result = await chainSearch(query);
  return {
    malId: result.malId,
    kitsuId: result.kitsuId,
    title: result.media.title.romaji || 'Unknown',
    source: result.source,
  };
}
