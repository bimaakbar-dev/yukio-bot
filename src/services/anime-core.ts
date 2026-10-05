// src/services/anime-core.ts
import type { AniListMedia } from '../types/anime';
import type { Env } from '../types/env';
import { chainSearch, type ChainSearchResult } from './qimochi-chain';
import { chatAI } from './ai';

export const AI_TIMEOUT_MS = 8000;

export const QH_FORMAT_MAP: Record<string, string> = {
  TV: 'TV',
  TV_SHORT: 'TV',
  MOVIE: 'Movie',
  SPECIAL: 'Special',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'Special',
};

export const QH_STATUS_MAP: Record<string, string> = {
  FINISHED: 'Completed',
  RELEASING: 'Ongoing',
  NOT_YET_RELEASED: 'Ongoing',
  CANCELLED: 'Hiatus',
  HIATUS: 'Hiatus',
};

export interface Enriched {
  studio?: string | null;
  rating?: number | null;
  synopsis?: string | null;
  genre?: string[] | null;
  releaseDate?: string | null;
}

export interface ExistingData {
  studio?: string | null;
  rating?: number | null;
  genre?: string[] | null;
  releaseDate?: string | null;
  originalSynopsis?: string | null;
}

export interface BuildResult {
  yaml: string;
  body: string;
  missing: string[];
  aiUsed: string[];
}

export interface SearchResult {
  media: AniListMedia;
  malId: number | null;
  kitsuId: string | null;
  source: string;
  tried: string[];
  errors: string[];
}

export function pickTitle(media: AniListMedia): string {
  return (
    media.title.romaji ||
    media.title.english ||
    media.title.native ||
    'Unknown'
  );
}

