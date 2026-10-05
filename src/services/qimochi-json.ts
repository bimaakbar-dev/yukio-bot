// src/services/qimochi-json.ts
import type {
  UnifiedCharacter,
  UnifiedEpisode,
  UnifiedRelation,
  UnifiedVoiceActor,
} from './qimochi-chain-extras';

/**
 * Format JSON dengan pretty print 2 spaces.
 * Konsisten dengan file di web (data/anime/{slug}/...).
 */
function stringifyJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/* ============================================================
   BUILDERS — Sections (array murni, tanpa wrapper)
   ============================================================ */

/**
 * Characters — array murni.
 * voiceActors = array slug.
 */
export function buildCharactersJson(chars: UnifiedCharacter[]): string {
  return stringifyJson(chars);
}

/**
 * Episodes — array murni.
 */
export function buildEpisodesJson(episodes: UnifiedEpisode[]): string {
  return stringifyJson(episodes);
}

/**
 * Franchises — array murni.
 */
export function buildFranchisesJson(relations: UnifiedRelation[]): string {
  return stringifyJson(relations);
}

/**
 * Voice Actors — array murni.
 * Untuk append ke src/data/voice-actors.json.
 */
export function buildVoiceActorsJson(vas: UnifiedVoiceActor[]): string {
  return stringifyJson(vas);
}

/* ============================================================
   CHUNK HELPER
   ============================================================ */

/**
 * Split array jadi chunks ukuran max `size`.
 * Dipakai untuk karakter & episode (chunk 200).
 */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Hitung range label untuk chunk.
 * Contoh: (0, 200, 500) → "1-200"
 *         (2, 200, 500) → "401-500"
 */
export function chunkRangeLabel(
  chunkIdx: number,
  size: number,
  total: number
): string {
  const start = chunkIdx * size + 1;
  const end = Math.min((chunkIdx + 1) * size, total);
  return `${start}-${end}`;
}
