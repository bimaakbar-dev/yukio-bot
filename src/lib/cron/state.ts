// src/lib/cron/state.ts
import type { D1Database } from '@cloudflare/workers-types';
import { createLazyInit } from '../lazy-init';

export type SiteKey = 'lexanime' | 'animesub' | 'samehadaku';

export interface TrackedAnimeRow {
  slug: string;
  site: SiteKey;
  source_slug: string;
  fallback_site: SiteKey | null;
  schedule_day: string;
  schedule_hour: number;
  schedule_minute: number;
  buffer_min: number;
  chunk_start: number;
  chunk_end: number;
  last_ep: number;
  status: 'active' | 'paused' | 'finished';
  last_check_at: number | null;
  last_push_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PublishedEpisodeRow {
  slug: string;
  ep_number: number;
  site: SiteKey;
  commit_sha: string | null;
  published_at: number;
}

export interface CronLogRow {
  id: number;
  run_at: number;
  anime_checked: number;
  episodes_found: number;
  episodes_pushed: number;
  errors_json: string;
}

export const ensureCronDb = createLazyInit('Cron', async (db) => {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS tracked_anime (
        slug             TEXT PRIMARY KEY,
        site             TEXT NOT NULL,
        source_slug      TEXT NOT NULL,
        fallback_site    TEXT,
        schedule_day     TEXT NOT NULL,
        schedule_hour    INTEGER NOT NULL,
        schedule_minute  INTEGER NOT NULL DEFAULT 0,
        buffer_min       INTEGER NOT NULL DEFAULT 60,
        chunk_start      INTEGER NOT NULL DEFAULT 0,
        chunk_end        INTEGER NOT NULL DEFAULT 0,
        last_ep          INTEGER NOT NULL DEFAULT 0,
        status           TEXT NOT NULL DEFAULT 'active',
        last_check_at    INTEGER,
        last_push_at     INTEGER,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      )`
    )
    .run();

  try {
    await db
      .prepare(
        'ALTER TABLE tracked_anime ADD COLUMN schedule_minute INTEGER NOT NULL DEFAULT 0'
      )
      .run();
  } catch {}

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS published_episodes (
        slug         TEXT NOT NULL,
        ep_number    INTEGER NOT NULL,
        site         TEXT NOT NULL,
        commit_sha   TEXT,
        published_at INTEGER NOT NULL,
        PRIMARY KEY (slug, ep_number)
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_published_recent
       ON published_episodes(published_at DESC)`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS cron_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_at          INTEGER NOT NULL,
        anime_checked   INTEGER NOT NULL DEFAULT 0,
        episodes_found  INTEGER NOT NULL DEFAULT 0,
        episodes_pushed INTEGER NOT NULL DEFAULT 0,
        errors_json     TEXT NOT NULL DEFAULT '[]'
      )`
    )
    .run();
});

export interface SaveTrackedAnimeInput {
  slug: string;
  site: SiteKey;
  sourceSlug: string;
  fallbackSite: SiteKey | null;
  scheduleDay: string;
  scheduleHour: number;
  scheduleMinute?: number;
  bufferMin?: number;
}

export async function saveTrackedAnime(
  db: D1Database,
  data: SaveTrackedAnimeInput
): Promise<void> {
  await ensureCronDb(db);
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO tracked_anime
        (slug, site, source_slug, fallback_site, schedule_day, schedule_hour,
         schedule_minute, buffer_min, chunk_start, chunk_end, last_ep, status,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'active', ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         site = excluded.site,
         source_slug = excluded.source_slug,
         fallback_site = excluded.fallback_site,
         schedule_day = excluded.schedule_day,
         schedule_hour = excluded.schedule_hour,
         schedule_minute = excluded.schedule_minute,
         buffer_min = excluded.buffer_min,
         status = 'active',
         updated_at = excluded.updated_at`
    )
    .bind(
      data.slug,
      data.site,
      data.sourceSlug,
      data.fallbackSite,
      data.scheduleDay,
      data.scheduleHour,
      data.scheduleMinute ?? 0,
      data.bufferMin ?? 60,
      now,
      now
    )
    .run();
}

