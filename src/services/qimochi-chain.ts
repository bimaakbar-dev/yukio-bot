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
 * Cari anime dari 2 sumber secara PARALEL:
 * Shikimori + Kitsu
 *
 * Shikimori → primary media (metadata lengkap, MAL ID, franchise)
 * Kitsu      → diambil kitsuId-nya untuk keperluan episodes
 *
 * Kalau Shikimori gagal, fallback ke Kitsu sepenuhnya.
 * Jikan sudah di-drop (blocked dari CF Workers).
 */
export async function chainSearch(query: string): Promise<ChainSearchResult> {
  const tried: string[] = ['Shikimori', 'Kitsu'];
  const errors: string[] = [];

  const t0 = Date.now();

  const [shikiR, kitsuR] = await Promise.allSettled([
    withTimeout(() => searchShikimori(query), TIMEOUT_PER_SOURCE),
    withTimeout(() => searchKitsu(query), TIMEOUT_PER_SOURCE),
  ]);

  const shikimori =
    shikiR.status === 'fulfilled' ? shikiR.value : null;
  const kitsuResult =
    kitsuR.status === 'fulfilled' ? kitsuR.value : null;

  console.log(
    `[Chain] parallel fetch done in ${Date.now() - t0}ms — ` +
      `Shikimori=${shikimori ? 'OK' : 'fail'}, ` +
      `Kitsu=${kitsuResult ? 'OK' : 'fail'}`
  );

  if (!shikimori) errors.push('Shikimori: timeout atau gagal');
  if (!kitsuResult) errors.push('Kitsu: timeout atau gagal');

  // === PRIMARY: Shikimori ===
  if (shikimori) {
    const source = kitsuResult ? 'Shikimori + Kitsu' : 'Shikimori';
    return {
      media: shikimoriToAniList(shikimori),
      malId: shikimori.id ?? null,
      // Bonus dari paralel call: kitsuId untuk episodes
      kitsuId: kitsuResult?.anime.id ?? null,
      source,
      tried,
      errors,
    };
  }

  // === FALLBACK: Kitsu only ===
  if (kitsuResult) {
    return {
      media: kitsuToAniList(kitsuResult),
      malId: null,
      kitsuId: kitsuResult.anime.id,
      source: 'Kitsu',
      tried,
      errors,
    };
  }

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