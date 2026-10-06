// src/lib/dba-metadata.ts
import { InlineKeyboard } from 'grammy';
import type { AniListMedia } from '../types/anime';
import { buildMetadataYaml } from '../services/qimochi-yaml';
import { escapeHtml } from './dba-common';
import type { SessionRow } from './dba-session';

/* ============================================================
   DETECT MISSING
   ============================================================ */

export interface MissingInfo {
  fields: string[];
  canShikimori: boolean;
  canKitsu: boolean;
}

const SHIKIMORI_CAN_FILL = new Set([
  'titleEnglish', 'titleNative', 'malId', 'source',
  'duration', 'rating', 'aired.to', 'genres', 'studios',
  'banner', 'trailer', 'stats.score',
]);

const KITSU_CAN_FILL = new Set([
  'titleEnglish', 'titleNative', 'kitsuId',
  'duration', 'banner', 'aired.to', 'genres', 'stats.score',
]);

export function detectMissing(
  media: AniListMedia,
  fetchedSources: string[]
): MissingInfo {
  const fields: string[] = [];

  if (!media.title.english) fields.push('titleEnglish');
  if (!media.title.native) fields.push('titleNative');
  if (!media.myanimelistId) fields.push('malId');
  if (!media.source) fields.push('source');
  if (!media.duration) fields.push('duration');
  if (!media.rating) fields.push('rating');
  if (!media.endDate) fields.push('aired.to');
  if (!media.genres || media.genres.length === 0) fields.push('genres');
  if (!media.studios?.nodes?.length) fields.push('studios');
  if (!media.banner) fields.push('banner');
  if (!media.trailer) fields.push('trailer');
  if (!media.averageScore) fields.push('stats.score');

  const hasShiki = fetchedSources.includes('shikimori');
  const hasKitsu = fetchedSources.includes('kitsu');

  const canShikimori =
    !hasShiki && fields.some((f) => SHIKIMORI_CAN_FILL.has(f));
  const canKitsu =
    !hasKitsu && fields.some((f) => KITSU_CAN_FILL.has(f));

  return { fields, canShikimori, canKitsu };
}

/* ============================================================
   MERGE
   ============================================================ */

export interface MergeResult {
  merged: AniListMedia;
  filled: string[];
}

export function mergeMetadata(
  base: AniListMedia,
  incoming: AniListMedia,
  sourceName: string
): MergeResult {
  const merged: AniListMedia = JSON.parse(JSON.stringify(base));
  const filled: string[] = [];

  if (!merged.title.english && incoming.title.english) {
    merged.title.english = incoming.title.english;
    filled.push('titleEnglish');
  }

  if (!merged.title.native && incoming.title.native) {
    merged.title.native = incoming.title.native;
    filled.push('titleNative');
  }

  if (!merged.myanimelistId && incoming.myanimelistId) {
    merged.myanimelistId = incoming.myanimelistId;
    filled.push('malId');
  }

  if (!merged.source && incoming.source) {
    merged.source = incoming.source;
    filled.push('source');
  }

  if (!merged.duration && incoming.duration) {
    merged.duration = incoming.duration;
    filled.push('duration');
  }

  if (!merged.rating && incoming.rating) {
    merged.rating = incoming.rating;
    filled.push('rating');
  }

  if (!merged.endDate && incoming.endDate) {
    merged.endDate = incoming.endDate;
    filled.push('aired.to');
  }

  if (
    (!merged.genres || merged.genres.length === 0) &&
    incoming.genres?.length
  ) {
    merged.genres = incoming.genres;
    filled.push('genres');
  }

  if (!merged.studios?.nodes?.length && incoming.studios?.nodes?.length) {
    merged.studios = incoming.studios;
    filled.push('studios');
  }

  if (!merged.banner && incoming.banner) {
    merged.banner = incoming.banner;
    filled.push('banner');
  }

  if (!merged.trailer && incoming.trailer) {
    merged.trailer = incoming.trailer;
    filled.push('trailer');
  }

  if (!merged.averageScore && incoming.averageScore) {
    merged.averageScore = incoming.averageScore;
    filled.push('stats.score');
  }

  if (!merged.coverImage.extraLarge && incoming.coverImage.extraLarge) {
    merged.coverImage.extraLarge = incoming.coverImage.extraLarge;
    merged.coverImage.large = incoming.coverImage.large;
    filled.push('image');
  }

  console.log(
    `[Merge] ${sourceName} filled: ${filled.length > 0 ? filled.join(', ') : 'nothing'}`
  );

  return { merged, filled };
}

/* ============================================================
   KEYBOARD + VIEW
   ============================================================ */

export function buildMetadataKeyboard(
  sessionId: string,
  missing: MissingInfo
): InlineKeyboard {
  const kb = new InlineKeyboard();
  let hasRow = false;

  if (missing.canShikimori) {
    kb.text('📡 Cari Shikimori', `qd:ms:${sessionId}`);
    hasRow = true;
  }
  if (missing.canKitsu) {
    if (hasRow) kb.row();
    kb.text('📡 Cari Kitsu', `qd:mk:${sessionId}`);
    hasRow = true;
  }
  if (hasRow) kb.row();
  kb.text('✅ Selesai', `qd:mo:${sessionId}`);

  return kb;
}

export function buildMetadataView(
  session: SessionRow,
  media: AniListMedia,
  missing: MissingInfo,
  sources: string[]
): string {
  const yaml = buildMetadataYaml({
    media,
    malId: media.myanimelistId ?? session.mal_id,
    kitsuId: session.kitsu_id,
  });

  const sourceLabel = sources.length > 0
    ? sources.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' + ')
    : '—';

  const lines: string[] = [];
  lines.push(`📋 <b>Metadata — ${escapeHtml(media.title.romaji)}</b>`);
  lines.push(`<i>Sumber: ${escapeHtml(sourceLabel)}</i>`);

  if (missing.fields.length > 0) {
    lines.push('');
    lines.push(
      `⚠️ <b>Field kosong (${missing.fields.length}):</b> ` +
        `<code>${escapeHtml(missing.fields.join(', '))}</code>`
    );
  } else {
    lines.push('');
    lines.push('✅ <b>Semua field lengkap!</b>');
  }

  lines.push('');
  lines.push(`<pre>${escapeHtml(yaml)}</pre>`);

  return lines.join('\n');
}
