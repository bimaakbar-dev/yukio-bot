// src/commands/edit/state.ts
import type { D1Database } from '@cloudflare/workers-types';
import { createLazyInit } from '../../lib/lazy-init';
import type { EditState, EditTarget, PendingEditRow } from './types';

const TTL_MS = 30 * 60 * 1000;

export const ensureEditDb = createLazyInit('Edit', async (db) => {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS pending_edit (
        session_id   TEXT PRIMARY KEY,
        user_id      INTEGER NOT NULL,
        target       TEXT NOT NULL,
        slug         TEXT NOT NULL DEFAULT '',
        state        TEXT NOT NULL,
        active_field TEXT,
        base_content TEXT NOT NULL DEFAULT '',
        edits_json   TEXT NOT NULL DEFAULT '{}',
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL
      )`
    )
    .run();
});

export async function createEditSession(
  db: D1Database,
  userId: number,
  target: EditTarget
): Promise<string> {
  await ensureEditDb(db);
  const sessionId =
    'ed_' + crypto.randomUUID().replace(/-/g, '').slice(0, 13);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO pending_edit
        (session_id, user_id, target, slug, state, active_field, base_content, edits_json, created_at, expires_at)
       VALUES (?, ?, ?, '', 'awaiting_slug', NULL, '', '{}', ?, ?)`
    )
    .bind(sessionId, userId, target, now, now + TTL_MS)
    .run();
  return sessionId;
}

export async function getEditSession(
  db: D1Database,
  sessionId: string
): Promise<PendingEditRow | null> {
  await ensureEditDb(db);
  const row = await db
    .prepare('SELECT * FROM pending_edit WHERE session_id = ?')
    .bind(sessionId)
    .first<PendingEditRow>();

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM pending_edit WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }
  return row;
}

export async function getActiveEditSession(
  db: D1Database,
  userId: number
): Promise<PendingEditRow | null> {
  await ensureEditDb(db);
  return db
    .prepare(
      `SELECT * FROM pending_edit
       WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(userId, Date.now())
    .first<PendingEditRow>();
}

export interface EditPatch {
  slug?: string;
  state?: EditState;
  active_field?: string | null;
  base_content?: string;
  edits_json?: string;
}

export async function updateEditSession(
  db: D1Database,
  sessionId: string,
  patch: EditPatch
): Promise<void> {
  await ensureEditDb(db);
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
    .prepare(`UPDATE pending_edit SET ${sets.join(', ')} WHERE session_id = ?`)
    .bind(...values)
    .run();
}

export async function deleteEditSession(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await ensureEditDb(db);
    await db
      .prepare('DELETE FROM pending_edit WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[Edit] delete error:', err);
  }
}

export function parseEdits(row: PendingEditRow): Record<string, string> {
  try {
    const obj = JSON.parse(row.edits_json);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return obj as Record<string, string>;
    }
  } catch {}
  return {};
}