// src/lib/batch-session.ts
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../types/env';
import type { EpisodeObject } from '../types/anime';
import { githubListDir } from './github';

export const BATCH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface BatchSessionRow {
  session_id: string;
  user_id: number;
  slug_hint: string | null;
  chosen_slug: string | null;
  suggestions: string | null;
  combined_json: string;
  min_ep: number;
  max_ep: number;
  total_urls: number | null;
  errors: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface StartOrAppendResult {
  sessionId: string;
  mode: 'created' | 'appended' | 'reset_and_created';
  slugHint: string | null;
  totalEpisodes: number;
  minEp: number;
  maxEp: number;
  totalUrls: number;
  added: number[];
  skipped: number[];
}

let batchDbReady = false;
let batchDbInitPromise: Promise<void> | null = null;

export async function ensureBatchDb(db: D1Database): Promise<void> {
  if (batchDbReady) return;
  if (batchDbInitPromise) return batchDbInitPromise;

  batchDbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS batch_sessions (
            session_id     TEXT PRIMARY KEY,
            user_id        INTEGER NOT NULL,
            slug_hint      TEXT,
            chosen_slug    TEXT,
            suggestions    TEXT,
            combined_json  TEXT NOT NULL,
            min_ep         INTEGER NOT NULL,
            max_ep         INTEGER NOT NULL,
            total_urls     INTEGER,
            errors         TEXT,
            created_at     INTEGER NOT NULL,
            updated_at     INTEGER NOT NULL,
            expires_at     INTEGER NOT NULL
          )`
        )
        .run();
      await db
        .prepare(
          'CREATE INDEX IF NOT EXISTS idx_batch_sessions_user ON batch_sessions(user_id, updated_at DESC)'
        )
        .run();
      batchDbReady = true;
    } catch (err) {
      console.error('[BatchSession] DB init error:', err);
      batchDbInitPromise = null;
      throw err;
    }
  })();

  return batchDbInitPromise;
}

export async function getActiveSession(
  db: D1Database,
  userId: number
): Promise<BatchSessionRow | null> {
  await ensureBatchDb(db);
  try {
    const row = await db
      .prepare(
        `SELECT * FROM batch_sessions
         WHERE user_id = ? AND expires_at > ?
         ORDER BY updated_at DESC LIMIT 1`
      )
      .bind(userId, Date.now())
      .first<BatchSessionRow>();
    return row ?? null;
  } catch (err) {
    console.error('[BatchSession] getActiveSession error:', err);
    return null;
  }
}

export async function getBatchSession(
  db: D1Database,
  sessionId: string
): Promise<BatchSessionRow | null> {
  await ensureBatchDb(db);
  try {
    const row = await db
      .prepare('SELECT * FROM batch_sessions WHERE session_id = ?')
      .bind(sessionId)
      .first<BatchSessionRow>();

    if (!row) return null;
    if (row.expires_at < Date.now()) {
      await db
        .prepare('DELETE FROM batch_sessions WHERE session_id = ?')
        .bind(sessionId)
        .run()
        .catch(() => {});
      return null;
    }
    return row;
  } catch (err) {
    console.error('[BatchSession] getBatchSession error:', err);
    return null;
  }
}

export async function updateBatchChosenSlug(
  db: D1Database,
  sessionId: string,
  slug: string
): Promise<void> {
  await ensureBatchDb(db);
  await db
    .prepare('UPDATE batch_sessions SET chosen_slug = ? WHERE session_id = ?')
    .bind(slug, sessionId)
    .run();
}

export async function updateBatchSuggestions(
  db: D1Database,
  sessionId: string,
  suggestions: string[]
): Promise<void> {
  await ensureBatchDb(db);
  await db
    .prepare('UPDATE batch_sessions SET suggestions = ? WHERE session_id = ?')
    .bind(JSON.stringify(suggestions), sessionId)
    .run();
}

export async function deleteBatchSession(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await ensureBatchDb(db);
    await db
      .prepare('DELETE FROM batch_sessions WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[BatchSession] deleteBatchSession error:', err);
  }
}

export async function resetBatchSessions(
  db: D1Database,
  userId: number
): Promise<number> {
  await ensureBatchDb(db);
  try {
    const res = await db
      .prepare('DELETE FROM batch_sessions WHERE user_id = ?')
      .bind(userId)
      .run();
    return res.meta?.changes ?? 0;
  } catch (err) {
    console.error('[BatchSession] resetBatchSessions error:', err);
    return 0;
  }
}

export async function startOrAppendBatch(
  db: D1Database,
  userId: number,
  data: {
    slugHint: string | null;
    newEpisodes: EpisodeObject[];
    errors: string[];
  }
): Promise<StartOrAppendResult> {
  await ensureBatchDb(db);

  if (data.newEpisodes.length === 0) {
    throw new Error('Tidak ada episode baru untuk disimpan');
  }

  const existing = await getActiveSession(db, userId);
  const now = Date.now();

  let mode: StartOrAppendResult['mode'];
  let existingEpisodes: EpisodeObject[] = [];
  let sessionId: string;
  let isSameSeries = false;

  if (!existing) {
    mode = 'created';
    sessionId = 'b_' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
  } else if (
    !data.slugHint ||
    !existing.slug_hint ||
    existing.slug_hint === data.slugHint
  ) {
    mode = 'appended';
    sessionId = existing.session_id;
    isSameSeries = true;
    try {
      existingEpisodes = JSON.parse(existing.combined_json) as EpisodeObject[];
    } catch {
      existingEpisodes = [];
    }
  } else {
    mode = 'reset_and_created';
    await deleteBatchSession(db, existing.session_id);
    sessionId = 'b_' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
  }

  const existingNumbers = new Set(existingEpisodes.map((e) => e.number));
  const added: number[] = [];
  const skipped: number[] = [];
  const merged: EpisodeObject[] = [...existingEpisodes];

  for (const ep of data.newEpisodes) {
    if (existingNumbers.has(ep.number)) {
      skipped.push(ep.number);
    } else {
      added.push(ep.number);
      merged.push(ep);
    }
  }

  merged.sort((a, b) => a.number - b.number);

  if (merged.length === 0) {
    throw new Error('Tidak ada episode yang bisa disimpan');
  }

  const first = merged[0];
  const last = merged[merged.length - 1];
  if (!first || !last) {
    throw new Error('Gagal menghitung range episode');
  }

  const minEp = first.number;
  const maxEp = last.number;
  const totalUrls = merged.reduce(
    (sum, r) => sum + r.streams.reduce((s, q) => s + q.servers.length, 0),
    0
  );
  const combinedJson = JSON.stringify(merged, null, 2) + '\n';

  let existingErrors: string[] = [];
  if (existing && isSameSeries && existing.errors) {
    try {
      existingErrors = JSON.parse(existing.errors) as string[];
    } catch {
      existingErrors = [];
    }
  }
  const mergedErrors = [...existingErrors, ...data.errors].slice(-20);

  if (mode === 'created' || mode === 'reset_and_created') {
    await db
      .prepare(
        `INSERT INTO batch_sessions
          (session_id, user_id, slug_hint, chosen_slug, suggestions, combined_json, min_ep, max_ep, total_urls, errors, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        sessionId,
        userId,
        data.slugHint,
        null,
        null,
        combinedJson,
        minEp,
        maxEp,
        totalUrls,
        JSON.stringify(mergedErrors),
        now,
        now,
        now + BATCH_SESSION_TTL_MS
      )
      .run();
  } else {
    await db
      .prepare(
        `UPDATE batch_sessions
         SET combined_json = ?, min_ep = ?, max_ep = ?, total_urls = ?, errors = ?, updated_at = ?, expires_at = ?
         WHERE session_id = ?`
      )
      .bind(
        combinedJson,
        minEp,
        maxEp,
        totalUrls,
        JSON.stringify(mergedErrors),
        now,
        now + BATCH_SESSION_TTL_MS,
        sessionId
      )
      .run();
  }

  return {
    sessionId,
    mode,
    slugHint: data.slugHint,
    totalEpisodes: merged.length,
    minEp,
    maxEp,
    totalUrls,
    added,
    skipped,
  };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const m: number[][] = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) {
    const row = m[0];
    if (row) row[j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const rowPrev = m[i - 1];
      const rowCurr = m[i];
      if (!rowPrev || !rowCurr) continue;

      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      const del = (rowPrev[j] ?? 0) + 1;
      const ins = (rowCurr[j - 1] ?? 0) + 1;
      const sub = (rowPrev[j - 1] ?? 0) + cost;
      rowCurr[j] = Math.min(del, ins, sub);
    }
  }

  const lastRow = m[b.length];
  return lastRow ? (lastRow[a.length] ?? 0) : 0;
}

function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

export async function findSimilarSlugs(
  env: Env,
  hint: string
): Promise<{ slug: string; score: number }[]> {
  if (!hint) return [];
  try {
    const dirs = await githubListDir(env, 'src/data/anime');
    const candidates = dirs
      .filter((d) => d.type === 'dir')
      .map((d) => d.name);

    return candidates
      .map((slug) => ({
        slug,
        score: similarity(hint.toLowerCase(), slug.toLowerCase()),
      }))
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  } catch (err) {
    console.warn('[BatchSession] findSimilarSlugs error:', err);
    return [];
  }
}