// src/services/qimochi-chain-extras.ts
import { fetchWithRetry } from '../lib/http';

/* ============================================================
   UNIFIED TYPES
   ============================================================ */

export interface UnifiedCharacter {
  name: string;
  image?: string;
  role: 'main' | 'supporting' | 'background';
  voiceActors: {
    name: string;
    image?: string;
    language?: string;
  }[];
}

export interface UnifiedEpisode {
  number: number;
  title: string;
  aired?: string;
  duration?: number;
}

export interface UnifiedRelation {
  relation: string;
  slug: string;
  title: string;
}

export interface ChainContext {
  malId: number | null;
  kitsuId: string | null;
  title: string;
}

export interface ChainResult<T> {
  data: T[] | null;
  source: string;
  errors: string[];
}

const PER_SOURCE_TIMEOUT = 8000;
const MAX_ITEMS = 30;

/* Episodes config */
const MAX_EPISODES = 200;
const KITSU_PAGE_LIMIT = 20;
const EPISODES_TIME_BUDGET_MS = 10000;

/* ============================================================
   UTILITIES
   ============================================================ */

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number
): Promise<T | null> {
  try {
    return await Promise.race([
      fn(),
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

/* ============================================================
   KITSU — CHARACTERS
   ============================================================ */

interface KitsuIncluded {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    canonicalName?: string;
    image?: { original?: string; large?: string } | null;
  };
}

interface KitsuRoleEntry {
  id: string;
  type: string;
  attributes?: { role?: string };
  relationships?: {
    character?: { data?: { id: string; type: string } | null };
  };
}

async function getKitsuCharacters(
  kitsuId: string
): Promise<UnifiedCharacter[] | null> {
  const params = new URLSearchParams();
  params.set('include', 'character');
  params.set('page[limit]', '20');

  const url = `https://kitsu.io/api/edge/anime/${kitsuId}/characters?${params.toString()}`;

  console.log(`[Kitsu] characters URL: ${url}`);

  const res = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        'User-Agent': 'yukio-bot/1.0',
      },
    },
    { retries: 0, timeout: PER_SOURCE_TIMEOUT }
  );

  if (!res.ok) return null;

  const json = (await res.json()) as {
    data?: KitsuRoleEntry[];
    included?: KitsuIncluded[];
  };

  const data = json.data ?? [];
  const included = json.included ?? [];

  const indexed = new Map<string, KitsuIncluded>();
  for (const item of included) {
    indexed.set(`${item.type}:${item.id}`, item);
  }

  const out: UnifiedCharacter[] = [];
  const seen = new Set<string>();

  for (const role of data) {
    const charRef = role.relationships?.character?.data;
    if (!charRef) continue;

    const charItem = indexed.get(`characters:${charRef.id}`);
    if (!charItem) continue;

    const charName =
      charItem.attributes?.canonicalName ?? charItem.attributes?.name;
    if (!charName || seen.has(charName)) continue;
    seen.add(charName);

    const roleRaw = (role.attributes?.role ?? 'supporting').toLowerCase();
    const roleNorm: UnifiedCharacter['role'] =
      roleRaw === 'main'
        ? 'main'
        : roleRaw === 'supporting'
          ? 'supporting'
          : 'background';

    out.push({
      name: charName,
      image: charItem.attributes?.image?.original ?? undefined,
      role: roleNorm,
      voiceActors: [],
    });

    if (out.length >= MAX_ITEMS) break;
  }

  return out.length > 0 ? out : null;
}

/* ============================================================
   KITSU — EPISODES (pagination + time budget)
   ============================================================ */

interface KitsuEpisodeItem {
  id: string;
  attributes?: {
    number?: number;
    canonicalTitle?: string;
    titles?: { en?: string; en_jp?: string; ja_jp?: string };
    airdate?: string | null;
    length?: number | null;
  };
}

type FetchPageResult =
  | { ok: true; data: KitsuEpisodeItem[] }
  | { ok: false; reason: 'error' | 'rate_limit' };

async function getKitsuEpisodesPage(
  kitsuId: string,
  offset: number
): Promise<FetchPageResult> {
  const params = new URLSearchParams();
  params.set('page[limit]', String(KITSU_PAGE_LIMIT));
  params.set('page[offset]', String(offset));
  params.set('sort', 'number');

  const url = `https://kitsu.io/api/edge/anime/${kitsuId}/episodes?${params.toString()}`;

  console.log(`[Kitsu] episodes URL: ${url}`);

  const res = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        'User-Agent': 'yukio-bot/1.0',
      },
    },
    { retries: 0, timeout: PER_SOURCE_TIMEOUT }
  );

  if (res.status === 429) {
    console.warn('[Kitsu] episodes rate limited (429)');
    return { ok: false, reason: 'rate_limit' };
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.warn(
      `[Kitsu] episodes HTTP ${res.status}: ${errBody.slice(0, 150)}`
    );
    return { ok: false, reason: 'error' };
  }

  const json = (await res.json()) as { data?: KitsuEpisodeItem[] };
  return { ok: true, data: json.data ?? [] };
}

