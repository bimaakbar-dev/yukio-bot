// src/services/qimochi-chain.ts
import type { AniListMedia } from '../types/anime';
import { searchKitsu, kitsuToAniList } from './kitsu';
import { searchShikimori, shikimoriToAniList } from './shikimori';
import { getMetadataFromAniList } from './anilist';

const TIMEOUT_PER_SOURCE = 8000;

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
 * Chain search:
 *   1. AniList (via Val Town) + Kitsu — paralel
 *      AniList = metadata lengkap
 *      Kitsu = kitsuId (untuk episodes)
 *   2. AniList gagal → fallback Shikimori
 *   3. Shikimori gagal → fallback Kitsu saja
 *
 * Jikan sudah di-drop (blocked dari CF Workers).
 */
export async function chainSearch(query: string): Promise<ChainSearchResult> {
  const t0 = Date.now();
  const tried: string[] = ['AniList', 'Kitsu'];
  const errors: string[] = [];

  // === 1. AniList + Kitsu (paralel) ===
  const [aniListR, kitsuR] = await Promise.allSettled([
    withTimeout(() => getMetadataFromAniList(query), TIMEOUT_PER_SOURCE),
    withTimeout(() => searchKitsu(query), TIMEOUT_PER_SOURCE),
  ]);

  const aniList =
    aniListR.status === 'fulfilled' ? aniListR.value : null;
  const kitsuResult =
    kitsuR.status === 'fulfilled' ? kitsuR.value : null;

  console.log(
    `[Chain] parallel fetch done in ${Date.now() - t0}ms — ` +
      `AniList=${aniList ? 'OK' : 'fail'}, ` +
      `Kitsu=${kitsuResult ? 'OK' : 'fail'}`
  );

  if (!aniList) errors.push('AniList: timeout atau gagal');
  if (!kitsuResult) errors.push('Kitsu: timeout atau gagal');

  const kitsuId = kitsuResult?.anime.id ?? null;

  // === 2. AniList sukses → PRIMARY ===
  if (aniList) {
    return {
      media: aniList,
      malId: aniList.myanimelistId ?? null,
      kitsuId,
      source: kitsuResult ? 'AniList + Kitsu' : 'AniList',
      tried,
      errors,
    };
  }

  // === 3. Fallback: Shikimori ===
  tried.push('Shikimori');
  const shiki = await withTimeout(
    () => searchShikimori(query),
    TIMEOUT_PER_SOURCE
  );

  if (shiki) {
    return {
      media: shikimoriToAniList(shiki),
      malId: shiki.id ?? null,
      kitsuId,
      source: kitsuResult ? 'Shikimori + Kitsu' : 'Shikimori',
      tried,
      errors,
    };
  }
  errors.push('Shikimori: timeout atau gagal');

  // === 4. Fallback: Kitsu only ===
  if (kitsuResult) {
    return {
      media: kitsuToAniList(kitsuResult),
      malId: null,
      kitsuId,
      source: 'Kitsu',
      tried,
      errors,
    };
  }

  // === 5. Semua gagal ===
  throw new Error(
    `Semua sumber gagal.\n\n` +
      `Sudah dicoba:\n` +
      errors.map((e) => `• ${e}`).join('\n')
  );
}

/**
 * Wrapper untuk cari by title — butuh malId/kitsuId.
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