export function yamlString(s: string): string {
  const cleaned = s.replace(/\n/g, ' ').trim();
  const needsQuote = /[:#&*!|>'"%@`{}\[\],]/.test(cleaned);
  if (!needsQuote) return cleaned;
  return `"${cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function stripHtml(s: string): string {
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

export function hasCyrillic(s: string): boolean {
  return /[\u0400-\u04FF\u0500-\u052F]/.test(s);
}

export function looksIndonesian(s: string): boolean {
  const lower = s.toLowerCase();
  const idWords = [
    ' yang ',
    ' dengan ',
    ' untuk ',
    ' adalah ',
    ' dan ',
    ' di ',
    ' ke ',
    ' dari ',
    ' ini ',
    ' itu ',
    ' tidak ',
    ' akan ',
    ' setelah ',
    ' ketika ',
    ' seorang ',
    ' sebuah ',
    ' dalam ',
    ' pada ',
  ];

  let matches = 0;
  for (const w of idWords) {
    if (lower.includes(w)) matches++;
  }
  return matches >= 3;
}

export function pick<T>(...values: (T | null | undefined)[]): T | null {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return v;
  }
  return null;
}

export function normalizeStudioName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;

  const lower = trimmed.toLowerCase();

  const knownKeep = [
    'studio',
    'animation',
    'production',
    'pictures',
    'works',
    'toei',
    'mappa',
    'ufotable',
    'bones',
    'wit ',
    'kyoto',
    'ghibli',
    'gibli',
    'shaft',
    'trigger',
    'sunrise',
    'gainax',
    'madhouse',
    'a-1',
    'pierrot',
    'j.c.staff',
    'jc staff',
    'cloverworks',
  ];

  if (knownKeep.some((k) => lower.includes(k))) {
    return trimmed;
  }

  return `Studio ${trimmed}`;
}

export async function searchAnime(query: string): Promise<SearchResult> {
  const result: ChainSearchResult = await chainSearch(query);
  return {
    media: result.media,
    malId: result.malId,
    kitsuId: result.kitsuId,
    source: result.source,
    tried: result.tried,
    errors: result.errors,
  };
}

export function detectMissing(media: AniListMedia): string[] {
  const need: string[] = [];

  const studio = media.studios?.nodes?.[0]?.name;
  if (!studio || studio === 'Unknown') need.push('studio');

  if (typeof media.averageScore !== 'number' || media.averageScore <= 0) {
    need.push('rating');
  }

  if (!media.genres || media.genres.length === 0) need.push('genre');

  if (!media.startDate?.year && !media.seasonYear) need.push('releaseDate');

  const desc = media.description ?? '';
  const cleanDesc = stripHtml(desc);

  if (!cleanDesc || cleanDesc.length < 50) {
    need.push('synopsis');
  } else if (hasCyrillic(cleanDesc) || !looksIndonesian(cleanDesc)) {
    need.push('synopsis');
  }

  return need;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function enrichWithAI(
  env: Env,
  title: string,
  existing: ExistingData,
  need: string[]
): Promise<Enriched | null> {
  if (need.length === 0) return null;

  const known: string[] = [];
  if (existing.studio) known.push(`studio: ${existing.studio}`);
  if (existing.rating) known.push(`rating: ${existing.rating}`);
  if (existing.genre?.length) known.push(`genre: ${existing.genre.join(', ')}`);
  if (existing.releaseDate) known.push(`releaseDate: ${existing.releaseDate}`);

  const originalBlock = existing.originalSynopsis
    ? `\nOriginal synopsis (may be in English, Russian, or Japanese — REWRITE it into Indonesian):\n"""\n${existing.originalSynopsis.slice(0, 2000)}\n"""\n\n`
    : '';

  const prompt =
    `You are a FACTUAL anime database expert. Return STRICT JSON only.\n` +
    `CRITICAL: If you don't know a fact with HIGH CONFIDENCE, return null for that field. NEVER GUESS or HALLUCINATE.\n\n` +
    `Anime title: ${title}\n\n` +
    (known.length > 0
      ? `Known data (DO NOT change these):\n${known.join('\n')}\n\n`
      : '') +
    originalBlock +
    `Fill in ONLY these missing fields: ${need.join(', ')}\n\n` +
    `Output JSON format:\n` +
    `{\n` +
    `  "studio": "exact animation studio name or null",\n` +
    `  "rating": 7.5,\n` +
    `  "genre": ["Action", "Adventure"],\n` +
    `  "releaseDate": "YYYY-MM-DD",\n` +
    `  "synopsis": "factual Indonesian synopsis, no spoilers"\n` +
    `}\n\n` +
    `STRICT RULES:\n` +
    `- If NOT 100% sure about a field, use null. Hallucination is WORSE than null.\n` +
    `- rating: actual MAL/AniList score (0-10, one decimal)\n` +
    `- studio: full official name with "Studio" prefix if applicable (e.g., "Studio Pierrot", "MAPPA")\n` +
    `- synopsis: Tulis 2-3 paragraf dalam bahasa Indonesia natural (minimal 100 kata). If original synopsis is provided above, REWRITE it into natural Indonesian. JANGAN terjemahan literal.\n` +
    `- Output valid JSON only, no markdown, no explanation`;

  console.log(
    `[Core] AI enrich — need: [${need.join(', ')}], prompt len: ${prompt.length}`
  );

  try {
    const raw = await chatAI(
      env,
      [{ role: 'user', content: prompt }],
      { maxTokens: 1200, temperature: 0.3, smart: true }
    );

    console.log(`[Core] AI raw response len: ${raw?.length ?? 0}`);

    if (!raw || raw.length === 0) {
      console.warn('[Core] AI returned empty — STOP (no retry)');
      return null;
    }

    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== 'object') {
      console.warn('[Core] AI parse failed — STOP (no retry)');
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    const out: Enriched = {};

    if (typeof obj.studio === 'string') out.studio = obj.studio;
    if (typeof obj.rating === 'number') out.rating = obj.rating;
    if (Array.isArray(obj.genre)) {
      out.genre = obj.genre.filter((g): g is string => typeof g === 'string');
    }
    if (typeof obj.releaseDate === 'string') out.releaseDate = obj.releaseDate;
    if (typeof obj.synopsis === 'string') out.synopsis = obj.synopsis;

    return out;
  } catch (err) {
    console.error('[Core] AI enrich failed — STOP (no retry):', err);
    return null;
  }
}

export async function enrichWithAITimeout(
  env: Env,
  title: string,
  existing: ExistingData,
  need: string[]
): Promise<Enriched | null> {
  if (need.length === 0) return null;

  console.log('[Core] AI enrich starting (single attempt)...');

  return Promise.race([
    enrichWithAI(env, title, existing, need),
    new Promise<Enriched | null>((resolve) => {
      setTimeout(() => {
        console.warn(`[Core] AI timeout after ${AI_TIMEOUT_MS}ms — STOP`);
        resolve(null);
      }, AI_TIMEOUT_MS);
    }),
  ]);
}

export function buildQimochiHubResult(
  media: AniListMedia,
  enriched: Enriched | null
): BuildResult {
  const missing: string[] = [];
  const aiUsed: string[] = [];

  const title = pickTitle(media);
  if (!title || title === 'Unknown') missing.push('title');

  let cover = media.coverImage.extraLarge || media.coverImage.large || '';
  if (!cover || !isValidHttpUrl(cover)) {
    cover = 'https://placehold.co/400x600?text=No+Cover';
    missing.push('cover');
  }

  let status: string = 'Ongoing';
  const mappedStatus = QH_STATUS_MAP[media.status];
  if (mappedStatus) status = mappedStatus;
  else missing.push('status');

  let type: string = 'TV';
  const mappedType = QH_FORMAT_MAP[media.format];
  if (mappedType) type = mappedType;
  else missing.push('type');

  let genres = (media.genres ?? []).filter((g) => g && g.trim());
  if (genres.length === 0 && enriched?.genre?.length) {
    genres = enriched.genre;
    aiUsed.push('genre');
  }
  if (genres.length === 0) {
    genres = ['Unknown'];
    missing.push('genre');
  }
  const genreYaml = `[${genres.map((g) => yamlString(g)).join(', ')}]`;

  let studio = media.studios?.nodes?.[0]?.name ?? '';
  if (!studio || studio === 'Unknown') {
    if (enriched?.studio) {
      studio = normalizeStudioName(enriched.studio);
      aiUsed.push('studio');
    } else {
      studio = 'Unknown';
      missing.push('studio');
    }
  }

  const y = media.startDate?.year ?? media.seasonYear;
  const mo = media.startDate?.month;
  const d = media.startDate?.day;
  let releaseDate: string;

  if (y && mo && d) {
    releaseDate = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  } else if (
    enriched?.releaseDate &&
    /^\d{4}-\d{2}-\d{2}$/.test(enriched.releaseDate)
  ) {
    releaseDate = enriched.releaseDate;
    aiUsed.push('releaseDate');
  } else if (y) {
    releaseDate = `${y}-01-01`;
    missing.push('releaseDate (default 01-01)');
  } else {
    releaseDate = new Date().toISOString().split('T')[0] ?? '2020-01-01';
    missing.push('releaseDate');
  }

  const addedAt = new Date().toISOString().split('T')[0] ?? '2026-01-01';

  let rating: string;
  if (typeof media.averageScore === 'number' && media.averageScore > 0) {
    rating = (media.averageScore / 10).toFixed(1);
  } else if (typeof enriched?.rating === 'number' && enriched.rating > 0) {
    rating = enriched.rating.toFixed(1);
    aiUsed.push('rating');
  } else {
    rating = '0.0';
    missing.push('rating');
  }

  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: ${yamlString(title)}`);
  lines.push(`cover: ${cover}`);
  lines.push(`status: ${status}`);
  lines.push(`type: ${type}`);
  lines.push(`genre: ${genreYaml}`);
  lines.push(`studio: ${yamlString(studio)}`);
  lines.push(`releaseDate: ${releaseDate}`);
  lines.push(`addedAt: ${addedAt}`);
  lines.push(`rating: ${rating}`);
  lines.push('---');
  const yaml = lines.join('\n');

  let synopsisRaw = media.description ?? null;
  if (synopsisRaw) synopsisRaw = stripHtml(synopsisRaw);

  let synopsis = synopsisRaw;
  const isTooShort = !synopsis || synopsis.length < 50;
  const isCyrillic = synopsis ? hasCyrillic(synopsis) : false;
  const isIndonesian = synopsis ? looksIndonesian(synopsis) : false;

  if (
    (isTooShort || isCyrillic || !isIndonesian) &&
    enriched?.synopsis &&
    enriched.synopsis.length > 50
  ) {
    synopsis = enriched.synopsis;
    aiUsed.push('synopsis');
  }

  if (!synopsis || synopsis.length < 30) {
    synopsis =
      '> ⚠️ Sinopsis belum tersedia. Silakan isi manual.\n\n' +
      `${title} adalah anime yang...`;
    missing.push('synopsis (body)');
  }

  return { yaml, body: synopsis, missing, aiUsed };
}
