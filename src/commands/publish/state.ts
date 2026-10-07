// src/commands/publish/state.ts
import type { D1Database } from '@cloudflare/workers-types';
import type { FileToCommit } from '../../lib/github';
import { createLazyInit } from '../../lib/lazy-init';
import {
  PUBLISH_TTL_MS,
  type PendingPublishRow,
  type PublishSummary,
  type SectionKey,
} from './types';

export const ensurePendingPublishDb = createLazyInit(
  'Publish',
  async (db) => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS pending_publish (
          session_id    TEXT PRIMARY KEY,
          user_id       INTEGER NOT NULL,
          files_json    TEXT NOT NULL,
          summary_json  TEXT NOT NULL,
          selected_json TEXT,
          created_at    INTEGER NOT NULL,
          expires_at    INTEGER NOT NULL
        )`
      )
      .run();
    try {
      await db
        .prepare('ALTER TABLE pending_publish ADD COLUMN selected_json TEXT')
        .run();
    } catch {}
  }
);

export async function savePendingPublish(
  db: D1Database,
  userId: number,
  files: FileToCommit[],
  summary: PublishSummary,
  selected: SectionKey[]
): Promise<string> {
  await ensurePendingPublishDb(db);
  const sessionId = 'pp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 13);
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO pending_publish
        (session_id, user_id, files_json, summary_json, selected_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      userId,
      JSON.stringify(files),
      JSON.stringify(summary),
      JSON.stringify(selected),
      now,
      now + PUBLISH_TTL_MS
    )
    .run();

  return sessionId;
}

export async function getPendingPublish(
  db: D1Database,
  sessionId: string
): Promise<PendingPublishRow | null> {
  await ensurePendingPublishDb(db);

  const row = await db
    .prepare('SELECT * FROM pending_publish WHERE session_id = ?')
    .bind(sessionId)
    .first<PendingPublishRow>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM pending_publish WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }

  return row;
}

export async function updatePendingSelected(
  db: D1Database,
  sessionId: string,
  selected: SectionKey[]
): Promise<void> {
  await ensurePendingPublishDb(db);
  await db
    .prepare('UPDATE pending_publish SET selected_json = ? WHERE session_id = ?')
    .bind(JSON.stringify(selected), sessionId)
    .run();
}

export async function deletePendingPublish(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await ensurePendingPublishDb(db);
    await db
      .prepare('DELETE FROM pending_publish WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[Publish] deletePendingPublish error:', err);
  }
}