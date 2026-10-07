// src/lib/temp-anime.ts
import type { D1Database } from '@cloudflare/workers-types';

export const ANIME_SESSION_TTL_MS = 30 * 60 * 1000;

export interface TempAnimeRow {
  session_id: string;
  user_id: number;
  yaml: string;
  body: string;
  missing: string;
  ai_used: string;
  cover: string | null;
  source_label: string | null;
  slug: string | null;
  metadata_json: string | null;
  created_at: number;
  expires_at: number;
}

let dbReady = false;
let dbInitPromise: Promise<void> | null = null;

export async function ensureDb(db: D1Database): Promise<void> {
  if (dbReady) return;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS temp_anime (
            session_id    TEXT PRIMARY KEY,
            user_id       INTEGER NOT NULL,
            yaml          TEXT NOT NULL,
            body          TEXT NOT NULL,
            missing       TEXT NOT NULL,
            ai_used       TEXT NOT NULL,
            cover         TEXT,
            source_label  TEXT,
            slug          TEXT,
            metadata_json TEXT,
            created_at    INTEGER NOT NULL,
            expires_at    INTEGER NOT NULL
          )`
        )
        .run();
      try {
        await db.prepare('ALTER TABLE temp_anime ADD COLUMN slug TEXT').run();
      } catch {}
      try {
        await db
          .prepare('ALTER TABLE temp_anime ADD COLUMN metadata_json TEXT')
          .run();
      } catch {}
      dbReady = true;
    } catch (err) {
      console.error('[TempAnime] DB init error:', err);
      dbInitPromise = null;
      throw err;
    }
  })();

  return dbInitPromise;
}

export interface SaveTempAnimeInput {
  yaml: string;
  body: string;
  missing: string[];
  aiUsed: string[];
  cover: string | null;
  sourceLabel: string | null;
  slug: string;
  metadataJson?: string | null;
}

export async function saveTempAnime(
  db: D1Database,
  userId: number,
  data: SaveTempAnimeInput
): Promise<string> {
  await ensureDb(db);

  const sessionId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO temp_anime
         (session_id, user_id, yaml, body, missing, ai_used, cover, source_label, slug, metadata_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      userId,
      data.yaml,
      data.body,
      JSON.stringify(data.missing),
      JSON.stringify(data.aiUsed),
      data.cover,
      data.sourceLabel,
      data.slug,
      data.metadataJson ?? null,
      now,
      now + ANIME_SESSION_TTL_MS
    )
    .run();

  return sessionId;
}

export async function getTempAnime(
  db: D1Database,
  sessionId: string
): Promise<TempAnimeRow | null> {
  await ensureDb(db);
  const row = await db
    .prepare('SELECT * FROM temp_anime WHERE session_id = ?')
    .bind(sessionId)
    .first<TempAnimeRow>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM temp_anime WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }

  return row;
}

export async function getLatestTempAnimeByUser(
  db: D1Database,
  userId: number
): Promise<TempAnimeRow | null> {
  await ensureDb(db);
  return db
    .prepare(
      `SELECT * FROM temp_anime
       WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(userId, Date.now())
    .first<TempAnimeRow>();
}

export async function deleteTempAnime(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM temp_anime WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[TempAnime] delete error:', err);
  }
}

export function buildAnimeMarkdown(session: TempAnimeRow): string {
  const body = session.body.trim();
  return `${session.yaml}\n\n${body}\n`;
}