// src/services/qimochi-yaml.ts
import type { AniListMedia } from '../types/anime';
import type {
  UnifiedCharacter,
  UnifiedEpisode,
  UnifiedRelation,
} from './qimochi-chain-extras';

const MAX_CHARACTERS = 100;
const MAX_EPISODES_WARN = 700;

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

const ROLE_MAP: Record<string, string> = {
  main: 'main',
  supporting: 'supporting',
  background: 'background',
};

function slugify(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

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

/* ============================================================
   METADATA — frontmatter lengkap
   ============================================================ */

export interface MetadataInput {
  media: AniListMedia;
  malId: number | null;
  kitsuId: string | null;
}

export function buildMetadataYaml(input: MetadataInput): string {
  const { media, malId, kitsuId } = input;
  const lines: string[] = [];

  // === FRONTMATTER OPEN ===
  lines.push('---');

  // === TITLE ===
  lines.push(`title: ${yamlString(media.title.romaji || 'Unknown')}`);
  if (media.title.english) {
    lines.push(`titleEnglish: ${yamlString(media.title.english)}`);
  }
  if (media.title.native) {
    lines.push(`titleNative: ${yamlString(media.title.native)}`);
  }
  lines.push('');

  // === EXTERNAL IDs ===
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

  // === TYPE / STATUS / SOURCE ===
  lines.push(`type: ${FORMAT_MAP[media.format] ?? 'Unknown'}`);
  lines.push(`status: ${STATUS_MAP[media.status] ?? 'finished'}`);

  if (media.source) {
    lines.push(`source: ${media.source}`);
  } else {
    lines.push('# source: # edit manual');
  }
  lines.push('');

  // === SEASON / YEAR / EPISODES / DURATION / RATING ===
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

  // === AIRED ===
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

  // === STATS ===
  lines.push('stats:');
  if (media.averageScore && media.averageScore > 0) {
    lines.push(`  score: ${(media.averageScore / 10).toFixed(1)}`);
  } else {
    lines.push('  # score: # edit manual');
  }
  lines.push('  # scoredBy: # edit manual');
  lines.push('');

  // === GENRES ===
  const genres = (media.genres ?? []).map(slugify).filter(Boolean);
  if (genres.length > 0) {
    lines.push('genres:');
    for (const g of genres) lines.push(`  - ${g}`);
  } else {
    lines.push('genres: []');
  }
  lines.push('');

  // === STUDIOS ===
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

  // === FRANCHISES (placeholder — diisi dari section Franchises) ===
  lines.push('# Ganti dengan section "Franchises" dari /dba');
  lines.push('franchises: []');
  lines.push('');

  // === IMAGES ===
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

  // === PLACEHOLDER SECTIONS ===
  lines.push('# Ganti dengan section "Episodes" dari /dba');
  lines.push('episodeList: []');
  lines.push('');
  lines.push('# Ganti dengan section "Characters" dari /dba');
  lines.push('characters: []');
  lines.push('');

  // === DRAFT ===
  lines.push('draft: false');
  lines.push('---');

  return lines.join('\n');
}

/* ============================================================
   CHARACTERS
   ============================================================ */

export function buildCharactersYaml(chars: UnifiedCharacter[]): string {
  if (!chars || chars.length === 0) {
    return '# ⚠️ Tidak ada data karakter. Isi manual.\ncharacters: []';
  }

  const main = chars.filter((c) => c.role === 'main');
  const supporting = chars.filter((c) => c.role === 'supporting');
  const sorted = [...main, ...supporting].slice(0, MAX_CHARACTERS);

  if (sorted.length === 0) {
    return '# ⚠️ Tidak ada karakter main/supporting. Isi manual.\ncharacters: []';
  }

  const lines: string[] = [];
  lines.push('characters:');

  for (const char of sorted) {
    lines.push(`  - name: ${yamlString(char.name)}`);
    lines.push('    # nameNative: # edit manual');
    if (char.image) {
      lines.push(`    image: "${char.image}"`);
    } else {
      lines.push('    # image: # edit manual');
    }
    lines.push(`    role: ${ROLE_MAP[char.role] ?? 'supporting'}`);
    lines.push('    # voiceActors: # edit manual');
  }

  if (chars.length > MAX_CHARACTERS) {
    lines.push('');
    lines.push(
      `# ⚠️ Di-truncate dari ${chars.length} ke ${MAX_CHARACTERS}. Tambah manual kalau perlu.`
    );
  }

  return lines.join('\n');
}

/* ============================================================
   EPISODES
   ============================================================ */

export function buildEpisodesYaml(episodes: UnifiedEpisode[]): string {
  if (!episodes || episodes.length === 0) {
    return '# ⚠️ Tidak ada data episode. Isi manual.\nepisodeList: []';
  }

  const lines: string[] = [];
  lines.push('episodeList:');

  for (const ep of episodes) {
    lines.push(`  - number: ${ep.number}`);
    lines.push(`    title: ${yamlString(ep.title)}`);
    if (ep.aired) {
      lines.push(`    aired: "${ep.aired}"`);
    } else {
      lines.push('    # aired: # edit manual');
    }
    if (ep.duration && ep.duration > 0) {
      lines.push(`    duration: ${ep.duration}`);
    }
  }

  if (episodes.length >= MAX_EPISODES_WARN) {
    lines.push('');
    lines.push(
      `# ⚠️ Di-truncate ${MAX_EPISODES_WARN} episode (time budget). Sisanya isi manual.`
    );
  }

  return lines.join('\n');
}

/* ============================================================
   FRANCHISES
   ============================================================ */

export function buildFranchisesYaml(relations: UnifiedRelation[]): string {
  if (!relations || relations.length === 0) {
    return '# ⚠️ Tidak ada data franchise/relation. Isi manual.\nfranchises: []';
  }

  const lines: string[] = [];
  lines.push('franchises:');

  for (const rel of relations) {
    lines.push(`  - relation: ${rel.relation}`);
    lines.push(`    slug: ${yamlString(rel.slug)}`);
    lines.push(`    title: ${yamlString(rel.title)}`);
  }

  lines.push('');
  lines.push('# ⚠️ Verifikasi slug di atas cocok dengan file .md yang ada.');

  return lines.join('\n');
}

/* ============================================================
   SUMMARY
   ============================================================ */

export function getSynopsisRaw(media: AniListMedia): string {
  return cleanSynopsisRaw(media.description);
}

/* ============================================================
   ALL
   ============================================================ */

export interface AllInput {
  metadata: string;
  characters: string;
  episodes: string;
  franchises: string;
  summary: string;
}

export function buildAllMarkdown(input: AllInput): string {
  const parts: string[] = [];
  parts.push(input.metadata);
  parts.push('');
  parts.push(input.characters);
  parts.push('');
  parts.push(input.episodes);
  parts.push('');
  parts.push(input.franchises);
  parts.push('');
  parts.push(input.summary);
  return parts.join('\n');
}
