// src/services/decode-core.ts
import type { Env } from '../types/env';

export const MAX_INPUT_LEN = 8000;
export const MAX_LAYERS = 5;
export const MAX_CANDIDATES = 800;
export const MAX_PARAM_DEPTH = 3;
export const BATCH_MAX = 6;

const BASE64_PARAM_NAMES = new Set([
  'bsrc', 'src', 'url', 'link', 'u', 'q', 'data',
  'em', 'embed', 'target', 'id', 'file', 'video',
]);

const VIDEO_EXT_RE = /\.(mp4|m3u8|mkv|webm|ts|mov)(\?|#|$)/i;

const VIDEO_HOSTS = [
  'player.', 'streamtape', 'dood', 'filemoon', 'voe', 'mp4upload',
  'mixdrop', 'iixdrop', 'abyss', 'abyssplayer',
  'framezi', 'kturbo',
  'pixeldrain', 'vikingfile', 'buzzheavier', 'mega.nz', 'doply',
  'xtwap.top',
  'otakudesu',
  'kuramanime',
  'anoboy',
  'oploverz',
  'blogspot',
  'blogger.com',
  'desustream',
  'kuragebunch',
  'streamsb',
  'filemoon.sx',
  'vidhide',
  'odvidhide',
  'ondesuhd',
  'vidcloud',
  'hxfile',
  'krakenfiles',
  'gofile',
  'acefile',
  'animekuid',
  'animesub',
  'lexanime',
  'dropbox.com',
];

const WRAPPER_HOSTS = [
  'animesail.xyz',
  '154999000.xyz',
  'video.animesub.web.id',
];

const SERVER_ALIASES: Record<string, string> = {
  abyss: 'abyss', dodo: 'doply', doply: 'doply',
  pixel: 'pixeldrain', pixeldrain: 'pixeldrain',
  viking: 'vikingfile', vikingfile: 'vikingfile',
  mix: 'mixdrop', mixdrop: 'mixdrop',
  buzi: 'buzzheavier', buzzheavier: 'buzzheavier',
  mp4: 'mp4upload', mp4upload: 'mp4upload',
  mega: 'mega', lokal: 'lokal', kamado: 'kamado', pancal: 'pancal',
  'b-tube': 'blogger', 'btube': 'blogger',
  'blogger': 'blogger', 'blogspot': 'blogger',
  odstream: 'odstream', odcdn: 'odcdn',
  ondesuhd: 'ondesuhd', ondesu: 'ondesu',
  vidhide: 'vidhide',
};

const RSC_EMBED_RE =
  /\\"quality\\":\\"([^\\"]+)\\",\\"mirror\\":\\"([^\\"]+)\\",\\"link\\":\\"([^\\"]+)\\"/g;


export interface RawEntry {
  base64?: string;
  url?: string;
  label: string | null;
}

export interface ResolvedEntry {
  url: string;
  resolution: string | null;
  server: string | null;
}

export interface EpisodeJson {
  number: number;
  streams: {
    quality: string;
    servers: { name: string; url: string }[];
  }[];
}

export interface DecodeOutput {
  videos: ResolvedEntry[];
  labels: (string | null)[];
}

export interface ProxyResponse {
  ok: boolean;
  status: number;
  body?: string;
  error?: string;
  truncated?: boolean;
}

export interface ProxyDebug {
  proxyUrl: string;
  httpStatus: number;
  contentType: string;
  rawLength: number;
  rawPreview: string;
  parseOk: boolean;
  error?: string;
}

export function htmlDecode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

export function normalizeBase64(input: string): string | null {
  let b64 = input.trim().replace(/\s+/g, '');
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const mod = b64.length % 4;
  if (mod === 1) return null;
  if (mod === 2) b64 += '==';
  else if (mod === 3) b64 += '=';
  return b64;
}

