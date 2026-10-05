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
const MAX_EPISODES = 100;

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
  params.set('page[limit]', '40');

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
   KITSU — EPISODES
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

async function getKitsuEpisodes(
  kitsuId: string
): Promise<UnifiedEpisode[] | null> {
  const params = new URLSearchParams();
  params.set('page[limit]', '100');
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

  if (!res.ok) return null;

  const json = (await res.json()) as { data?: KitsuEpisodeItem[] };
  const data = json.data ?? [];
  if (data.length === 0) return null;

  const out: UnifiedEpisode[] = [];

  for (const ep of data) {
    const attr = ep.attributes ?? {};
    const number = attr.number ?? out.length + 1;
    const title =
      attr.titles?.en ??
      attr.titles?.en_jp ??
      attr.canonicalTitle ??
      `Episode ${number}`;
    const aired = attr.airdate ? attr.airdate.split('T')[0] : undefined;
    const duration =
      attr.length && attr.length > 0 ? Math.round(attr.length / 60) : undefined;

    out.push({ number, title, aired, duration });
    if (out.length >= MAX_EPISODES) break;
  }

  return out;
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
      // Shikimori /roles tidak menyertakan seiyuu (person selalu null
      // untuk entry karakter). VA diisi manual oleh user.
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

  // === 1. SHIKIMORI (butuh malId) ===
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

  // === 2. KITSU (fallback) ===
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

export async function chainEpisodes(
  ctx: ChainContext
): Promise<ChainResult<UnifiedEpisode>> {
  const errors: string[] = [];

  // === KITSU (satu-satunya sumber list episode) ===
  if (ctx.kitsuId) {
    const kitsu = await withTimeout(
      () => getKitsuEpisodes(ctx.kitsuId!),
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
   CHAIN RESOLVERS — RELATIONS
   ============================================================ */

export async function chainRelations(
  _ctx: ChainContext
): Promise<ChainResult<UnifiedRelation>> {
  // TODO: test manual endpoint Shikimori /animes?franchise=X
  // Sementara return kosong biar compile jalan.
  return {
    data: null,
    source: 'none',
    errors: ['Relations: belum diimplementasi (menunggu test endpoint)'],
  };
}