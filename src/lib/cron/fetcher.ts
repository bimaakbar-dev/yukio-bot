// src/lib/cron/fetcher.ts
import type { Env } from '../../types/env';
import type { EpisodeObject } from '../../types/anime';
import { safeFetch } from '../dba-common';
import type { SiteKey } from './state';

interface SiteConfig {
  host: string;
  videoHost: string;
  episodePath: (slug: string, n: number) => string;
  animePath: (slug: string) => string;
}

const SITES: Record<SiteKey, SiteConfig> = {
  lexanime: {
    host: 'https://lexanime.web.id',
    videoHost: 'video.lexanime.web.id',
    episodePath: (slug, n) => `/tonton/${slug}/episode-${n}-sub-indo`,
    animePath: (slug) => `/anime/${slug}/`,
  },
  animesub: {
    host: 'https://animesub.web.id',
    videoHost: 'video.animesub.web.id',
    episodePath: (slug, n) => `/tonton/${slug}/episode-${n}-sub-indo`,
    animePath: (slug) => `/anime/${slug}/`,
  },
  samehadaku: {
    host: 'https://samehadaku.li',
    videoHost: 'blogger.com',
    episodePath: (slug, n) => `/${slug}-episode-${n}-subtitle-indonesia/`,
    animePath: (slug) => `/anime/${slug}/`,
  },
};

const FETCH_TIMEOUT_MS = 12000;

async function fetchViaProxy(env: Env, url: string): Promise<string | null> {
  const proxyUrl = env.VAL_TOWN_FETCH_URL;
  if (!proxyUrl) {
    console.error('[Fetcher] VAL_TOWN_FETCH_URL tidak di-set');
    return null;
  }

  const { data } = await safeFetch(
    () =>
      fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      }).then((r) => r.json() as Promise<{ body?: string }>),
    FETCH_TIMEOUT_MS
  );

  if (!data || typeof data.body !== 'string') return null;
  return data.body;
}

/* ============================================================
   LATEST EPISODE NUMBER
   ============================================================ */

function parseLatestEpisodeLexanime(html: string): number | null {
  const numbers = new Set<number>();

  for (const m of html.matchAll(/>EP\s+(\d+)</gi)) {
    if (m[1]) numbers.add(parseInt(m[1], 10));
  }
  for (const m of html.matchAll(/Episode\s+(\d+)\s+Subtitle/gi)) {
    if (m[1]) numbers.add(parseInt(m[1], 10));
  }
  for (const m of html.matchAll(/\/episode-(\d+)-sub-indo/gi)) {
    if (m[1]) numbers.add(parseInt(m[1], 10));
  }

  if (numbers.size === 0) return null;
  return Math.max(...numbers);
}

function parseLatestEpisodeSamehadaku(html: string): number | null {
  const numbers = new Set<number>();

  for (const m of html.matchAll(/-episode-(\d+)-subtitle-indonesia/gi)) {
    if (m[1]) numbers.add(parseInt(m[1], 10));
  }

  if (numbers.size === 0) return null;
  return Math.max(...numbers);
}

export async function fetchLatestEpisodeNumber(
  env: Env,
  site: SiteKey,
  sourceSlug: string
): Promise<number | null> {
  const config = SITES[site];
  const url = `${config.host}${config.animePath(sourceSlug)}`;

  const html = await fetchViaProxy(env, url);
  if (!html) return null;

  if (site === 'samehadaku') {
    return parseLatestEpisodeSamehadaku(html);
  }

  return parseLatestEpisodeLexanime(html);
}

/* ============================================================
   PLAYER URL PARSER
   ============================================================ */

interface ParsedEpisode {
  sourceUrl: string;
  quality: string;
}

function decodeBase64UrlSafe(input: string): string | null {
  try {
    let b64 = input.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    const mod = b64.length % 4;
    if (mod === 2) b64 += '==';
    else if (mod === 3) b64 += '=';
    else if (mod === 1) return null;

    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const decoded = new TextDecoder('utf-8', {
      fatal: false,
      ignoreBOM: false,
    }).decode(bytes);

    if (!/^https?:\/\//i.test(decoded.trim())) return null;
    return decoded.trim();
  } catch {
    return null;
  }
}

function parsePlayerLexanime(html: string, site: SiteKey): ParsedEpisode | null {
  const config = SITES[site];
  const iframeRe = /<iframe[^>]*\sclass="[^"]*player-iframe[^"]*"[^>]*>/i;
  const iframeMatch = html.match(iframeRe);
  if (!iframeMatch) return null;

  const srcMatch = iframeMatch[0].match(/\ssrc="([^"]+)"/);
  if (!srcMatch || !srcMatch[1]) return null;

  const src = srcMatch[1];
  if (!src.includes(config.videoHost)) return null;

  const embedMatch = src.match(/\/embed\/([A-Za-z0-9+/=%_-]+)/);
  if (!embedMatch || !embedMatch[1]) return null;

  let b64 = embedMatch[1];
  try {
    b64 = decodeURIComponent(b64);
  } catch {}

  const sourceUrl = decodeBase64UrlSafe(b64);
  if (!sourceUrl) return null;

  const quality = detectLexanimeQuality(html);
  return { sourceUrl, quality };
}

