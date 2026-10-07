// src/services/yukionime.ts
import type { AniListMedia } from '../types/anime';

const YUKIONIME_BASE = 'https://yukionime.pages.dev';

export interface YukionimeAnime {
  id: string;
  title: string;
  titleEnglish?: string | null;
  titleNative?: string | null;
  image?: string | null;
  banner?: string | null;
  trailer?: string | null;
  year?: number | null;
  type?: string;
  status?: string;
  season?: string | null;
  source?: string | null;
  episodes?: number | null;
  duration?: number | null;
  rating?: string | null;
  aired?: { from?: string | null; to?: string | null } | null;
  stats?: { score?: number; scoredBy?: number } | null;
  genres?: string[];
  studios?: Array<string | { slug: string; name: string }>;
  externalIds?: {
    mal?: number | null;
    anilist?: number | null;
    kitsu?: string | null;
  };
  synopsis?: string | null;
}

/* ============================================================
   SEARCH
   ============================================================ */

export async function searchYukionime(
  query: string
): Promise<YukionimeAnime | null> {
  try {
    const res = await fetch(`${YUKIONIME_BASE}/api/v1/anime.json`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;

    const json = (await res.json()) as { data?: YukionimeAnime[] };
    const list: YukionimeAnime[] = json.data ?? [];

    const q = query.toLowerCase().trim();
    const match = list.find((a) => {
      const t1 = (a.title ?? '').toLowerCase();
      const t2 = (a.titleEnglish ?? '').toLowerCase();
      const t3 = (a.titleNative ?? '').toLowerCase();
      return t1.includes(q) || t2.includes(q) || t3.includes(q);
    });

    if (!match) return null;
    return match;
  } catch (err) {
    console.warn('[Yukionime] search failed:', err);
    return null;
  }
}

/* ============================================================
   DETAIL + SYNOPSIS
   ============================================================ */

export async function getYukionimeDetail(
  slug: string
): Promise<YukionimeAnime | null> {
  try {
    const apiRes = await fetch(`${YUKIONIME_BASE}/api/v1/anime/${slug}.json`);
    if (!apiRes.ok) return null;

    const apiJson = (await apiRes.json()) as { data?: YukionimeAnime };
    const data: YukionimeAnime = apiJson?.data ?? { id: slug, title: '' };

    // Fetch HTML untuk synopsis
    const htmlRes = await fetch(`${YUKIONIME_BASE}/anime/${slug}/`);
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      data.synopsis = extractSynopsis(html);
    }

    return data;
  } catch (err) {
    console.warn('[Yukionime] detail fetch failed:', err);
    return null;
  }
}

/* ============================================================
   CHECK LENGKAP
   ============================================================ */

export function isYukionimeComplete(anime: YukionimeAnime): boolean {
  if (!anime.id) return false;
  if (!anime.title) return false;
  if (!anime.image) return false;
  if (!anime.status) return false;
  if (!anime.type) return false;
  if (!anime.year) return false;
  if (!anime.genres || anime.genres.length === 0) return false;
  if (!anime.studios || anime.studios.length === 0) return false;
  if (!anime.stats?.score || anime.stats.score <= 0) return false;
  if (!anime.synopsis) return false;

  return true;
}

/* ============================================================
   CONVERT KE AniListMedia
   ============================================================ */

export function yukionimeToAniListMedia(anime: YukionimeAnime): AniListMedia {
  const format = mapTypeToFormat(anime.type ?? 'TV');
  const status = mapStatusToAniList(anime.status ?? 'finished');

  const startDate = parseDateStr(anime.aired?.from ?? null);
  const endDate = parseDateStr(anime.aired?.to ?? null);

  const studios = (anime.studios ?? []).map((s) => ({
    name: typeof s === 'string' ? s : s.name,
  }));

  return {
    id: anime.externalIds?.anilist ?? 0,
    title: {
      romaji: anime.title,
      english: anime.titleEnglish ?? null,
      native: anime.titleNative ?? null,
    },
    coverImage: {
      extraLarge: anime.image ?? '',
      large: anime.image ?? '',
    },
    description: anime.synopsis ?? null,
    format,
    status,
    seasonYear: anime.year ?? null,
    episodes: anime.episodes ?? null,
    genres: (anime.genres ?? []).map(capitalize),
    averageScore: anime.stats?.score
      ? Math.round(anime.stats.score * 10)
      : null,
    studios: { nodes: studios },
    startDate: startDate ?? {
      year: anime.year ?? null,
      month: null,
      day: null,
    },
    duration: anime.duration ?? null,
    rating: anime.rating ?? null,
    endDate: endDate ?? null,
    banner: anime.banner ?? null,
    trailer: anime.trailer ?? null,
    myanimelistId: anime.externalIds?.mal ?? null,
    source: anime.source ?? null,
  };
}

/* ============================================================
   HELPERS
   ============================================================ */

function mapTypeToFormat(type: string): string {
  const map: Record<string, string> = {
    TV: 'TV',
    Movie: 'MOVIE',
    OVA: 'OVA',
    ONA: 'ONA',
    Special: 'SPECIAL',
    Music: 'MUSIC',
    Unknown: 'TV',
  };
  return map[type] ?? 'TV';
}

function mapStatusToAniList(status: string): string {
  const map: Record<string, string> = {
    airing: 'RELEASING',
    finished: 'FINISHED',
    upcoming: 'NOT_YET_RELEASED',
    hiatus: 'HIATUS',
    cancelled: 'CANCELLED',
  };
  return map[status] ?? 'RELEASING';
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parseDateStr(
  s: string | null
): { year: number; month: number; day: number } | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (!y || !mo || !d) return null;
  return {
    year: parseInt(y, 10),
    month: parseInt(mo, 10),
    day: parseInt(d, 10),
  };
}

function extractSynopsis(html: string): string | null {
  const match = html.match(
    /<div[^>]*\bid=["']synopsis["'][^>]*>([\s\S]*?)<\/div>/i
  );
  if (!match || !match[1]) return null;
  return htmlToText(match[1]);
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<h[1-6][^>]*>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
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