export async function getTrackedAnime(
  db: D1Database,
  slug: string
): Promise<TrackedAnimeRow | null> {
  await ensureCronDb(db);
  return db
    .prepare('SELECT * FROM tracked_anime WHERE slug = ?')
    .bind(slug)
    .first<TrackedAnimeRow>();
}

export async function listTrackedAnime(
  db: D1Database
): Promise<TrackedAnimeRow[]> {
  await ensureCronDb(db);
  const res = await db
    .prepare(
      `SELECT * FROM tracked_anime
       WHERE status = 'active'
       ORDER BY schedule_hour, schedule_minute`
    )
    .all<TrackedAnimeRow>();
  return res.results ?? [];
}

export async function listAllTrackedAnime(
  db: D1Database
): Promise<TrackedAnimeRow[]> {
  await ensureCronDb(db);
  const res = await db
    .prepare(
      `SELECT * FROM tracked_anime
       ORDER BY status, schedule_hour, schedule_minute`
    )
    .all<TrackedAnimeRow>();
  return res.results ?? [];
}

export async function deleteTrackedAnime(
  db: D1Database,
  slug: string
): Promise<boolean> {
  await ensureCronDb(db);
  const res = await db
    .prepare('DELETE FROM tracked_anime WHERE slug = ?')
    .bind(slug)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function setTrackedStatus(
  db: D1Database,
  slug: string,
  status: 'active' | 'paused' | 'finished'
): Promise<boolean> {
  await ensureCronDb(db);
  const res = await db
    .prepare(
      `UPDATE tracked_anime
       SET status = ?, updated_at = ?
       WHERE slug = ?`
    )
    .bind(status, Date.now(), slug)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function updateTrackedSourceSlug(
  db: D1Database,
  slug: string,
  newSourceSlug: string
): Promise<boolean> {
  await ensureCronDb(db);
  const res = await db
    .prepare(
      `UPDATE tracked_anime
       SET source_slug = ?, updated_at = ?
       WHERE slug = ?`
    )
    .bind(newSourceSlug, Date.now(), slug)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function updateTrackedChunkState(
  db: D1Database,
  slug: string,
  newEp: number
): Promise<{ chunkStart: number; chunkEnd: number; isNewChunk: boolean }> {
  await ensureCronDb(db);

  const row = await getTrackedAnime(db, slug);
  if (!row) throw new Error(`Tracked anime not found: ${slug}`);

  const currentCount = row.chunk_end - row.chunk_start + 1;
  const isNewChunk = currentCount >= 6 || row.chunk_start === 0;

  const newChunkStart = isNewChunk ? newEp : row.chunk_start;
  const newChunkEnd = newEp;
  const now = Date.now();

  await db
    .prepare(
      `UPDATE tracked_anime
       SET chunk_start = ?, chunk_end = ?, last_ep = ?,
           last_push_at = ?, updated_at = ?
       WHERE slug = ?`
    )
    .bind(newChunkStart, newChunkEnd, newEp, now, now, slug)
    .run();

  return { chunkStart: newChunkStart, chunkEnd: newChunkEnd, isNewChunk };
}

export async function setLastCheckAt(
  db: D1Database,
  slug: string
): Promise<void> {
  await ensureCronDb(db);
  await db
    .prepare('UPDATE tracked_anime SET last_check_at = ? WHERE slug = ?')
    .bind(Date.now(), slug)
    .run();
}

export async function clearLastCheckAt(
  db: D1Database,
  slug: string
): Promise<void> {
  await ensureCronDb(db);
  await db
    .prepare('UPDATE tracked_anime SET last_check_at = NULL WHERE slug = ?')
    .bind(slug)
    .run();
}

export async function markEpisodePublished(
  db: D1Database,
  slug: string,
  epNumber: number,
  site: SiteKey,
  commitSha: string | null
): Promise<void> {
  await ensureCronDb(db);
  await db
    .prepare(
      `INSERT INTO published_episodes
        (slug, ep_number, site, commit_sha, published_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(slug, ep_number) DO UPDATE SET
         site = excluded.site,
         commit_sha = excluded.commit_sha,
         published_at = excluded.published_at`
    )
    .bind(slug, epNumber, site, commitSha, Date.now())
    .run();
}

export async function isEpisodePublished(
  db: D1Database,
  slug: string,
  epNumber: number
): Promise<boolean> {
  await ensureCronDb(db);
  const row = await db
    .prepare(
      'SELECT 1 FROM published_episodes WHERE slug = ? AND ep_number = ?'
    )
    .bind(slug, epNumber)
    .first<{ 1: number }>();
  return !!row;
}

export async function countEpisodesLast24h(
  db: D1Database
): Promise<number> {
  await ensureCronDb(db);
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const row = await db
    .prepare(
      'SELECT COUNT(*) as c FROM published_episodes WHERE published_at > ?'
    )
    .bind(since)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function writeCronLog(
  db: D1Database,
  data: {
    animeChecked: number;
    episodesFound: number;
    episodesPushed: number;
    errors: string[];
  }
): Promise<void> {
  await ensureCronDb(db);
  await db
    .prepare(
      `INSERT INTO cron_log
        (run_at, anime_checked, episodes_found, episodes_pushed, errors_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      Date.now(),
      data.animeChecked,
      data.episodesFound,
      data.episodesPushed,
      JSON.stringify(data.errors.slice(0, 20))
    )
    .run();
}

export const DAY_NAMES_ID = [
  'Minggu',
  'Senin',
  'Selasa',
  'Rabu',
  'Kamis',
  'Jumat',
  'Sabtu',
] as const;

export function dayNameToIndex(day: string): number {
  const lower = day.toLowerCase();
  return DAY_NAMES_ID.findIndex((d) => d.toLowerCase() === lower);
}

export function isInScheduleWindow(row: TrackedAnimeRow): boolean {
  const COOLDOWN_MS = 6 * 60 * 60 * 1000;

  if (row.schedule_day === 'Random') {
    if (!row.last_check_at) return true;
    return Date.now() - row.last_check_at > COOLDOWN_MS;
  }

  const targetDay = dayNameToIndex(row.schedule_day);
  if (targetDay === -1) return false;

  const now = new Date();
  const wibMs = now.getTime() + 7 * 3600 * 1000;
  const wib = new Date(wibMs);
  const wibDayIdx = wib.getUTCDay();
  const wibHour = wib.getUTCHours();
  const wibMinute = wib.getUTCMinutes();

  let daysAgo = (wibDayIdx - targetDay + 7) % 7;

  const targetTotalMin =
    row.schedule_hour * 60 + row.schedule_minute + row.buffer_min;
  const nowTotalMin = wibHour * 60 + wibMinute;

  if (daysAgo === 0 && nowTotalMin < targetTotalMin) {
    daysAgo = 7;
  }
  const todayWibStartMs =
    Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate()) -
    7 * 3600 * 1000;

  const scheduleMs =
    todayWibStartMs -
    daysAgo * 24 * 3600 * 1000 +
    targetTotalMin * 60 * 1000;
  if (now.getTime() < scheduleMs) return false;
  if (!row.last_check_at) return true;
  if (row.last_check_at >= scheduleMs) return false;

  return true;
}

export function formatScheduleTime(row: TrackedAnimeRow): string {
  const hh = String(row.schedule_hour).padStart(2, '0');
  const mm = String(row.schedule_minute ?? 0).padStart(2, '0');
  return `${hh}:${mm}`;
}