function detectLexanimeQuality(html: string): string {
  const m = html.match(
    /<button[^>]*class="[^"]*quality-tab\s+active[^"]*"[^>]*>\s*\[?\s*(\d{3,4}p)\s*\]?/i
  );
  if (m && m[1]) return m[1].toLowerCase();

  const fallback = html.match(/\b(360p|480p|720p|1080p)\b/i);
  if (fallback && fallback[1]) return fallback[1].toLowerCase();

  return '720p';
}

interface SamehadakuServer {
  name: string;
  url: string;
}

function parseSamehadakuServers(html: string): SamehadakuServer[] {
  const servers: SamehadakuServer[] = [];
  const seen = new Set<string>();

  const re = /<button[^>]*class="[^"]*aspd-server[^"]*"[^>]*>/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[0];

    const labelMatch = tag.match(/\bdata-label="([^"]+)"/i);
    const urlMatch = tag.match(/\bdata-url="([^"]+)"/i);

    if (!labelMatch || !urlMatch) continue;
    const name = labelMatch[1];
    const url = urlMatch[1];
    if (!name || !url || !url.startsWith('http')) continue;

    const key = `${name}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    servers.push({ name, url });
  }

  return servers;
}

function parsePlayerSamehadaku(html: string): SamehadakuServer[] {
  const servers = parseSamehadakuServers(html);
  if (servers.length > 0) return servers;

  const fallback: SamehadakuServer[] = [];
  const seen = new Set<string>();

  const pembedMatch = html.match(
    /<div[^>]*id="pembed"[^>]*>[\s\S]*?<\/div>/i
  );
  if (pembedMatch) {
    const iframeMatch = pembedMatch[0].match(
      /<iframe[^>]*?\s(?:data-litespeed-src|src)="([^"]+)"/i
    );
    if (iframeMatch?.[1] && !iframeMatch[1].startsWith('about:')) {
      fallback.push({ name: 'HD-1', url: iframeMatch[1] });
      seen.add(iframeMatch[1]);
    }
  }

  for (const m of html.matchAll(/\bdata-embed="([A-Za-z0-9+/=_-]+)"/gi)) {
    const b64 = m[1];
    if (!b64) continue;

    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const decoded = new TextDecoder('utf-8').decode(bytes);

      const srcMatch = decoded.match(/\bsrc="([^"]+)"/i);
      if (srcMatch?.[1] && !seen.has(srcMatch[1])) {
        fallback.push({ name: 'HD-2', url: srcMatch[1] });
        seen.add(srcMatch[1]);
      }
    } catch {}
  }

  return fallback;
}

/* ============================================================
   FETCH EPISODE
   ============================================================ */

export async function fetchEpisode(
  env: Env,
  site: SiteKey,
  sourceSlug: string,
  epNumber: number
): Promise<EpisodeObject | null> {
  const config = SITES[site];
  const path = config.episodePath(sourceSlug, epNumber);
  const url = `${config.host}${path}`;

  const html = await fetchViaProxy(env, url);
  if (!html) return null;

  if (html.length < 2000 && /404|not found/i.test(html)) return null;

  if (site === 'samehadaku') {
    const servers = parsePlayerSamehadaku(html);
    if (servers.length === 0) return null;

    return {
      number: epNumber,
      streams: [
        {
          quality: '720p',
          servers: servers.map((s) => ({ name: s.name, url: s.url })),
        },
      ],
    };
  }

  const parsed = parsePlayerLexanime(html, site);
  if (!parsed) return null;

  return {
    number: epNumber,
    streams: [
      {
        quality: parsed.quality,
        servers: [
          {
            name: site,
            url: parsed.sourceUrl,
          },
        ],
      },
    ],
  };
}