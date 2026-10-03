import type { AniListMedia } from './anilist';

const USER_AGENT =
  'Mozilla/5.0 (compatible; YukioBot/1.0; +https://qimochi-hub.github.io)';

/* ==========================================================
   HELPERS
   ========================================================== */

function extractMatch(html: string, regex: RegExp): string | null {
  const m = html.match(regex);
  return m ? m[1].trim() : null;
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function mapMALType(type: string): string {
  const t = type.toUpperCase();
  if (t.includes('TV')) return 'TV';
  if (t.includes('MOVIE')) return 'MOVIE';
  if (t.includes('OVA')) return 'OVA';
  if (t.includes('ONA')) return 'ONA';
  if (t.includes('SPECIAL')) return 'SPECIAL';
  return 'TV';
}

function mapMALStatus(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('finished')) return 'FINISHED';
  if (s.includes('not yet')) return 'NOT_YET_RELEASED';
  if (s.includes('on hiatus')) return 'HIATUS';
  return 'RELEASING';
}

/* ==========================================================
   SCRAPE
   ========================================================== */

export async function scrapeMALById(
  malId: string
): Promise<AniListMedia | null> {
  const url = `https://myanimelist.net/anime/${malId}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) {
    throw new Error(`MAL HTTP ${res.status}`);
  }

  const html = await res.text();

  // ── Title
  const title =
    extractMatch(html, /class="title-name[^"]*"[^>]*>\s*<strong>([^<]+)<\/strong>/i) ||
    extractMatch(html, /<h1[^>]*class="title-name[^"]*"[^>]*>([^<]+)<\/h1>/i);

  if (!title) {
    // Cek apakah kena anti-bot challenge
    if (html.includes('Just a moment') || html.includes('Cloudflare')) {
      throw new Error('MAL: Cloudflare challenge detected');
    }
    return null;
  }

  // ── Cover (MAL pakai lazy loading — data-src)
  const cover =
    extractMatch(html, /<img[^>]*itemprop="image"[^>]*data-src="([^"]+)"/i) ||
    extractMatch(html, /<img[^>]*itemprop="image"[^>]*src="([^"]+)"/i) ||
    '';

  // ── Rating (0-10 dari MAL)
  const ratingStr = extractMatch(
    html,
    /<span[^>]*itemprop="ratingValue"[^>]*>([^<]+)<\/span>/i
  );
  const rating = ratingStr ? parseFloat(ratingStr) : null;

  // ── Sinopsis
  const synopsisRaw = extractMatch(
    html,
    /<p[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/p>/i
  );
  const synopsis = synopsisRaw ? stripHtml(synopsisRaw) : '';

  // ── Type
  const typeRaw =
    extractMatch(html, /Type:<\/span>\s*<a[^>]*>([^<]+)<\/a>/i) ||
    extractMatch(html, /Type:<\/span>\s*([^<\n]+)/i) ||
    'TV';
  const type = mapMALType(typeRaw);

  // ── Episodes
  const episodesStr = extractMatch(html, /Episodes:<\/span>\s*([^\s<]+)/i);
  const episodes = episodesStr ? parseInt(episodesStr, 10) : null;

  // ── Status
  const statusRaw =
    extractMatch(html, /Status:<\/span>\s*([^<\n]+)/i) || 'Finished Airing';
  const status = mapMALStatus(statusRaw);

  // ── Studio
  const studio =
    extractMatch(html, /Studios:<\/span>\s*<a[^>]*>([^<]+)<\/a>/i) || 'Unknown';

  // ── Tahun rilis
  const yearStr = extractMatch(html, /Aired:<\/span>\s*[^<]*?(\d{4})/i);
  const year = yearStr ? parseInt(yearStr, 10) : null;

  // ── Genres
  const genres: string[] = [];
  const genreSection = html.match(/Genres:<\/span>([\s\S]*?)<\/div>/i);
  if (genreSection) {
    const regex = /<a[^>]*>([^<]+)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(genreSection[1])) !== null && genres.length < 5) {
      genres.push(m[1].trim());
    }
  }

  return {
    id: parseInt(malId, 10),
    title: {
      romaji: title,
      english: null,
      native: null,
    },
    coverImage: {
      extraLarge: cover,
      large: cover,
    },
    format: type,
    status,
    seasonYear: year,
    episodes: episodes !== null && !isNaN(episodes) ? episodes : null,
    genres,
    averageScore: rating !== null ? Math.round(rating * 10) : null,
    studios: {
      nodes: studio !== 'Unknown' ? [{ name: studio }] : [],
    },
    startDate: {
      year,
      month: null,
      day: null,
    },
  };
}

/* ==========================================================
   DETECT URL
   ========================================================== */

export function isMALUrl(s: string): boolean {
  return /^https?:\/\/(www\.)?myanimelist\.net\/anime\/\d+/i.test(s.trim());
}

export function extractMALId(url: string): string | null {
  const m = url.match(/myanimelist\.net\/anime\/(\d+)/i);
  return m?.[1] ?? null;
}