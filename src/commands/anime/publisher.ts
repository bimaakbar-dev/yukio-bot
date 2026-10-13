import type { Env } from '../../types/env';
import type { AniListMedia } from '../../types/anime';
import type { SessionRow } from '../../lib/dba-session';
import type { FileToCommit } from '../../lib/github';
import { githubCommitMultipleFiles } from '../../lib/github';
import { getCharCache } from '../../lib/dba-characters';
import { getEpCache } from '../../lib/dba-episodes';
import { getAllVoiceActors } from '../../lib/dba-voice-actors';
import {
  chainRelations,
  type UnifiedCharacter,
  type UnifiedVoiceActor,
  type UnifiedRelation,
} from '../../services/qimochi-chain-extras';
import { buildMetadataYaml } from '../../services/qimochi-yaml';
import { filterFranchises } from '../../lib/franchises';
import { chunkArray, slugify, stripHtml, looksIndonesian } from '../../lib/utils';
import { askAI } from '../../services/ai';
import { safeFetch } from '../../lib/dba-common';

const CHAR_PART_SIZE = 50;
const EP_PART_SIZE = 12;
const MAX_ACTORS_PER_FILE = 500;

interface BuildFilesResult {
  files: FileToCommit[];
  slug: string;
  body: string;
  counts: {
    metadata: boolean;
    characters: number;
    episodes: number;
    franchises: number;
    actors: number;
  };
}

function resolveSlug(session: SessionRow): string {
  return slugify(session.title);
}

