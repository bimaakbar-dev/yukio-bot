// src/services/yukionime.ts

const YUKIONIME_BASE = 'https://qimochi.pages.dev';

export interface YukionimeAnime {
  id: string;
  title: string;
  titleEnglish?: string | null;
  titleNative?: string | null;
  image?: string | null;
  year?: number | null;
  type?: string;
  status?: string;
  season?: string | null;
  genres?: string[];
  studios?: string[];
  stats?: { score?: number; scoredBy?: number } | null;
  synopsis?: string | null;
}

/**
 * Cari anime di yukionime berdasarkan judul.
 * Return null kalau tidak ada.
 */
export async function searchYukionime(
  query: string
): Promise<YukionimeAnime | null> {
  try {
    const res = await fetch(`${YUKIONIME_BASE}/api/v1/anime.json`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;

    const json = (await res.json()) as { data?: any[] };
    const list = json.data ?? [];

    const q = query.toLowerCase().trim();
    const match = list.find((a) => {
      const t1 = (a.title ?? '').toLowerCase();
      const t2 = (a.titleEnglish ?? '').toLowerCase();
      const t3 = (a.titleNative ?? '').toLowerCase();
      return t1.includes(q) || t2.includes(q) || t3.includes(q);
    });

    if (!match) return null;

    return match as YukionimeAnime;
  } catch (err) {
    console.warn('[Yukionime] search failed:', err);
    return null;
  }
}

/**
 * Fetch detail + synopsis dari HTML page (scrape id="synopsis").
 */
export async function getYukionimeDetail(
  slug: string
): Promise<YukionimeAnime | null> {
  try {
    const url = `${YUKIONIME_BASE}/anime/${slug}/`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const html = await res.text();
    const synopsis = extractSynopsis(html);

    // Ambil detail dari API (metadata)
    const apiRes = await fetch(`${YUKIONIME_BASE}/api/v1/anime/${slug}.json`);
    const apiJson = apiRes.ok ? await apiRes.json() : null;

    const data = (apiJson?.data ?? {}) as YukionimeAnime;
    data.synopsis = synopsis;

    return data;
  } catch (err) {
    console.warn('[Yukionime] detail fetch failed:', err);
    return null;
  }
}

/* ============================================================
   EXTRACT SYNOPSIS
   ============================================================ */

function extractSynopsis(html: string): string | null {
  // Cari <div id="synopsis">...</div>
  const match = html.match(
    /<div[^>]*\bid=["']synopsis["'][^>]*>([\s\S]*?)<\/div>/i
  );
  if (!match?.[1]) return null;

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
