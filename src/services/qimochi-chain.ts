// src/services/qimochi-chain.ts
import type { AniListMedia } from '../types/anime';
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
 * Cari anime dari 2 sumber secara berurutan:
 * Shikimori → Kitsu
 *
 * Return data dari sumber pertama yang berhasil.
 * Jikan sudah di-drop (blocked dari CF Workers).
 */
export async function chainSearch(query: string): Promise<ChainSearchResult> {
  const tried: string[] = [];
  const errors: string[] = [];

  // === 1. SHIKIMORI (paling reliable) ===
  tried.push('Shikimori');
  const shikimori = await withTimeout(
    () => searchShikimori(query),
    TIMEOUT_PER_SOURCE
  );

  if (shikimori) {
    return {
      media: shikimoriToAniList(shikimori),
      // Shikimori id == myanimelist_id
      malId: shikimori.id ?? null,
      kitsuId: null,
      source: 'Shikimori',
      tried,
      errors,
    };
  }
  errors.push('Shikimori: timeout atau gagal');

  // === 2. KITSU (fallback) ===
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