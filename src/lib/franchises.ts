// src/lib/franchises.ts
import type { UnifiedRelation } from '../services/qimochi-chain-extras';

export const HIDDEN_RELATIONS = new Set([
  'character',
  'adaptation',
  'contains',
  'other',
]);

export const RELATION_LABEL: Record<string, string> = {
  sequel: 'Sekuel',
  prequel: 'Prekuel',
  side_story: 'Cerita Sampingan',
  parent_story: 'Cerita Induk',
  alternative: 'Versi Alternatif',
  spin_off: 'Spin-off',
  summary: 'Ringkasan',
  full_story: 'Cerita Lengkap',
  compilation: 'Kompilasi',
};

export function filterFranchises(
  relations: UnifiedRelation[]
): UnifiedRelation[] {
  return relations.filter((r) => !HIDDEN_RELATIONS.has(r.relation));
}