export function decodeBase64(input: string): string | null {
  const b64 = normalizeBase64(input);
  if (!b64) return null;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

export function isLikelyBase64(s: string): boolean {
  const t = s.trim().replace(/\s+/g, '');
  if (t.length < 12 || t.length > MAX_INPUT_LEN * 2) return false;
  return /^[A-Za-z0-9+/\-_]+=*$/.test(t);
}

export function isPrintable(s: string): boolean {
  if (s.length === 0) return false;
  let bad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0xfffd) bad++;
    else if (c < 32 && c !== 9 && c !== 10 && c !== 13) bad++;
  }
  return bad / s.length < 0.05;
}

export function looksLikeHtml(s: string): boolean {
  if (s.length < 30) return false;
  return (
    /<!DOCTYPE/i.test(s) ||
    /<html[\s>]/i.test(s) ||
    /<script[\s>]/i.test(s) ||
    /<iframe[\s>]/i.test(s) ||
    /<\/?[a-z][a-z0-9-]*[\s>]/i.test(s)
  );
}

export function isVideoUrl(url: string): boolean {
  if (VIDEO_EXT_RE.test(url)) return true;
  const lower = url.toLowerCase();
  return VIDEO_HOSTS.some((h) => lower.includes(h));
}

export function isWrapper(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return WRAPPER_HOSTS.some((w) => h === w || h.endsWith('.' + w));
  } catch {
    return false;
  }
}

export function parseResolution(label: string | null): string | null {
  if (!label) return null;
  const m =
    label.match(/\b(\d{3,4})p\b/i) ?? label.match(/\[\s*(\d{3,4})p\s*\]/i);
  return m && m[1] ? `${m[1]}p` : null;
}

export function parseServerName(label: string | null): string | null {
  if (!label) return null;
  const cleaned = label
    .toLowerCase()
    .replace(/^\s*\[\s*\d{3,4}p\s*\]\s*/i, '')
    .replace(/^\s*\d{3,4}p\s+/i, '')
    .replace(/\s+\d{3,4}p\s*$/i, '')
    .replace(/\s*[-_]\s*\d+$/i, '')
    .replace(/\s+\d+$/i, '')
    .trim();
  if (!cleaned) return null;
  return SERVER_ALIASES[cleaned] ?? cleaned;
}

export function rankResolution(r: string | null): number {
  if (!r || r === 'Lainnya' || r === 'Unknown') return -1;
  const n = parseInt(r.replace(/p$/i, ''), 10);
  return isNaN(n) ? -1 : n;
}

export function slugifyLabel(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/\.(html?|txt|json)$/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `file-${Date.now()}`
  );
}

export function parseEpisodeNumber(
  filename: string | null,
  labels: (string | null)[]
): number {
  const RESOLUTIONS = new Set([
    144, 240, 360, 480, 540, 720, 1080, 1440, 2160,
  ]);

  const isValid = (n: number): boolean =>
    n > 0 && n < 10000 && !RESOLUTIONS.has(n);

  if (filename) {
    const m = filename.match(/\b(?:ep|eps|episode|e)\s*[-_.]?\s*0*(\d+)\b/i);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (isValid(n)) return n;
    }
  }

  for (const label of labels) {
    if (!label) continue;
    const m = label.match(/\b(?:episode|eps|ep)\s*0*(\d+)\b/i);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (isValid(n)) return n;
    }
  }

  for (const label of labels) {
    if (!label) continue;
    const m = label.trim().match(/^0*(\d+)$/);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (isValid(n)) return n;
    }
  }

  return 1;
}

