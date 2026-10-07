// src/services/qimochi-yaml.ts
import type { AniListMedia } from '../types/anime';
import { slugify } from '../lib/utils';

const FORMAT_MAP: Record<string, string> = {
  TV: 'TV',
  TV_SHORT: 'TV',
  MOVIE: 'Movie',
  SPECIAL: 'Special',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'Music',
  UNKNOWN: 'Unknown',
};

const STATUS_MAP: Record<string, string> = {
  FINISHED: 'finished',
  RELEASING: 'airing',
  NOT_YET_RELEASED: 'upcoming',
  CANCELLED: 'cancelled',
  HIATUS: 'hiatus',
};

function yamlString(s: string): string {
  const cleaned = s.replace(/\n/g, ' ').trim();
  const needsQuote =
    /[:#&*!|>'"%@`{}\[\],]/.test(cleaned) ||
    cleaned === '' ||
    /^\d/.test(cleaned);
  if (!needsQuote) return cleaned;
  return `"${cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function formatDate(
  year: number | null | undefined,
  month: number | null | undefined,
  day: number | null | undefined
): string | null {
  if (!year || !month || !day) return null;
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

function cleanSynopsisRaw(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function guessSeason(month: number | null): string | null {
  if (!month) return null;
  if (month >= 1 && month <= 3) return 'winter';
  if (month >= 4 && month <= 6) return 'spring';
  if (month >= 7 && month <= 9) return 'summer';
  if (month >= 10 && month <= 12) return 'fall';
  return null;
}

export interface MetadataInput {
  media: AniListMedia;
  malId: number | null;
  kitsuId: string | null;
}

export function buildMetadataYaml(input: MetadataInput): string {
  const { media, malId, kitsuId } = input;
  const lines: string[] = [];

  lines.push('---');
  lines.push(`title: ${yamlString(media.title.romaji || 'Unknown')}`);
  if (media.title.english) {
    lines.push(`titleEnglish: ${yamlString(media.title.english)}`);
  }
  if (media.title.native) {
    lines.push(`titleNative: ${yamlString(media.title.native)}`);
  }
  lines.push('');

  const effectiveMalId = malId ?? media.myanimelistId ?? null;
  if (effectiveMalId) {
    lines.push(`malId: ${effectiveMalId}`);
  } else {
    lines.push('# malId: # edit manual');
  }
  if (kitsuId) {
    lines.push(`kitsuId: ${yamlString(kitsuId)}`);
  } else {
    lines.push('# kitsuId: # edit manual');
  }
  lines.push('');

  lines.push(`type: ${FORMAT_MAP[media.format] ?? 'Unknown'}`);
  lines.push(`status: ${STATUS_MAP[media.status] ?? 'finished'}`);

  if (media.source) {
    lines.push(`source: ${media.source}`);
  } else {
    lines.push('# source: # edit manual');
  }
  lines.push('');

  const season = guessSeason(media.startDate.month);
  if (season) lines.push(`season: ${season}`);
  if (media.seasonYear) lines.push(`year: ${media.seasonYear}`);
  if (media.episodes) lines.push(`episodes: ${media.episodes}`);

  if (media.duration && media.duration > 0) {
    lines.push(`duration: ${media.duration}`);
  } else {
    lines.push('# duration: # edit manual');
  }

  if (media.rating) {
    lines.push(`rating: ${media.rating}`);
  } else {
    lines.push('# rating: # edit manual');
  }
  lines.push('');

  const airedFrom = formatDate(
    media.startDate.year,
    media.startDate.month,
    media.startDate.day
  );
  const airedTo = formatDate(
    media.endDate?.year ?? null,
    media.endDate?.month ?? null,
    media.endDate?.day ?? null
  );

  lines.push('aired:');
  if (airedFrom) {
    lines.push(`  from: "${airedFrom}"`);
  } else {
    lines.push('  # from: # edit manual');
  }
  if (airedTo) {
    lines.push(`  to: "${airedTo}"`);
  } else {
    lines.push('  # to: # edit manual');
  }
  lines.push('');

  lines.push('stats:');
  if (media.averageScore && media.averageScore > 0) {
    lines.push(`  score: ${(media.averageScore / 10).toFixed(1)}`);
  } else {
    lines.push('  # score: # edit manual');
  }
  lines.push('  # scoredBy: # edit manual');
  lines.push('');

  const genres = (media.genres ?? []).map(slugify).filter(Boolean);
  if (genres.length > 0) {
    lines.push('genres:');
    for (const g of genres) lines.push(`  - ${g}`);
  } else {
    lines.push('genres: []');
  }
  lines.push('');

  const studios = (media.studios?.nodes ?? [])
    .map((s) => slugify(s.name))
    .filter(Boolean);
  if (studios.length > 0) {
    lines.push('studios:');
    for (const s of studios) lines.push(`  - ${s}`);
  } else {
    lines.push('studios: []');
  }
  lines.push('');

  if (media.coverImage.extraLarge) {
    lines.push(`image: "${media.coverImage.extraLarge}"`);
  } else {
    lines.push('# image: # edit manual');
  }

  if (media.banner) {
    lines.push(`banner: "${media.banner}"`);
  } else {
    lines.push('# banner: # edit manual');
  }

  if (media.trailer) {
    lines.push(`trailer: "${media.trailer}"`);
  } else {
    lines.push('# trailer: # edit manual');
  }
  lines.push('');

  lines.push('draft: false');
  lines.push('---');

  return lines.join('\n');
}

export function getSynopsisRaw(media: AniListMedia): string {
  return cleanSynopsisRaw(media.description);
}