async function getKitsuEpisodes(
  kitsuId: string
): Promise<{ episodes: UnifiedEpisode[]; truncated: boolean } | null> {
  const startTime = Date.now();
  const allEpisodes: KitsuEpisodeItem[] = [];
  let truncated = false;

  const maxPages = Math.ceil(MAX_EPISODES / KITSU_PAGE_LIMIT);

  for (let page = 0; page < maxPages; page++) {
    const elapsed = Date.now() - startTime;
    if (elapsed > EPISODES_TIME_BUDGET_MS) {
      console.warn(
        `[Kitsu] episodes time budget exceeded (${elapsed}ms) — truncated`
      );
      truncated = true;
      break;
    }

    const offset = page * KITSU_PAGE_LIMIT;
    const result = await getKitsuEpisodesPage(kitsuId, offset);

    if (!result.ok) {
      if (allEpisodes.length > 0) truncated = true;
      break;
    }

    if (result.data.length === 0) break;

    allEpisodes.push(...result.data);

    if (allEpisodes.length >= MAX_EPISODES) {
      truncated = true;
      break;
    }

    if (result.data.length < KITSU_PAGE_LIMIT) break;
  }

  if (allEpisodes.length === 0) return null;

  const out: UnifiedEpisode[] = [];
  const seen = new Set<number>();

  for (const ep of allEpisodes) {
    const attr = ep.attributes ?? {};
    const number = attr.number ?? out.length + 1;
    if (seen.has(number)) continue;
    seen.add(number);

    const title =
      attr.titles?.en ??
      attr.titles?.en_jp ??
      attr.canonicalTitle ??
      `Episode ${number}`;
    const aired = attr.airdate ? attr.airdate.split('T')[0] : undefined;
    const duration =
      attr.length && attr.length > 0
        ? Math.round(attr.length / 60)
        : undefined;

    out.push({ number, title, aired, duration });
    if (out.length >= MAX_EPISODES) break;
  }

  out.sort((a, b) => a.number - b.number);

  console.log(
    `[Kitsu] episodes fetched: ${out.length} in ${Date.now() - startTime}ms (truncated: ${truncated})`
  );

  return { episodes: out, truncated };
}

/* ============================================================
   SHIKIMORI — CHARACTERS
   ============================================================ */

interface ShikimoriRoleEntry {
  roles?: string[];
  roles_russian?: string[];
  character?: {
    id: number;
    name: string;
    russian?: string;
    image?: {
      original?: string;
      preview?: string;
    } | null;
  } | null;
  person?: {
    id: number;
    name: string;
    russian?: string;
    image?: {
      original?: string;
      preview?: string;
    } | null;
  } | null;
}

function shikimoriImage(
  img?: { original?: string; preview?: string } | null
): string | undefined {
  if (!img) return undefined;
  const raw = img.original ?? img.preview;
  if (!raw) return undefined;
  if (raw.startsWith('http')) return raw;
  return `https://shikimori.one${raw}`;
}

async function getShikimoriCharacters(
  malId: number
): Promise<UnifiedCharacter[] | null> {
  const url = `https://shikimori.one/api/animes/${malId}/roles`;

  const res = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'yukio-bot/1.0',
      },
    },
    { retries: 0, timeout: PER_SOURCE_TIMEOUT }
  );

  if (!res.ok) return null;

  const data = (await res.json()) as ShikimoriRoleEntry[];
  if (!Array.isArray(data) || data.length === 0) return null;

  const out: UnifiedCharacter[] = [];
  const seen = new Set<string>();

  for (const entry of data) {
    if (!entry.character) continue;

    const name = entry.character.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const roles = entry.roles ?? [];
    const isMain = roles.some((r) => r.toLowerCase() === 'main');
    const isSupporting = roles.some((r) => r.toLowerCase() === 'supporting');
    const roleNorm: UnifiedCharacter['role'] = isMain
      ? 'main'
      : isSupporting
        ? 'supporting'
        : 'background';

    out.push({
      name,
      image: shikimoriImage(entry.character.image),
      role: roleNorm,
      voiceActors: [],
    });

    if (out.length >= MAX_ITEMS) break;
  }

  return out.length > 0 ? out : null;
}

/* ============================================================
   CHAIN RESOLVERS — CHARACTERS
   ============================================================ */

export async function chainCharacters(
  ctx: ChainContext
): Promise<ChainResult<UnifiedCharacter>> {
  const errors: string[] = [];

  if (ctx.malId) {
    const shiki = await withTimeout(
      () => getShikimoriCharacters(ctx.malId!),
      PER_SOURCE_TIMEOUT
    );
    if (shiki && shiki.length > 0) {
      return { data: shiki, source: 'Shikimori', errors };
    }
    errors.push('Shikimori: gagal atau kosong');
  } else {
    errors.push('Shikimori: tidak ada MAL ID');
  }

  if (ctx.kitsuId) {
    const kitsu = await withTimeout(
      () => getKitsuCharacters(ctx.kitsuId!),
      PER_SOURCE_TIMEOUT
    );
    if (kitsu && kitsu.length > 0) {
      return { data: kitsu, source: 'Kitsu', errors };
    }
    errors.push('Kitsu: gagal atau kosong');
  } else {
    errors.push('Kitsu: tidak ada Kitsu ID');
  }

  return { data: null, source: 'none', errors };
}

/* ============================================================
   CHAIN RESOLVERS — EPISODES
   ============================================================ */

export interface EpisodesChainResult extends ChainResult<UnifiedEpisode> {
  truncated?: boolean;
}

export async function chainEpisodes(
  ctx: ChainContext
): Promise<EpisodesChainResult> {
  const errors: string[] = [];

  if (ctx.kitsuId) {
    const result = await getKitsuEpisodes(ctx.kitsuId);

    if (result && result.episodes.length > 0) {
      return {
        data: result.episodes,
        source: 'Kitsu',
        errors,
        truncated: result.truncated,
      };
    }
    errors.push('Kitsu: gagal atau kosong');
  } else {
    errors.push('Kitsu: tidak ada Kitsu ID');
  }

  return { data: null, source: 'none', errors };
}

/* ============================================================
   CHAIN RESOLVERS — RELATIONS
   ============================================================ */

export async function chainRelations(
  _ctx: ChainContext
): Promise<ChainResult<UnifiedRelation>> {
  return {
    data: null,
    source: 'none',
    errors: ['Relations: belum diimplementasi (menunggu test endpoint)'],
  };
}