export function extractUrlsFromDecoded(s: string): string[] {
  const found = new Set<string>();
  const cleaned = htmlDecode(s);
  const trimmed = cleaned.trim();
  if (/^https?:\/\/[^\s]+$/i.test(trimmed)) {
    found.add(trimmed);
    return [...found];
  }

  for (const m of cleaned.matchAll(/<iframe\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)) {
    const u = htmlDecode(m[1] ?? '');
    if (/^https?:\/\//i.test(u)) found.add(u);
  }
  if (found.size === 0) {
    for (const m of cleaned.matchAll(/src\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
      const u = htmlDecode(m[1] ?? '');
      if (u) found.add(u);
    }
  }
  if (found.size === 0) {
    for (const m of cleaned.matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
      const u = htmlDecode(m[1] ?? '');
      if (u) found.add(u);
    }
  }
  if (found.size === 0) {
    for (const m of cleaned.matchAll(/https?:\/\/[^\s"'<>()\\]+/g)) {
      const u = htmlDecode(m[0]);
      if (u) found.add(u);
    }
  }
  return [...found];
}

export function expandUrlParams(url: string, depth = 0): string[] {
  const out = new Set<string>([url]);
  if (depth > MAX_PARAM_DEPTH) return [...out];

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [...out];
  }

  for (const seg of parsed.pathname.split('/')) {
    if (seg.length < 20 || seg.length > 800) continue;
    let dec = seg;
    try {
      dec = decodeURIComponent(seg);
    } catch {}
    if (!isLikelyBase64(dec)) continue;
    const decoded = decodeBase64(dec);
    if (!decoded || !isPrintable(decoded)) continue;
    const trimmed = decoded.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      for (const sub of expandUrlParams(trimmed, depth + 1)) out.add(sub);
    }
  }

  for (const [key, value] of parsed.searchParams.entries()) {
    if (!value || value.length < 12) continue;
    if (!BASE64_PARAM_NAMES.has(key.toLowerCase())) continue;

    if (/^https?:\/\//i.test(value)) {
      for (const sub of expandUrlParams(value, depth + 1)) out.add(sub);
      continue;
    }
    if (/^https?%3A/i.test(value)) {
      try {
        const dec = decodeURIComponent(value);
        if (/^https?:\/\//i.test(dec)) {
          for (const sub of expandUrlParams(dec, depth + 1)) out.add(sub);
        }
      } catch {}
    }
    if (isLikelyBase64(value)) {
      const decoded = decodeBase64(value);
      if (decoded && isPrintable(decoded)) {
        const trimmed = decoded.trim();
        if (/^https?:\/\//i.test(trimmed)) {
          for (const sub of expandUrlParams(trimmed, depth + 1)) out.add(sub);
        }
      }
    }
  }
  return [...out];
}

export interface DecodeResult {
  output: string;
  layers: number;
  urls: string[];
}

export function multiLayerDecode(input: string): DecodeResult | null {
  if (!isLikelyBase64(input)) return null;
  let current = input.trim();
  let layers = 0;
  for (let i = 0; i < MAX_LAYERS; i++) {
    const decoded = decodeBase64(current);
    if (decoded === null || decoded === current) break;
    if (!isPrintable(decoded)) break;
    current = decoded;
    layers++;
    const urls = extractUrlsFromDecoded(current);
    if (urls.length > 0) break;
    if (!isLikelyBase64(current)) break;
  }
  if (layers === 0) return null;
  return { output: current, layers, urls: extractUrlsFromDecoded(current) };
}

function extractNextJsEmbeds(html: string): RawEntry[] {
  const out: RawEntry[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(RSC_EMBED_RE)) {
    const quality = m[1] ?? '';
    const mirror = m[2] ?? '';
    let link = m[3] ?? '';

    if (!link) continue;

    link = link.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');

    if (!/^https?:\/\//i.test(link)) continue;
    if (seen.has(link)) continue;
    seen.add(link);

    out.push({
      url: link,
      label: `[${quality.toUpperCase()}] ${mirror.toUpperCase()}`,
    });
  }
  return out;
}

export function extractEntries(html: string): RawEntry[] {
  const entries: RawEntry[] = [];
  const seen = new Set<string>();

  for (const e of extractNextJsEmbeds(html)) {
    const key = e.url!;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(e);
  }

  for (const m of html.matchAll(/<button\b([^>]*?)>/gi)) {
    const attrs = m[1] ?? '';
    const labelMatch = attrs.match(/\bdata-label\s*=\s*["']([^"']*)["']/i);
    const embedMatch = attrs.match(
      /\bdata-embed\s*=\s*["']([A-Za-z0-9+/=\-_]{20,})["']/i
    );
    if (!embedMatch) continue;

    const b64 = embedMatch[1];
    if (!b64 || seen.has(b64)) continue;
    seen.add(b64);

    const label = labelMatch?.[1]?.trim() ?? null;
    entries.push({ base64: b64, label: label || null });
  }

  for (const m of html.matchAll(/<option\b([^>]*?)>([^<]*)<\/option>/gi)) {
    const attrs = m[1] ?? '';
    const label = (m[2] ?? '').trim();

    const b64Match =
      attrs.match(/\bvalue\s*=\s*["']([A-Za-z0-9+/=\-_]{20,})["']/i) ??
      attrs.match(
        /\bdata-[a-z0-9-]+\s*=\s*["']([A-Za-z0-9+/=\-_]{20,})["']/i
      );

    if (!b64Match) continue;
    const b64 = b64Match[1];
    if (!b64 || seen.has(b64)) continue;
    seen.add(b64);
    entries.push({ base64: b64, label: label || null });
  }

  for (const m of html.matchAll(
    /atob\s*\(\s*["']([A-Za-z0-9+/=\-_]{16,})["']\s*\)/gi
  )) {
    const b64 = m[1];
    if (!b64 || seen.has(b64)) continue;
    seen.add(b64);
    entries.push({ base64: b64, label: null });
  }

  for (const m of html.matchAll(/[A-Za-z0-9+/\-_]{24,}={0,2}/g)) {
    if (entries.length >= MAX_CANDIDATES) break;
    const b64 = m[0];
    if (!b64 || seen.has(b64)) continue;
    seen.add(b64);
    entries.push({ base64: b64, label: null });
  }

  return entries;
}

export function collectResolvedVideos(entries: RawEntry[]): ResolvedEntry[] {
  const resolved = new Map<
    string,
    { resolution: string | null; server: string | null }
  >();
  const unresolved = new Map<
    string,
    { resolution: string | null; server: string | null }
  >();

  function resolve(
    url: string,
    resolution: string | null,
    server: string | null,
    depth: number,
    seen: Set<string>
  ): void {
    if (depth > 4 || seen.has(url)) return;
    seen.add(url);
    const children = expandUrlParams(url).filter((u) => u !== url);
    if (isWrapper(url)) {
      if (children.length === 0) {
        if (!resolved.has(url) && !unresolved.has(url)) {
          unresolved.set(url, { resolution, server });
        }
      } else {
        for (const c of children)
          resolve(c, resolution, server, depth + 1, seen);
      }
      return;
    }
    if (!resolved.has(url)) resolved.set(url, { resolution, server });
    for (const c of children) resolve(c, resolution, server, depth + 1, seen);
  }

  for (const e of entries) {
    const resolution = parseResolution(e.label);
    const server = parseServerName(e.label);

    if (e.url) {
      resolve(e.url, resolution, server, 0, new Set());
      continue;
    }

    if (!e.base64) continue;
    const dec = multiLayerDecode(e.base64);
    if (!dec || dec.urls.length === 0) continue;
    for (const url of dec.urls) resolve(url, resolution, server, 0, new Set());
  }

  const final: ResolvedEntry[] = [];
  for (const [url, info] of resolved) {
    if (isVideoUrl(url)) {
      final.push({ url, resolution: info.resolution, server: info.server });
    }
  }

  if (final.length === 0) {
    for (const [url, info] of resolved) {
      final.push({ url, resolution: info.resolution, server: info.server });
    }
  }
  if (final.length === 0) {
    for (const [url, info] of unresolved) {
      final.push({ url, resolution: info.resolution, server: info.server });
    }
  }

  final.sort((a, b) => {
    const ra = rankResolution(a.resolution);
    const rb = rankResolution(b.resolution);
    if (ra !== rb) return rb - ra;
    return a.url.length - b.url.length;
  });
  return final;
}

export function buildEpisodeObject(
  items: ResolvedEntry[],
  episodeNumber: number
): EpisodeJson {
  const byQuality = new Map<string, { name: string; url: string }[]>();

  for (const item of items) {
    const q = item.resolution ?? 'Unknown';
    if (!byQuality.has(q)) byQuality.set(q, []);
    byQuality.get(q)!.push({
      name: item.server ?? 'unknown',
      url: item.url,
    });
  }

  const qualities = [...byQuality.keys()].sort(
    (a, b) => rankResolution(b) - rankResolution(a)
  );

  const streams = qualities.map((q) => ({
    quality: q,
    servers: byQuality.get(q)!,
  }));

  return { number: episodeNumber, streams };
}

export function buildEpisodeJson(
  items: ResolvedEntry[],
  episodeNumber: number
): string {
  return JSON.stringify(buildEpisodeObject(items, episodeNumber), null, 2) + '\n';
}

export function groupByResolution(
  items: ResolvedEntry[]
): Map<string, ResolvedEntry[]> {
  const byRes = new Map<string, ResolvedEntry[]>();
  for (const it of items) {
    const key = it.resolution ?? 'Lainnya';
    if (!byRes.has(key)) byRes.set(key, []);
    byRes.get(key)!.push(it);
  }
  return byRes;
}

export function decodeInput(
  input: string,
  sourceType: 'base64' | 'html'
): DecodeOutput | null {
  const entries: RawEntry[] =
    sourceType === 'html'
      ? extractEntries(input)
      : [{ base64: input, label: null }];
  if (entries.length === 0) return null;
  const videos = collectResolvedVideos(entries);
  if (videos.length === 0) return null;
  const labels = entries.map((e) => e.label);
  return { videos, labels };
}

export async function fetchUrlViaProxy(
  env: Env,
  url: string
): Promise<{ body: string | null; debug: ProxyDebug }> {
  const proxyUrl = env.VAL_TOWN_FETCH_URL;
  const debug: ProxyDebug = {
    proxyUrl: proxyUrl ?? '(undefined)',
    httpStatus: 0,
    contentType: '',
    rawLength: 0,
    rawPreview: '',
    parseOk: false,
  };

  if (!proxyUrl) {
    debug.error = 'VAL_TOWN_FETCH_URL tidak di-set';
    console.error('[Decode]', debug.error);
    return { body: null, debug };
  }

  try {
    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    debug.httpStatus = res.status;
    debug.contentType = res.headers.get('content-type') ?? '';

    const raw = await res.text();
    debug.rawLength = raw.length;
    debug.rawPreview = raw.slice(0, 200);

    console.log(
      `[Decode] proxy status=${res.status} ct=${debug.contentType} len=${raw.length}`
    );

    if (!res.ok) {
      debug.error = `Proxy HTTP ${res.status}`;
      return { body: null, debug };
    }

    let data: ProxyResponse;
    try {
      data = JSON.parse(raw) as ProxyResponse;
      debug.parseOk = true;
    } catch {
      debug.error = 'Response proxy bukan JSON';
      return { body: null, debug };
    }

    if (!data.body || data.body.length < 200) {
      debug.error = `Target HTTP ${data.status}: body kosong/terlalu pendek`;
      return { body: null, debug };
    }

    if (data.status >= 400) {
      debug.error = `Target HTTP ${data.status} (tetap coba proses, body ${data.body.length} char)`;
      console.warn(`[Decode] ${debug.error}`);
    }

    return { body: data.body, debug };
  } catch (err: any) {
    debug.error = `fetch threw: ${err?.message ?? 'unknown'}`;
    console.error('[Decode] proxy fetch threw:', err);
    return { body: null, debug };
  }
}

export function extractSlugHint(url: string): string | null {
  const m = url.match(/\/tonton\/([^/]+)/i);
  return m?.[1] ?? null;
}

export function buildBatchUrls(
  input: string,
  start: number,
  end: number
): string[] {
  const urls: string[] = [];

  if (input.includes('{n}')) {
    for (let n = start; n <= end; n++) {
      urls.push(input.replace(/\{n\}/g, String(n)));
    }
    return urls;
  }

  const epMatch = input.match(/(episode|eps?|e)[-_]?0*\d+/i);
  if (epMatch && epMatch.index !== undefined) {
    const prefix = input.slice(0, epMatch.index);
    const suffix = input.slice(epMatch.index + epMatch[0].length);
    for (let n = start; n <= end; n++) {
      urls.push(`${prefix}episode-${n}${suffix}`);
    }
    return urls;
  }

  const base = input.replace(/\/+$/, '');
  for (let n = start; n <= end; n++) {
    urls.push(`${base}/episode-${n}-sub-indo`);
  }
  return urls;
}