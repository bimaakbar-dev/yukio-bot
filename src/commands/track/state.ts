// src/commands/track/state.ts
import type { D1Database } from '@cloudflare/workers-types';
import { createLazyInit } from '../../lib/lazy-init';

const SESSION_TTL_MS = 15 * 60 * 1000;

export type TrackStep = 'site' | 'slug' | 'source_slug' | 'day' | 'hour' | 'confirm';

export interface TrackSessionRow {
  session_id: string;
  user_id: number;
  step: TrackStep;
  site: string | null;
  slug: string | null;
  source_slug: string | null;
  schedule_day: string | null;
  schedule_hour: number | null;
  buffer_min: number;
  created_at: number;
  expires_at: number;
}

export const ensureTrackSessionDb = createLazyInit(
  'TrackSession',
  async (db) => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS track_sessions (
          session_id    TEXT PRIMARY KEY,
          user_id       INTEGER NOT NULL,
          step          TEXT NOT NULL,
          site          TEXT,
          slug          TEXT,
          source_slug   TEXT,
          schedule_day  TEXT,
          schedule_hour INTEGER,
          buffer_min    INTEGER NOT NULL DEFAULT 60,
          created_at    INTEGER NOT NULL,
          expires_at    INTEGER NOT NULL
        )`
      )
      .run();
  }
);

export async function createTrackSession(
  db: D1Database,
  userId: number
): Promise<string> {
  await ensureTrackSessionDb(db);
  const sessionId = 'tr_' + crypto.randomUUID().replace(/-/g, '').slice(0, 13);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO track_sessions
        (session_id, user_id, step, buffer_min, created_at, expires_at)
       VALUES (?, ?, 'site', 60, ?, ?)`
    )
    .bind(sessionId, userId, now, now + SESSION_TTL_MS)
    .run();
  return sessionId;
}

export async function getTrackSession(
  db: D1Database,
  sessionId: string
): Promise<TrackSessionRow | null> {
  await ensureTrackSessionDb(db);
  const row = await db
    .prepare('SELECT * FROM track_sessions WHERE session_id = ?')
    .bind(sessionId)
    .first<TrackSessionRow>();

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM track_sessions WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }
  return row;
}

export async function getLatestTrackSessionByUser(
  db: D1Database,
  userId: number
): Promise<TrackSessionRow | null> {
  await ensureTrackSessionDb(db);
  return db
    .prepare(
      `SELECT * FROM track_sessions
       WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(userId, Date.now())
    .first<TrackSessionRow>();
}

export interface TrackSessionPatch {
  step?: TrackStep;
  site?: string;
  slug?: string;
  source_slug?: string;
  schedule_day?: string;
  schedule_hour?: number;
  buffer_min?: number;
}

export async function updateTrackSession(
  db: D1Database,
  sessionId: string,
  patch: TrackSessionPatch
): Promise<void> {
  await ensureTrackSessionDb(db);
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (sets.length === 0) return;
  values.push(sessionId);

  await db
    .prepare(`UPDATE track_sessions SET ${sets.join(', ')} WHERE session_id = ?`)
    .bind(...values)
    .run();
}

export async function deleteTrackSession(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await ensureTrackSessionDb(db);
    await db
      .prepare('DELETE FROM track_sessions WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[Track] delete session error:', err);
  }
}
