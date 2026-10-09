// src/lib/cron/state-extra.ts
import type { D1Database } from '@cloudflare/workers-types';
import type { SiteKey } from './state';

export interface UpdateTrackedPatch {
  site?: SiteKey;
  source_slug?: string;
  schedule_day?: string;
  schedule_hour?: number;
  schedule_minute?: number;
  buffer_min?: number;
  status?: 'active' | 'paused' | 'finished';
  last_ep?: number;
  chunk_start?: number;
  chunk_end?: number;
}

export async function updateTrackedAnime(
  db: D1Database,
  slug: string,
  patch: UpdateTrackedPatch
): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    values.push(v);
  }

  if (sets.length === 0) return false;

  sets.push('updated_at = ?');
  values.push(Date.now());
  values.push(slug);

  const res = await db
    .prepare(`UPDATE tracked_anime SET ${sets.join(', ')} WHERE slug = ?`)
    .bind(...values)
    .run();

  return (res.meta?.changes ?? 0) > 0;
}