// src/lib/dba-session.ts
import type { D1Database } from '@cloudflare/workers-types';
import type { AniListMedia } from '../types/anime';
import { ensureTrackDb } from './telegram-utils';

export const SESSION_TTL_MS = 30 * 60 * 1000;

/* ============================================================
   DB INIT
   ============================================================ */

let dbReady = false;
let dbInitPromise: Promise<void> | null = null;

export async function ensureDb(db: D1Database): Promise<void> {
  if (dbReady) return;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS qimochi_sessions (
            session_id   TEXT PRIMARY KEY,
            user_id      INTEGER NOT NULL,
            mal_id       INTEGER,
            kitsu_id     TEXT,
            title        TEXT NOT NULL,
            cover        TEXT,
            year         TEXT,
            type         TEXT,
            studio       TEXT,
            source       TEXT,
            metadata     TEXT,
            fetched_sources TEXT,
            created_at   INTEGER NOT NULL,
            expires_at   INTEGER NOT NULL
          )`
        )
        .run();

      // Migration: tambah kolom baru kalau belum ada
      for (const col of ['metadata', 'fetched_sources']) {
        try {
          await db
            .prepare(`ALTER TABLE qimochi_sessions ADD COLUMN ${col} TEXT`)
            .run();
        } catch {
          // ignore
        }
      }

      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS voice_actors (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            nameNative      TEXT,
            image           TEXT,
            defaultLanguage TEXT,
            created_at      INTEGER NOT NULL
          )`
        )
        .run();

      await ensureTrackDb(db);

      dbReady = true;
    } catch (err) {
      console.error('[DBA] DB init error:', err);
      dbInitPromise = null;
      throw err;
    }
  })();

  return dbInitPromise;
}

/* ============================================================
   TYPES
   ============================================================ */

export interface SessionRow {
  session_id: string;
  user_id: number;
  mal_id: number | null;
  kitsu_id: string | null;
  title: string;
  cover: string | null;
  year: string | null;
  type: string | null;
  studio: string | null;
  source: string | null;
  metadata: string | null;
  fetched_sources: string | null;
  created_at: number;
  expires_at: number;
}

export interface SaveSessionInput {
  malId: number | null;
  kitsuId: string | null;
  title: string;
  cover: string | null;
  year: string | null;
  type: string | null;
  studio: string | null;
  source: string | null;
  metadata?: AniListMedia | null;
  fetchedSources?: string[];
}

/* ============================================================
   SAVE
   ============================================================ */

export async function saveSession(
  db: D1Database,
  userId: number,
  data: SaveSessionInput
): Promise<string> {
  await ensureDb(db);

  const sessionId = `q_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO qimochi_sessions
        (session_id, user_id, mal_id, kitsu_id, title, cover, year, type, studio, source, metadata, fetched_sources, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      userId,
      data.malId,
      data.kitsuId,
      data.title,
      data.cover,
      data.year,
      data.type,
      data.studio,
      data.source,
      data.metadata ? JSON.stringify(data.metadata) : null,
      data.fetchedSources ? JSON.stringify(data.fetchedSources) : null,
      now,
      now + SESSION_TTL_MS
    )
    .run();

  return sessionId;
}

/* ============================================================
   UPDATE METADATA
   ============================================================ */

export async function updateSessionMetadata(
  db: D1Database,
  sessionId: string,
  metadata: AniListMedia,
  fetchedSources: string[]
): Promise<void> {
  await ensureDb(db);
  await db
    .prepare(
      `UPDATE qimochi_sessions
       SET metadata = ?, fetched_sources = ?, title = ?, cover = ?
       WHERE session_id = ?`
    )
    .bind(
      JSON.stringify(metadata),
      JSON.stringify(fetchedSources),
      metadata.title.romaji,
      metadata.coverImage.extraLarge,
      sessionId
    )
    .run();
}

/* ============================================================
   GET
   ============================================================ */

export async function getSession(
  db: D1Database,
  sessionId: string
): Promise<SessionRow | null> {
  await ensureDb(db);

  const row = await db
    .prepare('SELECT * FROM qimochi_sessions WHERE session_id = ?')
    .bind(sessionId)
    .first<SessionRow>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM qimochi_sessions WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }

  return row;
}

export async function getLatestSessionByUser(
  db: D1Database,
  userId: number
): Promise<SessionRow | null> {
  await ensureDb(db);

  return db
    .prepare(
      `SELECT * FROM qimochi_sessions
       WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(userId, Date.now())
    .first<SessionRow>();
}

/* ============================================================
   DELETE
   ============================================================ */

export async function deleteSession(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM qimochi_sessions WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.error('[DBA] delete session error:', err);
  }
}
