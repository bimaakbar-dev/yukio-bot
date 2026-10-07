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

export async function fetchLatestEpisodeNumber(
  env: Env,
  site: SiteKey,
  sourceSlug: string
): Promise<number | null> {
  const config = SITES[site];
  const url = `${config.host}${config.animePath(sourceSlug)}`;

  const html = await fetchViaProxy(env, url);
  if (!html) return null;

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

interface ParsedEpisode {
  sourceUrl: string;
  quality: string;
}

function parseIframeSource(html: string, site: SiteKey): ParsedEpisode | null {
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

  const quality = detectQuality(html);

  return { sourceUrl, quality };
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

function detectQuality(html: string): string {
  const m = html.match(
    /<button[^>]*class="[^"]*quality-tab\s+active[^"]*"[^>]*>\s*\[?\s*(\d{3,4}p)\s*\]?/i
  );
  if (m && m[1]) return m[1].toLowerCase();

  const fallback = html.match(/\b(360p|480p|720p|1080p)\b/i);
  if (fallback && fallback[1]) return fallback[1].toLowerCase();

  return '720p';
}

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

  const parsed = parseIframeSource(html, site);
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
