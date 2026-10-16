import type { Env } from '../../types/env';
import type { AniListMedia } from '../../types/anime';
import type { SessionRow } from '../../lib/dba-session';
import type { FileToCommit } from '../../lib/github';
import { githubCommitMultipleFiles } from '../../lib/github';
import { getCharCache } from '../../lib/dba-characters';
import { getEpCache } from '../../lib/dba-episodes';
import {
  chainRelations,
  type UnifiedCharacter,
  type UnifiedRelation,
  type UnifiedVoiceActor,
} from '../../services/qimochi-chain-extras';
import { buildMetadataYaml } from '../../services/qimochi-yaml';
import { filterFranchises } from '../../lib/franchises';
import { chunkArray, slugify, stripHtml, looksIndonesian } from '../../lib/utils';
import { askAI } from '../../services/ai';
import { safeFetch } from '../../lib/dba-common';
import {
  chunkRange,
  chunkPath,
  readEpisodeChunk,
  serializeChunk,
  type EpisodeChunkItem,
} from '../../lib/episode-chunks';
import {
  getSelectedSections,
  type PublishSection,
} from '../../lib/publish-selection';

const CHAR_PART_SIZE = 50;

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
  selected: PublishSection[];
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

async function buildEpisodeFiles(
  env: Env,
  slug: string,
  cachedEpisodes: { number: number; title?: string; aired?: string; duration?: number }[]
): Promise<{ files: FileToCommit[]; count: number }> {
  const files: FileToCommit[] = [];
  let count = 0;

  if (cachedEpisodes.length === 0) return { files, count };

  const byChunk = new Map<string, { start: number; end: number; items: EpisodeChunkItem[] }>();
  for (const ep of cachedEpisodes) {
    if (typeof ep.number !== 'number') continue;
    const { start, end } = chunkRange(ep.number);
    const key = `${start}-${end}`;
    if (!byChunk.has(key)) byChunk.set(key, { start, end, items: [] });

    const item: EpisodeChunkItem = { number: ep.number };
    if (ep.title) item.title = ep.title;
    if (ep.aired) item.aired = ep.aired;
    if (typeof ep.duration === 'number') item.duration = ep.duration;

    byChunk.get(key)!.items.push(item);
  }

  for (const { start, end, items } of byChunk.values()) {
    const existing = await readEpisodeChunk(env, slug, start, end);
    const merged = new Map<number, EpisodeChunkItem>();
    for (const e of existing) merged.set(e.number, e);

    for (const incoming of items) {
      const prev = merged.get(incoming.number) ?? { number: incoming.number };
      merged.set(incoming.number, {
        number: incoming.number,
        title: incoming.title ?? prev.title,
        aired: incoming.aired ?? prev.aired,
        duration: incoming.duration ?? prev.duration,
        streams: prev.streams,
        downloads: prev.downloads,
      });
    }

    const sorted = [...merged.values()].sort((a, b) => a.number - b.number);
    files.push({
      path: chunkPath(slug, start, end),
      content: serializeChunk(sorted),
      itemCount: sorted.length,
    });
    count += items.length;
  }

  return { files, count };
}

export async function buildFiles(
  env: Env,
  session: SessionRow
): Promise<BuildFilesResult> {
  const slug = resolveSlug(session);
  const files: FileToCommit[] = [];
  const selected = await getSelectedSections(env, session.session_id);

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

  // Metadata selalu di-commit
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

  /* Characters — hanya kalau user klik 👥 Characters */
  if (selected.includes('characters')) {
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
  }

  /* Episodes — hanya kalau user klik 🎬 Episodes */
  if (selected.includes('episodes')) {
    const epCache = await getEpCache(env.DB, session.session_id);
    if (epCache && epCache.episodes.length > 0) {
      const { files: epFiles, count } = await buildEpisodeFiles(
        env,
        slug,
        epCache.episodes
      );
      files.push(...epFiles);
      counts.episodes += count;
    }
  }

  /* Franchises — hanya kalau user klik 🔗 Franchises */
  if (selected.includes('franchises') && session.mal_id) {
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

  /* Actors — di-skip dari publish. Tidak ada section untuk ini.
   * Kalau butuh update actor files, jalankan command terpisah.
   */

  return { files, slug, body, counts, selected };
}

export interface PublishResult {
  ok: boolean;
  sha?: string;
  commitUrl?: string;
  error?: string;
  slug: string;
  filesCount: number;
  counts: BuildFilesResult['counts'];
  selected: PublishSection[];
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
      selected: [],
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
    selected: built.selected,
  };
}

export type { UnifiedRelation, UnifiedVoiceActor };
