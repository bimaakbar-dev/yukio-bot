// src/services/qimochi-chain-extras.ts
import { fetchWithRetry } from '../lib/http';
import { searchJikan } from './jikan';
import {
  getCharacters as getJikanCharacters,
  getAllEpisodes as getJikanEpisodes,
  getRelations as getJikanRelations,
} from './jikan-extras';

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

async function resolveMalId(
  malId: number | null,
  title: string
): Promise<number | null> {
  if (malId) return malId;
  if (!title) return null;
  const search = await withTimeout(() => searchJikan(title), 6000);
  return search?.mal_id ?? null;
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
    voiceActor?: { data?: { id: string; type: string } | null };
  };
}

async function getKitsuCharacters(
  kitsuId: string
): Promise<UnifiedCharacter[] | null> {
  const url = `https://kitsu.io/api/edge/anime/${kitsuId}/characters?include=character,voiceActor&page[limit]=40`;

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
    const vaRef = role.relationships?.voiceActor?.data;
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

    const vas: UnifiedCharacter['voiceActors'] = [];
    if (vaRef) {
      const vaItem = indexed.get(`people:${vaRef.id}`);
      if (vaItem?.attributes?.name) {
        vas.push({
          name: vaItem.attributes.name,
          image: vaItem.attributes.image?.original ?? undefined,
          language: 'Japanese',
        });
      }
    }

    out.push({
      name: charName,
      image: charItem.attributes?.image?.original ?? undefined,
      role: roleNorm,
      voiceActors: vas,
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
  const url = `https://kitsu.io/api/edge/anime/${kitsuId}/episodes?page[limit]=100&sort=number`;

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

interface ShikimoriRole {
  id: number;
  name: string;
  russian?: string;
  image?: { original?: string; preview?: string } | null;
  roles?: string[];
  roles_russian?: string[];
  person?: {
    id?: number;
    name?: string;
    russian?: string;
    image?: { original?: string; preview?: string } | null;
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

  const data = (await res.json()) as ShikimoriRole[];
  if (!Array.isArray(data) || data.length === 0) return null;

  const out: UnifiedCharacter[] = [];
  const seen = new Set<string>();

  for (const role of data) {
    if (!role.name || seen.has(role.name)) continue;
    seen.add(role.name);

    const roles = role.roles ?? [];
    const isMain = roles.some((r) => r.toLowerCase() === 'main');
    const isSupporting = roles.some((r) => r.toLowerCase() === 'supporting');
    const roleNorm: UnifiedCharacter['role'] = isMain
      ? 'main'
      : isSupporting
        ? 'supporting'
        : 'background';

    const vas: UnifiedCharacter['voiceActors'] = [];
    if (role.person?.name) {
      vas.push({
        name: role.person.name,
        image: shikimoriImage(role.person.image),
        language: 'Japanese',
      });
    }

    out.push({
      name: role.name,
      image: shikimoriImage(role.image),
      role: roleNorm,
      voiceActors: vas,
    });

    if (out.length >= MAX_ITEMS) break;
  }

  return out.length > 0 ? out : null;
}

/* ============================================================
   SHIKIMORI — RELATIONS
   ============================================================ */

interface ShikimoriAnimeFull {
  id: number;
  name: string;
  related?: {
    id: number;
    name: string;
    kind?: string;
    relation?: string;
  }[];
}

function mapShikimoriRelation(raw: string | undefined): string {
  if (!raw) return 'other';
  const lower = raw.toLowerCase();
  if (lower.includes('sequel')) return 'sequel';
  if (lower.includes('prequel')) return 'prequel';
  if (lower.includes('spin')) return 'spin_off';
  if (lower.includes('side')) return 'side_story';
  if (lower.includes('alternative')) return 'alternative';
  if (lower.includes('adaptation')) return 'adaptation';
  if (lower.includes('summary')) return 'summary';
  return 'other';
}

async function getShikimoriRelations(
  malId: number
): Promise<UnifiedRelation[] | null> {
  const url = `https://shikimori.one/api/animes/${malId}`;

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

  const data = (await res.json()) as ShikimoriAnimeFull;
  const related = data?.related ?? [];
  if (related.length === 0) return null;

  const out: UnifiedRelation[] = [];
  for (const rel of related) {
    if (!rel.name) continue;
    out.push({
      relation: mapShikimoriRelation(rel.relation),
      slug: slugify(rel.name),
      title: rel.name,
    });
  }

  return out.length > 0 ? out : null;
}

/* ============================================================
   JIKAN NORMALIZERS
   ============================================================ */

interface JikanCharRaw {
  character: {
    name: string;
    images?: { jpg?: { image_url?: string } };
  };
  role: string;
  voice_actors?: {
    person: {
      name: string;
      images?: { jpg?: { image_url?: string } };
    };
    language: string;
  }[];
}

function normalizeJikanCharacters(raw: unknown): UnifiedCharacter[] {
  const arr = raw as JikanCharRaw[];
  if (!Array.isArray(arr)) return [];

  const out: UnifiedCharacter[] = [];
  for (const entry of arr) {
    if (!entry.character?.name) continue;
    const roleRaw = (entry.role ?? 'supporting').toLowerCase();
    const role: UnifiedCharacter['role'] =
      roleRaw === 'main'
        ? 'main'
        : roleRaw === 'supporting'
          ? 'supporting'
          : 'background';

    const vas: UnifiedCharacter['voiceActors'] = [];
    for (const v of entry.voice_actors ?? []) {
      if (v.person?.name) {
        vas.push({
          name: v.person.name,
          image: v.person.images?.jpg?.image_url,
          language: v.language ?? 'Japanese',
        });
      }
    }

    out.push({
      name: entry.character.name,
      image: entry.character.images?.jpg?.image_url,
      role,
      voiceActors: vas,
    });

    if (out.length >= MAX_ITEMS) break;
  }

  return out;
}

interface JikanEpRaw {
  mal_id: number;
  title?: string;
  aired?: string | null;
  duration?: number | null;
}

function normalizeJikanEpisodes(raw: unknown): UnifiedEpisode[] {
  const arr = raw as JikanEpRaw[];
  if (!Array.isArray(arr)) return [];

  const out: UnifiedEpisode[] = [];
  for (const ep of arr) {
    out.push({
      number: ep.mal_id ?? 0,
      title: ep.title ?? `Episode ${ep.mal_id}`,
      aired: ep.aired ? ep.aired.split('T')[0] : undefined,
      duration: ep.duration ?? undefined,
    });
    if (out.length >= MAX_EPISODES) break;
  }

  return out;
}

interface JikanRelRaw {
  relation: string;
  entry: { mal_id: number; type: string; name: string; url: string }[];
}

function mapJikanRelation(raw: string): string {
  const map: Record<string, string> = {
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
  return map[raw] ?? 'other';
}

function normalizeJikanRelations(raw: unknown): UnifiedRelation[] {
  const arr = raw as JikanRelRaw[];
  if (!Array.isArray(arr)) return [];

  const out: UnifiedRelation[] = [];
  for (const rel of arr) {
    const relationKey = mapJikanRelation(rel.relation);
    for (const entry of rel.entry ?? []) {
      if (!entry.name) continue;
      out.push({
        relation: relationKey,
        slug: slugify(entry.name),
        title: entry.name,
      });
    }
  }

  return out;
}

/* ============================================================
   CHAIN RESOLVERS
   ============================================================ */

export async function chainCharacters(
  ctx: ChainContext
): Promise<ChainResult<UnifiedCharacter>> {
  const errors: string[] = [];
  const malId = await resolveMalId(ctx.malId, ctx.title);

  if (malId) {
    const jikan = await withTimeout(
      () => getJikanCharacters(malId),
      PER_SOURCE_TIMEOUT
    );
    if (jikan && jikan.length > 0) {
      return {
        data: normalizeJikanCharacters(jikan),
        source: 'Jikan',
        errors,
      };
    }
    errors.push('Jikan: gagal atau kosong');
  } else {
    errors.push('Jikan: tidak ada MAL ID');
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

  if (malId) {
    const shiki = await withTimeout(
      () => getShikimoriCharacters(malId),
      PER_SOURCE_TIMEOUT
    );
    if (shiki && shiki.length > 0) {
      return { data: shiki, source: 'Shikimori', errors };
    }
    errors.push('Shikimori: gagal atau kosong');
  }

  return { data: null, source: 'none', errors };
}

export async function chainEpisodes(
  ctx: ChainContext
): Promise<ChainResult<UnifiedEpisode>> {
  const errors: string[] = [];
  const malId = await resolveMalId(ctx.malId, ctx.title);

  if (malId) {
    const jikan = await withTimeout(
      () => getJikanEpisodes(malId, MAX_EPISODES),
      PER_SOURCE_TIMEOUT * 2
    );
    if (jikan && jikan.length > 0) {
      return {
        data: normalizeJikanEpisodes(jikan),
        source: 'Jikan',
        errors,
      };
    }
    errors.push('Jikan: gagal atau kosong');
  } else {
    errors.push('Jikan: tidak ada MAL ID');
  }

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

export async function chainRelations(
  ctx: ChainContext
): Promise<ChainResult<UnifiedRelation>> {
  const errors: string[] = [];
  const malId = await resolveMalId(ctx.malId, ctx.title);

  if (malId) {
    const jikan = await withTimeout(
      () => getJikanRelations(malId),
      PER_SOURCE_TIMEOUT
    );
    if (jikan && jikan.length > 0) {
      return {
        data: normalizeJikanRelations(jikan),
        source: 'Jikan',
        errors,
      };
    }
    errors.push('Jikan: gagal atau kosong');
  } else {
    errors.push('Jikan: tidak ada MAL ID');
  }

  if (malId) {
    const shiki = await withTimeout(
      () => getShikimoriRelations(malId),
      PER_SOURCE_TIMEOUT
    );
    if (shiki && shiki.length > 0) {
      return { data: shiki, source: 'Shikimori', errors };
    }
    errors.push('Shikimori: gagal atau kosong');
  }

  return { data: null, source: 'none', errors };
}