function sanitizeCharacter(c: UnifiedCharacter): {
  name: string;
  role: string;
  voiceActors: string[];
  nameNative?: string;
  image?: string;
} {
  const out: {
    name: string;
    role: string;
    voiceActors: string[];
    nameNative?: string;
    image?: string;
  } = {
    name: c.name?.trim() || 'Unknown',
    role:
      c.role === 'main' || c.role === 'supporting' || c.role === 'background'
        ? c.role
        : 'background',
    voiceActors: Array.isArray(c.voiceActors) ? c.voiceActors.filter(Boolean) : [],
  };
  if (c.nameNative) out.nameNative = c.nameNative.trim();
  if (c.image && /^https?:\/\//.test(c.image)) out.image = c.image.trim();
  return out;
}

function sanitizeActor(va: {
  id: string;
  name: string;
  nameNative: string | null;
  image: string | null;
  defaultLanguage: string | null;
}): {
  id: string;
  name: string;
  nameNative?: string;
  image?: string;
  defaultLanguage?: string;
} {
  const out: {
    id: string;
    name: string;
    nameNative?: string;
    image?: string;
    defaultLanguage?: string;
  } = {
    id: va.id.trim().toLowerCase() || 'unknown',
    name: va.name.trim() || 'Unknown',
  };
  if (va.nameNative) out.nameNative = va.nameNative.trim();
  if (va.image && /^https?:\/\//.test(va.image)) out.image = va.image.trim();
  if (va.defaultLanguage) out.defaultLanguage = va.defaultLanguage.trim();
  return out;
}

async function rewriteSynopsis(
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
    () => askAI(env, prompt, { maxTokens: 700, temperature: 0.6, smart: true }),
    12000
  );

  if (data && data.length > 50) return data.trim();
  return null;
}

async function resolveBody(
  env: Env,
  session: SessionRow,
  media: AniListMedia
): Promise<string> {
  if (session.summary && session.summary.trim().length > 50) {
    return session.summary.trim();
  }

  const raw = media.description ?? '';
  if (raw.length < 30) {
    return '> ⚠️ Sinopsis belum tersedia. Silakan isi manual.';
  }

  const clean = stripHtml(raw);
  if (looksIndonesian(clean)) return clean;

  const aiBody = await rewriteSynopsis(env, session.title, clean);
  return aiBody ?? clean;
}

export async function buildFiles(
  env: Env,
  session: SessionRow
): Promise<BuildFilesResult> {
  const slug = resolveSlug(session);
  const files: FileToCommit[] = [];

  let media: AniListMedia | null = null;
  if (session.metadata) {
    try {
      media = JSON.parse(session.metadata) as AniListMedia;
    } catch {}
  }
  if (!media) throw new Error('Session tidak punya metadata');

  const body = await resolveBody(env, session, media);
  const yaml = buildMetadataYaml({
    media,
    malId: session.mal_id ?? null,
    kitsuId: session.kitsu_id ?? null,
  });

  files.push({
    path: `src/content/anime/${slug}.md`,
    content: `${yaml}\n\n${body}\n`,
    itemCount: 1,
  });

  const counts = {
    metadata: true,
    characters: 0,
    episodes: 0,
    franchises: 0,
    actors: 0,
  };

  /* Characters */
  const charCache = await getCharCache(env.DB, session.session_id);
  if (charCache && charCache.chars.length > 0) {
    const sanitized = charCache.chars.map(sanitizeCharacter);
    const chunks = chunkArray(sanitized, CHAR_PART_SIZE);
    let cursor = 1;
    for (const chunk of chunks) {
      const start = cursor;
      const end = cursor + chunk.length - 1;
      files.push({
        path: `data/anime/${slug}/characters/${start}-${end}.json`,
        content: JSON.stringify(chunk, null, 2) + '\n',
        itemCount: chunk.length,
      });
      cursor = end + 1;
      counts.characters += chunk.length;
    }
  }

  /* Episodes */
  const epCache = await getEpCache(env.DB, session.session_id);
  if (epCache && epCache.episodes.length > 0) {
    const sorted = [...epCache.episodes].sort((a, b) => a.number - b.number);
    const chunks = chunkArray(sorted, EP_PART_SIZE);
    for (const chunk of chunks) {
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      if (!first || !last) continue;
      files.push({
        path: `data/anime/${slug}/episodes/${first.number}-${last.number}.json`,
        content: JSON.stringify(chunk, null, 2) + '\n',
        itemCount: chunk.length,
      });
      counts.episodes += chunk.length;
    }
  }

  /* Franchises */
  if (session.mal_id) {
    const { data: result } = await safeFetch(
      () =>
        chainRelations({
          malId: session.mal_id!,
          kitsuId: session.kitsu_id,
          title: session.title,
        }),
      8000
    );
    if (result && result.data && result.data.length > 0) {
      const filtered = filterFranchises(result.data);
      if (filtered.length > 0) {
        files.push({
          path: `data/anime/${slug}/franchises.json`,
          content: JSON.stringify(filtered, null, 2) + '\n',
          itemCount: filtered.length,
        });
        counts.franchises = filtered.length;
      }
    }
  }

  /* Actors */
  const vas = await getAllVoiceActors(env.DB);
  if (vas.length > 0) {
    const sanitized = vas.map(sanitizeActor);
    const groups = new Map<string, typeof sanitized>();
    for (const va of sanitized) {
      const first = (va.id.charAt(0) || '').toLowerCase();
      const letter = /^[a-z]$/.test(first) ? first : '_';
      if (!groups.has(letter)) groups.set(letter, []);
      groups.get(letter)!.push(va);
    }
    for (const [letter, items] of groups) {
      items.sort((a, b) => a.id.localeCompare(b.id));
      const chunks = chunkArray(items, MAX_ACTORS_PER_FILE);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        const path =
          chunks.length === 1
            ? `data/actors/${letter}.json`
            : `data/actors/${letter}-${i + 1}.json`;
        files.push({
          path,
          content: JSON.stringify(chunk, null, 2) + '\n',
          itemCount: chunk.length,
        });
        counts.actors += chunk.length;
      }
    }
  }

  return { files, slug, body, counts };
}

export interface PublishResult {
  ok: boolean;
  sha?: string;
  commitUrl?: string;
  error?: string;
  slug: string;
  filesCount: number;
  counts: BuildFilesResult['counts'];
}

export async function publishAnime(
  env: Env,
  session: SessionRow
): Promise<PublishResult> {
  let built: BuildFilesResult;
  try {
    built = await buildFiles(env, session);
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      slug: '',
      filesCount: 0,
      counts: {
        metadata: false,
        characters: 0,
        episodes: 0,
        franchises: 0,
        actors: 0,
      },
    };
  }

  const result = await githubCommitMultipleFiles(
    env,
    built.files,
    `feat: publish ${built.slug}`
  );

  return {
    ok: result.ok,
    sha: result.sha,
    commitUrl: result.commitUrl,
    error: result.error,
    slug: built.slug,
    filesCount: built.files.length,
    counts: built.counts,
  };
}

export type { UnifiedRelation, UnifiedVoiceActor };