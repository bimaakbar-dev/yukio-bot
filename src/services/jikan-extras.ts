// src/services/jikan-extras.ts
import { fetchWithRetry } from '../lib/http';

const JIKAN_BASE = 'https://api.jikan.moe/v4';
const FETCH_TIMEOUT = 8000;
const MAX_EPISODES = 100;

export interface JikanCharacterEntry {
  character: {
    mal_id: number;
    name: string;
    images: {
      jpg: { image_url: string };
      webp?: { image_url: string };
    };
  };
  role: string;
  voice_actors: {
    person: {
      mal_id: number;
      name: string;
      images: { jpg: { image_url: string } };
    };
    language: string;
  }[];
}

export interface JikanEpisodeEntry {
  mal_id: number;
  title: string;
  aired: string | null;
  filler: boolean;
  recap: boolean;
  duration: number | null;
}

export interface JikanRelationEntry {
  relation: string;
  entry: {
    mal_id: number;
    type: string;
    name: string;
    url: string;
  }[];
}

async function jikanGet<T>(path: string): Promise<T> {
  const url = `${JIKAN_BASE}${path}`;

  const res = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'yukio-bot/1.0',
      },
    },
    { retries: 1, baseDelay: 600, timeout: FETCH_TIMEOUT }
  );

  if (!res.ok) {
    throw new Error(`Jikan HTTP ${res.status}: ${path}`);
  }

  return (await res.json()) as T;
}

export async function getCharacters(
  malId: number
): Promise<JikanCharacterEntry[]> {
  const json = await jikanGet<{ data: JikanCharacterEntry[] }>(
    `/anime/${malId}/characters`
  );
  return json.data ?? [];
}

export async function getEpisodesPage(
  malId: number,
  page = 1
): Promise<{
  episodes: JikanEpisodeEntry[];
  hasNextPage: boolean;
}> {
  const json = await jikanGet<{
    data: JikanEpisodeEntry[];
    pagination: { has_next_page: boolean; last_visible_page: number };
  }>(`/anime/${malId}/episodes?page=${page}`);

  return {
    episodes: json.data ?? [],
    hasNextPage: json.pagination?.has_next_page ?? false,
  };
}

export async function getAllEpisodes(
  malId: number,
  maxTotal = MAX_EPISODES
): Promise<JikanEpisodeEntry[]> {
  const all: JikanEpisodeEntry[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext && all.length < maxTotal && page <= 20) {
    const result = await getEpisodesPage(malId, page);
    all.push(...result.episodes);
    hasNext = result.hasNextPage;
    page++;
  }

  return all.slice(0, maxTotal);
}

export async function getRelations(
  malId: number
): Promise<JikanRelationEntry[]> {
  const json = await jikanGet<{ data: JikanRelationEntry[] }>(
    `/anime/${malId}/relations`
  );
  return json.data ?? [];
}
