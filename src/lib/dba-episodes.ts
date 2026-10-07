// src/lib/dba-episodes.ts
import type { D1Database } from '@cloudflare/workers-types';
import { createLazyInit } from './lazy-init';

export interface CachedEpisode {
  number: number;
  title: string;
  aired?: string;
  duration?: number;
}

export interface EpCacheData {
  episodes: CachedEpisode[];
  source: string;
  total: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000;

export const ensureEpCacheTable = createLazyInit('EpCache', async (db) => {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS qimochi_ep_cache (
        session_id  TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        total       INTEGER NOT NULL,
        data        TEXT NOT NULL,
        truncated   INTEGER DEFAULT 0,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      )`
    )
    .run();
});

export async function saveEpCache(
  db: D1Database,
  sessionId: string,
  episodes: CachedEpisode[],
  source: string,
  truncated = false
): Promise<void> {
  await ensureEpCacheTable(db);
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO qimochi_ep_cache
        (session_id, source, total, data, truncated, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         source = excluded.source,
         total = excluded.total,
         data = excluded.data,
         truncated = excluded.truncated,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`
    )
    .bind(
      sessionId,
      source,
      episodes.length,
      JSON.stringify(episodes),
      truncated ? 1 : 0,
      now,
      now + CACHE_TTL_MS
    )
    .run();

  console.log(`[EpCache] saved ${episodes.length} episodes for ${sessionId}`);
}

export async function getEpCache(
  db: D1Database,
  sessionId: string
): Promise<EpCacheData | null> {
  await ensureEpCacheTable(db);

  const row = await db
    .prepare(
      `SELECT source, total, data, truncated, expires_at
       FROM qimochi_ep_cache
       WHERE session_id = ?`
    )
    .bind(sessionId)
    .first<{
      source: string;
      total: number;
      data: string;
      truncated: number;
      expires_at: number;
    }>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await deleteEpCache(db, sessionId);
    return null;
  }

  try {
    const episodes = JSON.parse(row.data) as CachedEpisode[];
    return {
      episodes,
      source: row.source,
      total: row.total,
    };
  } catch {
    return null;
  }
}

export async function deleteEpCache(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await ensureEpCacheTable(db);
    await db
      .prepare('DELETE FROM qimochi_ep_cache WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[EpCache] delete error:', err);
  }
}