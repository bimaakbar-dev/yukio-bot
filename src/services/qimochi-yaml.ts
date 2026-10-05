// src/services/qimochi-yaml.ts
import type { AniListMedia } from '../types/anime';
import type {
  JikanCharacterEntry,
  JikanEpisodeEntry,
  JikanRelationEntry,
} from './jikan-extras';

const MAX_CHARACTERS = 20;
const RELATION_MAP: Record<string, string> = {
  Sequel: 'sequel',
  Prequel: 'prequel',
  'Side Story': 'side_story',
  'Parent Story': 'parent_story',
  Alternative: 'alternative',
  'Alternative Version': 'alternative',
  'Spin-Off': 'spin_off',
  Summary: 'summary',
  'Full Story': 'full_story',
  Character: 'character',
  Other: 'other',
  Adaptation: 'adaptation',
};

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
  Main: 'main',
  Supporting: 'supporting',
  Background: 'background',
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
  year: number | null,
  month: number | null,
  day: number | null
): string | null {
  if (!year || !month || !day) return null;
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function convertDuration(raw: number | null): number | null {
  if (!raw || raw <= 0) return null;
  if (raw > 120) return Math.round(raw / 60);
  return raw;
}

/* ============================================================
   METADATA
   ============================================================ */

export interface MetadataInput {
  media: AniListMedia;
  malId: number | null;
  kitsuId: string | null;
  enriched?: {
    source?: string | null;
    season?: string | null;
    duration?: number | null;
    rating?: string | null;
  };
}

export function buildMetadataYaml(input: MetadataInput): string {
  const { media, malId, kitsuId, enriched } = input;
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

  if (malId) lines.push(`malId: ${malId}`);
  if (kitsuId) lines.push(`kitsuId: ${yamlString(kitsuId)}`);
  lines.push('');

  lines.push(`type: ${FORMAT_MAP[media.format] ?? 'Unknown'}`);
  lines.push(`status: ${STATUS_MAP[media.status] ?? 'finished'}`);

  if (enriched?.source) lines.push(`source: ${enriched.source}`);

  const seasonFromDate = guessSeason(media.startDate.month);
  if (enriched?.season) lines.push(`season: ${enriched.season}`);
  else if (seasonFromDate) lines.push(`season: ${seasonFromDate}`);

  if (media.seasonYear) lines.push(`year: ${media.seasonYear}`);
  if (media.episodes) lines.push(`episodes: ${media.episodes}`);

  const duration = enriched?.duration ?? convertDuration(null);
  if (duration) lines.push(`duration: ${duration}`);

  if (enriched?.rating) lines.push(`rating: ${enriched.rating}`);
  lines.push('');

  const airedFrom = formatDate(
    media.startDate.year,
    media.startDate.month,
    media.startDate.day
  );
  if (airedFrom) {
    lines.push('aired:');
    lines.push(`  from: "${airedFrom}"`);
    lines.push('  to: null');
    lines.push('');
  }

  if (media.averageScore && media.averageScore > 0) {
    lines.push('stats:');
    lines.push(`  score: ${(media.averageScore / 10).toFixed(1)}`);
    lines.push('');
  }

  const genres = (media.genres ?? []).map(slugify).filter(Boolean);
  if (genres.length > 0) {
    lines.push('genres:');
    for (const g of genres) lines.push(`  - ${g}`);
    lines.push('');
  }

  const studios = (media.studios?.nodes ?? [])
    .map((s) => slugify(s.name))
    .filter(Boolean);
  if (studios.length > 0) {
    lines.push('studios:');
    for (const s of studios) lines.push(`  - ${s}`);
    lines.push('');
  }

  if (media.coverImage.extraLarge) {
    lines.push(`image: "${media.coverImage.extraLarge}"`);
  }
  lines.push('');
  lines.push('draft: false');
  lines.push('---');

  return lines.join('\n');
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
   CHARACTERS
   ============================================================ */

export function buildCharactersYaml(chars: JikanCharacterEntry[]): string {
  if (!chars || chars.length === 0) {
    return '# ⚠️ Tidak ada data karakter. Isi manual.\ncharacters: []';
  }

  const main = chars.filter((c) => c.role === 'Main');
  const supporting = chars.filter((c) => c.role === 'Supporting');
  const sorted = [...main, ...supporting].slice(0, MAX_CHARACTERS);

  if (sorted.length === 0) {
    return '# ⚠️ Tidak ada karakter main/supporting. Isi manual.\ncharacters: []';
  }

  const lines: string[] = [];
  lines.push('characters:');

  for (const entry of sorted) {
    const c = entry.character;
    const role = ROLE_MAP[entry.role] ?? 'supporting';

    lines.push(`  - name: ${yamlString(c.name)}`);
    if (c.images?.jpg?.image_url) {
      lines.push(`    image: "${c.images.jpg.image_url}"`);
    }
    lines.push(`    role: ${role}`);

    const jpVA = (entry.voice_actors ?? []).find(
      (va) => va.language === 'Japanese'
    );
    if (jpVA) {
      lines.push('    voiceActors:');
      lines.push(`      - name: ${yamlString(jpVA.person.name)}`);
      if (jpVA.person.images?.jpg?.image_url) {
        lines.push(
          `        image: "${jpVA.person.images.jpg.image_url}"`
        );
      }
      lines.push('        language: Japanese');
    }
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

export function buildEpisodesYaml(episodes: JikanEpisodeEntry[]): string {
  if (!episodes || episodes.length === 0) {
    return '# ⚠️ Tidak ada data episode. Isi manual.\nepisodeList: []';
  }

  const lines: string[] = [];
  lines.push('episodeList:');

  for (const ep of episodes) {
    lines.push(`  - number: ${ep.mal_id || 0}`);
    lines.push(`    title: ${yamlString(ep.title || `Episode ${ep.mal_id}`)}`);

    const date = ep.aired ? ep.aired.split('T')[0] : null;
    if (date) lines.push(`    aired: "${date}"`);
  }

  if (episodes.length >= 100) {
    lines.push('');
    lines.push('# ⚠️ Di-truncate 100 episode. Tambah manual kalau perlu.');
  }

  return lines.join('\n');
}

/* ============================================================
   FRANCHISES
   ============================================================ */

export function buildFranchisesYaml(relations: JikanRelationEntry[]): string {
  if (!relations || relations.length === 0) {
    return '# ⚠️ Tidak ada data franchise/relation. Isi manual.\nfranchises: []';
  }

  const lines: string[] = [];
  lines.push('franchises:');

  for (const rel of relations) {
    const relationKey = RELATION_MAP[rel.relation] ?? 'other';

    if (!rel.entry || rel.entry.length === 0) continue;

    for (const entry of rel.entry) {
      const slug = slugify(entry.name);
      lines.push(`  - relation: ${relationKey}`);
      lines.push(`    slug: ${yamlString(slug)}`);
      lines.push(`    title: ${yamlString(entry.name)}`);
    }
  }

  lines.push('');
  lines.push('# ⚠️ Verifikasi slug di atas cocok dengan file .md yang ada.');

  return lines.join('\n');
}

/* ============================================================
   SUMMARY
   ============================================================ */

export function buildSummaryMd(media: AniListMedia): string {
  const synopsisRaw = media.description ? stripHtml(media.description) : '';

  if (!synopsisRaw || synopsisRaw.length < 30) {
    return '# ⚠️ Sinopsis tidak tersedia dari sumber. Tulis manual di sini.\n';
  }

  const lines: string[] = [];
  lines.push('<!--');
  lines.push('  ⚠️ Sinopsis di bawah diambil dari MAL (English) via Jikan.');
  lines.push('  WAJIB ditulis ulang dalam bahasa Indonesia sebelum commit.');
  lines.push('  Ini hanya referensi — JANGAN commit apa adanya.');
  lines.push('-->');
  lines.push('');
  lines.push(synopsisRaw);

  return lines.join('\n');
}

/* ============================================================
   ALL (gabungan)
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
