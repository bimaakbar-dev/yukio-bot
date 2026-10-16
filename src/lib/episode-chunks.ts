import type { Env } from '../types/env';
import { githubGetFile, githubCommitFile, type CommitResult } from './github';

export const EP_PART_SIZE = 6;

export interface EpisodeStream {
  quality: string;
  servers: { name: string; url: string }[];
}

export interface EpisodeChunkItem {
  number: number;
  title?: string;
  aired?: string;
  duration?: number;
  streams?: EpisodeStream[];
  downloads?: unknown;
}

export function chunkRange(epNumber: number): { start: number; end: number } {
  const start = Math.floor((epNumber - 1) / EP_PART_SIZE) * EP_PART_SIZE + 1;
  return { start, end: start + EP_PART_SIZE - 1 };
}

export function chunkPath(slug: string, start: number, end: number): string {
  return `data/anime/${slug}/episodes/${start}-${end}.json`;
}

export async function readEpisodeChunk(
  env: Env,
  slug: string,
  start: number,
  end: number
): Promise<EpisodeChunkItem[]> {
  try {
    const file = await githubGetFile(env, chunkPath(slug, start, end));
    if (!file) return [];
    const parsed = JSON.parse(file.content);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is EpisodeChunkItem =>
        item && typeof item === 'object' && typeof item.number === 'number'
    );
  } catch (err) {
    console.warn('[EpisodeChunks] read failed:', err);
    return [];
  }
}

export function mergeEpisodeIntoChunk(
  existing: EpisodeChunkItem[],
  incoming: EpisodeChunkItem
): EpisodeChunkItem[] {
  const map = new Map<number, EpisodeChunkItem>();
  for (const item of existing) map.set(item.number, item);

  const prev = map.get(incoming.number) ?? { number: incoming.number };
  map.set(incoming.number, {
    number: incoming.number,
    title: incoming.title ?? prev.title,
    aired: incoming.aired ?? prev.aired,
    duration: incoming.duration ?? prev.duration,
    streams: incoming.streams ?? prev.streams,
    downloads: incoming.downloads ?? prev.downloads,
  });

  return [...map.values()].sort((a, b) => a.number - b.number);
}

export function serializeChunk(items: EpisodeChunkItem[]): string {
  return JSON.stringify(items, null, 2) + '\n';
}

export async function upsertEpisodeToChunk(
  env: Env,
  slug: string,
  incoming: EpisodeChunkItem,
  commitMessage: string
): Promise<CommitResult & { path: string }> {
  const { start, end } = chunkRange(incoming.number);
  const existing = await readEpisodeChunk(env, slug, start, end);
  const merged = mergeEpisodeIntoChunk(existing, incoming);
  const path = chunkPath(slug, start, end);

  const result = await githubCommitFile(
    env,
    path,
    serializeChunk(merged),
    commitMessage
  );

  return { ...result, path };
}
