// src/lib/dba-characters.ts
import type { D1Database } from '@cloudflare/workers-types';
import type { UnifiedCharacter, UnifiedVoiceActor } from '../services/qimochi-chain-extras';
import { InlineKeyboard } from 'grammy';

export const CHAR_PART_SIZE = 50;
const CACHE_TTL_MS = 30 * 60 * 1000;

/* ============================================================
   TABLE
   ============================================================ */

let cacheDbReady = false;
let cacheDbInitPromise: Promise<void> | null = null;

export async function ensureCharCacheTable(db: D1Database): Promise<void> {
  if (cacheDbReady) return;
  if (cacheDbInitPromise) return cacheDbInitPromise;

  cacheDbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS qimochi_char_cache (
            session_id   TEXT PRIMARY KEY,
            source       TEXT NOT NULL,
            total        INTEGER NOT NULL,
            data         TEXT NOT NULL,
            voice_actors TEXT,
            sent_parts   TEXT,
            created_at   INTEGER NOT NULL,
            expires_at   INTEGER NOT NULL
          )`
        )
        .run();

      // Migration: tambah kolom sent_parts kalau belum ada
      try {
        await db
          .prepare(
            'ALTER TABLE qimochi_char_cache ADD COLUMN sent_parts TEXT'
          )
          .run();
      } catch {
        // ignore
      }

      cacheDbReady = true;
    } catch (err) {
      console.error('[CharCache] DB init error:', err);
      cacheDbInitPromise = null;
      throw err;
    }
  })();

  return cacheDbInitPromise;
}

/* ============================================================
   SAVE
   ============================================================ */

export async function saveCharCache(
  db: D1Database,
  sessionId: string,
  chars: UnifiedCharacter[],
  voiceActors: UnifiedVoiceActor[],
  source: string
): Promise<void> {
  await ensureCharCacheTable(db);
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO qimochi_char_cache
        (session_id, source, total, data, voice_actors, sent_parts, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         source = excluded.source,
         total = excluded.total,
         data = excluded.data,
         voice_actors = excluded.voice_actors,
         sent_parts = excluded.sent_parts,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`
    )
    .bind(
      sessionId,
      source,
      chars.length,
      JSON.stringify(chars),
      JSON.stringify(voiceActors),
      JSON.stringify([]),
      now,
      now + CACHE_TTL_MS
    )
    .run();

  console.log(`[CharCache] saved ${chars.length} chars for ${sessionId}`);
}

/* ============================================================
   READ
   ============================================================ */

export interface CharCacheData {
  chars: UnifiedCharacter[];
  source: string;
  total: number;
  sentParts: Set<number>;
}

export async function getCharCache(
  db: D1Database,
  sessionId: string
): Promise<CharCacheData | null> {
  await ensureCharCacheTable(db);

  const row = await db
    .prepare(
      `SELECT source, total, data, sent_parts, expires_at
       FROM qimochi_char_cache
       WHERE session_id = ?`
    )
    .bind(sessionId)
    .first<{
      source: string;
      total: number;
      data: string;
      sent_parts: string | null;
      expires_at: number;
    }>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await deleteCharCache(db, sessionId);
    return null;
  }

  try {
    const chars = JSON.parse(row.data) as UnifiedCharacter[];
    let sentParts: number[] = [];
    if (row.sent_parts) {
      try {
        const arr = JSON.parse(row.sent_parts);
        if (Array.isArray(arr)) sentParts = arr.filter((n) => typeof n === 'number');
      } catch {
        // ignore
      }
    }

    return {
      chars,
      source: row.source,
      total: row.total,
      sentParts: new Set(sentParts),
    };
  } catch {
    return null;
  }
}

/* ============================================================
   MARK SENT
   ============================================================ */

export async function markPartSent(
  db: D1Database,
  sessionId: string,
  partIndex: number
): Promise<void> {
  try {
    await ensureCharCacheTable(db);

    const row = await db
      .prepare('SELECT sent_parts FROM qimochi_char_cache WHERE session_id = ?')
      .bind(sessionId)
      .first<{ sent_parts: string | null }>();

    if (!row) return;

    let sentParts: number[] = [];
    if (row.sent_parts) {
      try {
        const arr = JSON.parse(row.sent_parts);
        if (Array.isArray(arr)) sentParts = arr.filter((n) => typeof n === 'number');
      } catch {
        // ignore
      }
    }

    if (!sentParts.includes(partIndex)) {
      sentParts.push(partIndex);
      await db
        .prepare(
          'UPDATE qimochi_char_cache SET sent_parts = ? WHERE session_id = ?'
        )
        .bind(JSON.stringify(sentParts), sessionId)
        .run();
    }
  } catch (err) {
    console.warn('[CharCache] mark sent error:', err);
  }
}

/* ============================================================
   DELETE
   ============================================================ */

export async function deleteCharCache(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await ensureCharCacheTable(db);
    await db
      .prepare('DELETE FROM qimochi_char_cache WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[CharCache] delete error:', err);
  }
}

/* ============================================================
   PARTS
   ============================================================ */

export function getCharacterPart(
  chars: UnifiedCharacter[],
  partIndex: number,
  partSize = CHAR_PART_SIZE
): { items: UnifiedCharacter[]; start: number; end: number } | null {
  const total = chars.length;
  const start = partIndex * partSize;
  const end = Math.min(start + partSize, total);

  if (start >= total) return null;

  return {
    items: chars.slice(start, end),
    start: start + 1,
    end,
  };
}

export function countParts(total: number, partSize = CHAR_PART_SIZE): number {
  return Math.ceil(total / partSize);
}

/* ============================================================
   MENU KEYBOARD
   ============================================================ */

const PARTS_PER_ROW = 5;

export function buildPartsKeyboard(
  sessionId: string,
  total: number,
  sentParts: Set<number> = new Set(),
  partSize = CHAR_PART_SIZE
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const numParts = countParts(total, partSize);

  for (let i = 0; i < numParts; i++) {
    const start = i * partSize + 1;
    const end = Math.min((i + 1) * partSize, total);
    const isSent = sentParts.has(i);
    const label = isSent ? `✅ ${start}-${end}` : `${start}-${end}`;

    kb.text(label, `qd:cp:${i}:${sessionId}`);

    if ((i + 1) % PARTS_PER_ROW === 0) {
      kb.row();
    }
  }

  if (numParts % PARTS_PER_ROW !== 0) {
    kb.row();
  }

  kb.text('❌ Batal', `qd:x:${sessionId}`);

  return kb;
}
