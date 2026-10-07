// src/commands/publish/builders.ts
import type { Env } from '../../types/env';
import type { AniListMedia } from '../../types/anime';
import type { FileToCommit } from '../../lib/github';
import { stripHtml, chunkArray, looksIndonesian } from '../../lib/utils';
import { getCharCache, CHAR_PART_SIZE } from '../../lib/dba-characters';
import { getEpCache } from '../../lib/dba-episodes';
import {
  getAllVoiceActors,
  type VoiceActorRow,
} from '../../lib/dba-voice-actors';
import type { UnifiedCharacter } from '../../services/qimochi-chain-extras';
import { buildMetadataYaml } from '../../services/qimochi-yaml';
import { chainRelations } from '../../services/qimochi-chain-extras';
import { askAI } from '../../services/ai';
import { safeFetch } from '../../lib/dba-common';
import { filterFranchises } from '../../lib/franchises';
import type { SessionRow as DbaSessionRow } from '../../lib/dba-session';
import {
  AI_REWRITE_TIMEOUT_MS,
  EP_PART_SIZE,
  RELATION_FETCH_TIMEOUT_MS,
} from './types';

function hasText(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isHttpUrl(v: unknown): v is string {
  if (!hasText(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

interface CleanCharacter {
  name: string;
  role: 'main' | 'supporting' | 'background';
  voiceActors: string[];
  nameNative?: string;
  image?: string;
}

function sanitizeCharacter(c: UnifiedCharacter): CleanCharacter {
  const out: CleanCharacter = {
    name: hasText(c.name) ? c.name.trim() : 'Unknown',
    role:
      c.role === 'main' || c.role === 'supporting' || c.role === 'background'
        ? c.role
        : 'background',
    voiceActors: Array.isArray(c.voiceActors)
      ? c.voiceActors.filter(hasText)
      : [],
  };

  if (hasText(c.nameNative)) out.nameNative = c.nameNative.trim();
  if (isHttpUrl(c.image)) out.image = c.image.trim();

  return out;
}

interface CleanActor {
  id: string;
  name: string;
  nameNative?: string;
  image?: string;
  defaultLanguage?: string;
}

function sanitizeActor(va: VoiceActorRow): CleanActor {
  const out: CleanActor = {
    id: hasText(va.id) ? va.id.trim().toLowerCase() : 'unknown',
    name: hasText(va.name) ? va.name.trim() : 'Unknown',
  };

  if (hasText(va.nameNative)) out.nameNative = va.nameNative.trim();
  if (isHttpUrl(va.image)) out.image = va.image.trim();
  if (hasText(va.defaultLanguage)) {
    out.defaultLanguage = va.defaultLanguage.trim();
  }

  return out;
}

async function rewriteSynopsisToId(
  env: Env,
  title: string,
  originalSynopsis: string
): Promise<string | null> {
  if (!originalSynopsis || originalSynopsis.length < 30) return null;

  const prompt =
    `Tulis ulang sinopsis anime berikut menjadi bahasa Indonesia yang natural.\n\n` +
    `Judul: ${title}\n\n` +
    `Sinopsis referensi:\n${originalSynopsis.slice(0, 2000)}\n\n` +
    `ATURAN:\n` +
    `- Tulis sebagai sinopsis baru, BUKAN terjemahan literal\n` +
    `- Bahasa Indonesia natural dan mengalir\n` +
    `- 2-3 paragraf pendek\n` +
    `- Jangan spoiler\n` +
    `- Jangan tambahkan info yang tidak ada di referensi\n` +
    `- Langsung mulai dari tokoh utama atau setting\n\n` +
    `Output hanya sinopsis, tanpa penjelasan tambahan.`;

  const { data } = await safeFetch(
    () =>
      askAI(env, prompt, {
        maxTokens: 700,
        temperature: 0.6,
        smart: true,
      }),
    AI_REWRITE_TIMEOUT_MS
  );

  if (data && data.length > 50) return data.trim();
  return null;
}

export async function buildMetadataFile(
  env: Env,
  session: DbaSessionRow,
  slug: string
): Promise<FileToCommit | null> {
  if (!session.metadata) return null;

  let media: AniListMedia;
  try {
    media = JSON.parse(session.metadata) as AniListMedia;
  } catch {
    return null;
  }

  const yaml = buildMetadataYaml({
    media,
    malId: session.mal_id ?? null,
    kitsuId: session.kitsu_id ?? null,
  });

  let body: string;

  if (session.summary && session.summary.trim().length > 50) {
    body = session.summary.trim();
  } else {
    const raw = media.description ?? '';
    if (raw.length < 30) {
      body = '> ⚠️ Sinopsis belum tersedia. Silakan isi manual.';
    } else {
      const clean = stripHtml(raw);
      if (looksIndonesian(clean)) {
        body = clean;
      } else {
        const aiBody = await rewriteSynopsisToId(env, session.title, clean);
        body = aiBody ?? clean;
      }
    }
  }

  return {
    path: `src/content/anime/${slug}.md`,
    content: `${yaml}\n\n${body}\n`,
    target: 'yukionime',
  };
}

export async function buildCharacterFiles(
  env: Env,
  sessionId: string,
  slug: string
): Promise<FileToCommit[]> {
  const cache = await getCharCache(env.DB, sessionId);
  if (!cache || cache.chars.length === 0) return [];

  const sanitized = cache.chars.map(sanitizeCharacter);
  const chunks = chunkArray(sanitized, CHAR_PART_SIZE);
  const files: FileToCommit[] = [];

  let cursor = 1;
  for (const chunk of chunks) {
    const start = cursor;
    const end = cursor + chunk.length - 1;
    files.push({
      path: `data/anime/${slug}/characters/${start}-${end}.json`,
      content: JSON.stringify(chunk, null, 2) + '\n',
      target: 'yukio-data',
      itemCount: chunk.length,
    });
    cursor = end + 1;
  }

  return files;
}

export async function buildEpisodeFiles(
  env: Env,
  sessionId: string,
  slug: string
): Promise<FileToCommit[]> {
  const cache = await getEpCache(env.DB, sessionId);
  if (!cache || cache.episodes.length === 0) return [];

  const sorted = [...cache.episodes].sort((a, b) => a.number - b.number);
  const chunks = chunkArray(sorted, EP_PART_SIZE);
  const files: FileToCommit[] = [];

  for (const chunk of chunks) {
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    if (!first || !last) continue;

    files.push({
      path: `data/anime/${slug}/episodes/${first.number}-${last.number}.json`,
      content: JSON.stringify(chunk, null, 2) + '\n',
      target: 'yukio-data',
      itemCount: chunk.length,
    });
  }

  return files;
}

export async function buildFranchiseFiles(
  session: DbaSessionRow,
  slug: string
): Promise<FileToCommit[]> {
  if (!session.mal_id) return [];

  const { data: result } = await safeFetch(
    () =>
      chainRelations({
        malId: session.mal_id,
        kitsuId: session.kitsu_id,
        title: session.title,
      }),
    RELATION_FETCH_TIMEOUT_MS
  );

  if (!result || !result.data || result.data.length === 0) return [];

  const filtered = filterFranchises(result.data);
  if (filtered.length === 0) return [];

  const json = JSON.stringify(filtered, null, 2) + '\n';
  const itemCount = filtered.length;

  return [
    {
      path: `data/anime/${slug}/franchises.json`,
      content: json,
      target: 'yukio-data',
      itemCount,
    },
    {
      path: `src/data/anime/${slug}/franchises.json`,
      content: json,
      target: 'qimochi',
      itemCount,
    },
  ];
}

export async function buildActorFiles(env: Env): Promise<FileToCommit[]> {
  const vas = await getAllVoiceActors(env.DB);
  if (vas.length === 0) return [];

  const sanitized: CleanActor[] = vas.map(sanitizeActor);

  const groups = new Map<string, CleanActor[]>();
  for (const va of sanitized) {
    const first = (va.id.charAt(0) || '').toLowerCase();
    const letter = /^[a-z]$/.test(first) ? first : '_';
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter)!.push(va);
  }

  const files: FileToCommit[] = [];
  for (const [letter, items] of groups) {
    items.sort((a, b) => a.id.localeCompare(b.id));
    files.push({
      path: `data/actors/${letter}.json`,
      content: JSON.stringify(items, null, 2) + '\n',
      target: 'yukio-data',
      itemCount: items.length,
    });
  }
  return files;
}
