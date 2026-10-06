// src/commands/decode.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';

const MAX_INPUT_LEN = 8000;
const MAX_FILE_CHARS = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LAYERS = 5;
const MAX_CANDIDATES = 800;
const MAX_PARAM_DEPTH = 3;
const MSG_BUDGET = 3800;
const JSON_INLINE_THRESHOLD = 3500;

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
];

const WRAPPER_HOSTS = ['animesail.xyz', '154999000.xyz'];

const SERVER_ALIASES: Record<string, string> = {
  abyss: 'abyss', dodo: 'doply', doply: 'doply',
  pixel: 'pixeldrain', pixeldrain: 'pixeldrain',
  viking: 'vikingfile', vikingfile: 'vikingfile',
  mix: 'mixdrop', mixdrop: 'mixdrop',
  buzi: 'buzzheavier', buzzheavier: 'buzzheavier',
  mp4: 'mp4upload', mp4upload: 'mp4upload',
  mega: 'mega', lokal: 'lokal', kamado: 'kamado', pancal: 'pancal',
};

interface RawEntry {
  base64: string;
  label: string | null;
}

interface ResolvedEntry {
  url: string;
  resolution: string | null;
  server: string | null;
}

interface FileRef {
  id: number;
  label: string;
  filename: string | null;
  file_id: string;
  created_at: number;
  last_accessed: number;
}

let dbReady = false;
let dbInitPromise: Promise<void> | null = null;

async function ensureDb(db: D1Database): Promise<void> {
  if (dbReady) return;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS file_refs (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            label         TEXT UNIQUE NOT NULL,
            filename      TEXT,
            file_id       TEXT NOT NULL,
            created_at    INTEGER NOT NULL,
            last_accessed INTEGER NOT NULL
          )`
        )
        .run();
      await db
        .prepare('CREATE INDEX IF NOT EXISTS idx_file_refs_accessed ON file_refs(last_accessed DESC)')
        .run();
      dbReady = true;
    } catch (err) {
      console.error('[Decode] DB init error:', err);
      dbInitPromise = null;
      throw err;
    }
  })();

  return dbInitPromise;
}

async function getFileRef(db: D1Database, label: string): Promise<FileRef | null> {
  await ensureDb(db);
  const row = await db
    .prepare('SELECT * FROM file_refs WHERE label = ?')
    .bind(label)
    .first<FileRef>();
  if (!row) return null;
  db.prepare('UPDATE file_refs SET last_accessed = ? WHERE id = ?')
    .bind(Date.now(), row.id)
    .run()
    .catch(() => {});
  return row;
}

async function saveFileRef(
  db: D1Database,
  label: string,
  filename: string | null,
  fileId: string
): Promise<{ replaced: boolean }> {
  await ensureDb(db);
  const existing = await db
    .prepare('SELECT id FROM file_refs WHERE label = ?')
    .bind(label)
    .first<{ id: number }>();

  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO file_refs (label, filename, file_id, created_at, last_accessed)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(label) DO UPDATE SET
         filename = excluded.filename,
         file_id = excluded.file_id,
         last_accessed = excluded.last_accessed`
    )
    .bind(label, filename, fileId, now, now)
    .run();

  return { replaced: !!existing };
}

async function listFileRefs(db: D1Database, limit = 30): Promise<FileRef[]> {
  await ensureDb(db);
  const res = await db
    .prepare(
      'SELECT id, label, filename, file_id, created_at, last_accessed FROM file_refs ORDER BY last_accessed DESC LIMIT ?'
    )
    .bind(limit)
    .all<FileRef>();
  return res.results ?? [];
}

async function deleteFileRef(db: D1Database, label: string): Promise<boolean> {
  await ensureDb(db);
  const res = await db.prepare('DELETE FROM file_refs WHERE label = ?').bind(label).run();
  return (res.meta?.changes ?? 0) > 0;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function htmlDecode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function normalizeBase64(input: string): string | null {
  let b64 = input.trim().replace(/\s+/g, '');
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const mod = b64.length % 4;
  if (mod === 1) return null;
  if (mod === 2) b64 += '==';
  else if (mod === 3) b64 += '=';
  return b64;
}

function decodeBase64(input: string): string | null {
  const b64 = normalizeBase64(input);
  if (!b64) return null;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
  } catch { return null; }
}

function isLikelyBase64(s: string): boolean {
  const t = s.trim().replace(/\s+/g, '');
  if (t.length < 12 || t.length > MAX_INPUT_LEN * 2) return false;
  return /^[A-Za-z0-9+/\-_]+=*$/.test(t);
}

function isPrintable(s: string): boolean {
  if (s.length === 0) return false;
  let bad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0xfffd) bad++;
    else if (c < 32 && c !== 9 && c !== 10 && c !== 13) bad++;
  }
  return bad / s.length < 0.05;
}

function looksLikeHtml(s: string): boolean {
  if (s.length < 30) return false;
  return (
    /<!DOCTYPE/i.test(s) || /<html[\s>]/i.test(s) || /<script[\s>]/i.test(s) ||
    /<iframe[\s>]/i.test(s) || /<\/?[a-z][a-z0-9-]*[\s>]/i.test(s)
  );
}

function isVideoUrl(url: string): boolean {
  if (VIDEO_EXT_RE.test(url)) return true;
  const lower = url.toLowerCase();
  return VIDEO_HOSTS.some((h) => lower.includes(h));
}

function isWrapper(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return WRAPPER_HOSTS.some((w) => h === w || h.endsWith('.' + w));
  } catch { return false; }
}

function parseResolution(label: string | null): string | null {
  if (!label) return null;
  const m = label.match(/\b(\d{3,4})p\b/i);
  return m && m[1] ? `${m[1]}p` : null;
}

function parseServerName(label: string | null): string | null {
  if (!label) return null;
  const cleaned = label.toLowerCase().replace(/\s+\d{3,4}p\s*$/i, '').trim();
  if (!cleaned) return null;
  return SERVER_ALIASES[cleaned] ?? cleaned;
}

function resolutionRank(r: string | null): number {
  if (!r || r === 'Lainnya' || r === 'Unknown') return -1;
  const n = parseInt(r.replace(/p$/i, ''), 10);
  return isNaN(n) ? -1 : n;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.(html?|txt|json)$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || `file-${Date.now()}`;
}

/* ============================================================
   EPISODE NUMBER DETECTION
   ============================================================ */

function parseEpisodeNumber(
  filename: string | null,
  labels: (string | null)[]
): number {
  const RESOLUTIONS = new Set([
    144, 240, 360, 480, 540, 720, 1080, 1440, 2160,
  ]);

  const isValid = (n: number): boolean =>
    n > 0 && n < 10000 && !RESOLUTIONS.has(n);

  // Pass 1: filename
  if (filename) {
    const m = filename.match(/\b(?:ep|eps|episode|e)\s*[-_.]?\s*0*(\d+)\b/i);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (isValid(n)) return n;
    }
  }

  // Pass 2: label "Episode N"
  for (const label of labels) {
    if (!label) continue;
    const m = label.match(/\b(?:episode|eps|ep)\s*0*(\d+)\b/i);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (isValid(n)) return n;
    }
  }

  // Pass 3: label murni angka
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

/* ============================================================
   URL EXTRACTION
   ============================================================ */

function extractUrlsFromDecoded(s: string): string[] {
  const found = new Set<string>();
  const cleaned = htmlDecode(s);
  const trimmed = cleaned.trim();
  if (/^https?:\/\/[^\s]+$/i.test(trimmed)) { found.add(trimmed); return [...found]; }

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

function expandUrlParams(url: string, depth = 0): string[] {
  const out = new Set<string>([url]);
  if (depth > MAX_PARAM_DEPTH) return [...out];
  let parsed: URL;
  try { parsed = new URL(url); } catch { return [...out]; }

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
      } catch { /* ignore */ }
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

interface DecodeResult {
  output: string;
  layers: number;
  urls: string[];
}

function multiLayerDecode(input: string): DecodeResult | null {
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

function extractEntries(html: string): RawEntry[] {
  const entries: RawEntry[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(
    /<option\b[^>]*?\bdata-[a-z0-9-]+\s*=\s*["']([A-Za-z0-9+/=\-_]{20,})["'][^>]*?>([^<]*)<\/option>/gi
  )) {
    const b64 = m[1];
    const label = (m[2] ?? '').trim();
    if (!b64 || seen.has(b64)) continue;
    seen.add(b64);
    entries.push({ base64: b64, label: label || null });
  }

  for (const m of html.matchAll(/atob\s*\(\s*["']([A-Za-z0-9+/=\-_]{16,})["']\s*\)/gi)) {
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

function collectResolvedVideos(entries: RawEntry[]): ResolvedEntry[] {
  const resolved = new Map<string, { resolution: string | null; server: string | null }>();
  const unresolved = new Map<string, { resolution: string | null; server: string | null }>();

  function resolve(url: string, resolution: string | null, server: string | null, depth: number, seen: Set<string>): void {
    if (depth > 4 || seen.has(url)) return;
    seen.add(url);
    const children = expandUrlParams(url).filter((u) => u !== url);
    if (isWrapper(url)) {
      if (children.length === 0) {
        if (!resolved.has(url) && !unresolved.has(url)) unresolved.set(url, { resolution, server });
      } else {
        for (const c of children) resolve(c, resolution, server, depth + 1, seen);
      }
      return;
    }
    if (!resolved.has(url)) resolved.set(url, { resolution, server });
    for (const c of children) resolve(c, resolution, server, depth + 1, seen);
  }

  for (const e of entries) {
    const dec = multiLayerDecode(e.base64);
    if (!dec || dec.urls.length === 0) continue;
    const resolution = parseResolution(e.label);
    const server = parseServerName(e.label);
    for (const url of dec.urls) resolve(url, resolution, server, 0, new Set());
  }

  const final: ResolvedEntry[] = [];
  for (const [url, info] of resolved) {
    if (isVideoUrl(url)) final.push({ url, resolution: info.resolution, server: info.server });
  }
  if (final.length === 0) {
    for (const [url, info] of unresolved) final.push({ url, resolution: info.resolution, server: info.server });
  }
  final.sort((a, b) => {
    const ra = resolutionRank(a.resolution);
    const rb = resolutionRank(b.resolution);
    if (ra !== rb) return rb - ra;
    return a.url.length - b.url.length;
  });
  return final;
}

/* ============================================================
   BUILD OUTPUT — SINGLE EPISODE JSON
   ============================================================ */

/**
 * Build JSON untuk 1 episode — struktur final:
 *   src/data/anime/{slug}/episodes/{number}.json
 *
 * Output:
 *   {
 *     "number": N,
 *     "streams": [
 *       { "quality": "1080p", "servers": [{ "name": "...", "url": "..." }] }
 *     ]
 *   }
 */
function buildJson(items: ResolvedEntry[], episodeNumber: number): string {
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
    (a, b) => resolutionRank(b) - resolutionRank(a)
  );

  const streams = qualities.map((q) => ({
    quality: q,
    servers: byQuality.get(q)!,
  }));

  const payload = {
    number: episodeNumber,
    streams,
  };

  return JSON.stringify(payload, null, 2) + '\n';
}

function buildUrlList(items: ResolvedEntry[], label?: string): string {
  const lines: string[] = [];
  lines.push('🎬 <b>URL Video</b>');
  if (label) lines.push(`🏷️ <code>${escapeHtml(label)}</code>`);
  lines.push(`📊 Total: <b>${items.length}</b>`);
  lines.push('');

  const byRes = new Map<string, ResolvedEntry[]>();
  for (const it of items) {
    const key = it.resolution ?? 'Lainnya';
    if (!byRes.has(key)) byRes.set(key, []);
    byRes.get(key)!.push(it);
  }
  const sortedKeys = [...byRes.keys()].sort((a, b) => resolutionRank(b) - resolutionRank(a));

  let n = 1;
  for (const key of sortedKeys) {
    lines.push(`━━━ ${escapeHtml(key)} ━━━`);
    for (const it of byRes.get(key)!) {
      lines.push(`${n}. <code>${escapeHtml(it.url)}</code>`);
      n++;
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function splitMessage(text: string, budget = MSG_BUDGET): string[] {
  if (text.length <= budget) return [text];
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const prospective = current ? current + '\n' + line : line;
    if (prospective.length > budget && current.length > 0) {
      parts.push(current);
      current = line;
    } else {
      current = prospective;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/* ============================================================
   TELEGRAM DOCUMENT UPLOAD
   ============================================================ */

async function sendDocumentViaApi(
  botToken: string,
  chatId: number,
  filename: string,
  content: string,
  caption: string
): Promise<void> {
  const boundary =
    '----YukioDecode' + Math.random().toString(36).slice(2, 12);

  const encoder = new TextEncoder();
  const CRLF = '\r\n';
  const chunks: Uint8Array[] = [];

  const pushStr = (s: string) => {
    chunks.push(encoder.encode(s));
  };

  pushStr(`--${boundary}${CRLF}`);
  pushStr(`Content-Disposition: form-data; name="chat_id"${CRLF}${CRLF}`);
  pushStr(`${chatId}${CRLF}`);

  pushStr(`--${boundary}${CRLF}`);
  pushStr(`Content-Disposition: form-data; name="caption"${CRLF}${CRLF}`);
  pushStr(`${caption}${CRLF}`);

  pushStr(`--${boundary}${CRLF}`);
  pushStr(`Content-Disposition: form-data; name="parse_mode"${CRLF}${CRLF}`);
  pushStr(`HTML${CRLF}`);

  pushStr(`--${boundary}${CRLF}`);
  pushStr(
    `Content-Disposition: form-data; name="document"; filename="${filename}"${CRLF}`
  );
  pushStr(`Content-Type: application/json; charset=utf-8${CRLF}${CRLF}`);
  chunks.push(encoder.encode(content));
  pushStr(`${CRLF}`);

  pushStr(`--${boundary}--${CRLF}`);

  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendDocument`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `sendDocument HTTP ${res.status}: ${errText.slice(0, 200)}`
    );
  }
}

/**
 * Kirim hasil decode:
 *   1. URL list (inline, sebagai info)
 *   2. JSON — inline <pre> kalau kecil, file .json kalau besar
 *
 * Target save user:
 *   src/data/anime/{slug}/episodes/{number}.json
 */
async function sendResult(
  ctx: Context,
  env: Env,
  items: ResolvedEntry[],
  label: string | undefined,
  sourceLabels: (string | null)[],
  sourceFilename: string | null
): Promise<void> {
  // URL list untuk info
  const urlList = buildUrlList(items, label);
  for (const part of splitMessage(urlList)) {
    await ctx.reply(part, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }

  // Detect nomor episode
  const episodeNumber = parseEpisodeNumber(sourceFilename, sourceLabels);

  // Build JSON (single episode)
  const json = buildJson(items, episodeNumber);

  console.log(
    `[Decode] episode number detected: ${episodeNumber} (json len: ${json.length})`
  );

  const targetPath = `src/data/anime/{slug}/episodes/${episodeNumber}.json`;

  // Kecil → inline <pre>
  if (json.length <= JSON_INLINE_THRESHOLD) {
    await ctx.reply(
      `📋 <b>Episode ${episodeNumber}</b>\n` +
        `<i>Save ke <code>${escapeHtml(targetPath)}</code></i>\n\n` +
        `<pre>${escapeHtml(json)}</pre>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  // Besar → file attachment
  const filename = `ep-${episodeNumber}.json`;

  const caption =
    `📋 <b>Episode ${episodeNumber}</b>\n` +
    `<i>Rename & save ke <code>${escapeHtml(targetPath)}</code></i>`;

  try {
    await sendDocumentViaApi(
      env.TELEGRAM_BOT_TOKEN,
      ctx.chat!.id,
      filename,
      json,
      caption
    );
  } catch (err) {
    console.warn('[Decode] sendDocument failed, fallback inline:', err);
    await ctx.reply(
      `📋 <b>Episode ${episodeNumber}</b>\n\n<pre>${escapeHtml(json)}</pre>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
  }
}

/* ============================================================
   FILE DOWNLOAD
   ============================================================ */

async function downloadByFileId(
  ctx: Context,
  env: Env,
  fileId: string,
  showLoading: boolean
): Promise<string | null> {
  let loadingId: number | null = null;
  if (showLoading) {
    const m = await ctx.reply('📥 Ambil dari Telegram...');
    loadingId = m.message_id;
  }

  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) throw new Error('no file_path');

    const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    let text = await res.text();
    if (text.length > MAX_FILE_CHARS) text = text.slice(0, MAX_FILE_CHARS);

    if (loadingId) {
      await ctx.api.deleteMessage(ctx.chat!.id, loadingId).catch(() => {});
    }
    return text;
  } catch (err: any) {
    const msg = err?.message ?? 'unknown';
    console.error('[Decode] download failed:', msg);
    if (loadingId) {
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loadingId,
          `❌ Gagal ambil file dari Telegram: <code>${escapeHtml(msg)}</code>\n\n` +
            `<i>File mungkin sudah dihapus. Upload ulang ya.</i>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    } else {
      await ctx.reply(
        `❌ Gagal ambil file: <code>${escapeHtml(msg)}</code>`,
        { parse_mode: 'HTML' }
      );
    }
    return null;
  }
}

async function downloadDocText(
  ctx: Context,
  env: Env
): Promise<{ text: string; fileId: string; filename: string } | null> {
  const doc = ctx.message?.document ?? ctx.message?.reply_to_message?.document;
  if (!doc) return null;

  const size = doc.file_size ?? 0;
  if (size > MAX_FILE_BYTES) {
    await ctx.reply(
      `❌ File terlalu besar: <b>${(size / 1024).toFixed(0)} KB</b> (max ${MAX_FILE_BYTES / 1024 / 1024} MB).\n\n<i>Potong dulu HTML-nya.</i>`,
      { parse_mode: 'HTML' }
    );
    return null;
  }

  const name = doc.file_name ?? '';
  const mime = doc.mime_type ?? '';
  const ok = /\.(html?|txt|json|js|css)$/i.test(name) || /^text\/|json|javascript/i.test(mime);
  if (!ok) {
    await ctx.reply(`❌ Tipe tidak didukung: <code>${escapeHtml(name || mime)}</code>`, { parse_mode: 'HTML' });
    return null;
  }

  const loading = await ctx.reply('📥 Download file...');
  try {
    const file = await ctx.api.getFile(doc.file_id);
    if (!file.file_path) throw new Error('no file_path');

    const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    let text = await res.text();
    if (text.length > MAX_FILE_CHARS) text = text.slice(0, MAX_FILE_CHARS);
    await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
    return { text, fileId: doc.file_id, filename: name || 'unnamed' };
  } catch (err: any) {
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Error download: ${escapeHtml(err?.message ?? 'unknown')}`
      )
      .catch(() => {});
    return null;
  }
}

function processText(
  input: string,
  sourceType: 'base64' | 'html'
): { videos: ResolvedEntry[]; labels: (string | null)[] } | null {
  const entries =
    sourceType === 'html'
      ? extractEntries(input)
      : [{ base64: input, label: null }];
  if (entries.length === 0) return null;
  const videos = collectResolvedVideos(entries);
  if (videos.length === 0) return null;
  const labels = entries.map((e) => e.label);
  return { videos, labels };
}

/* ============================================================
   PUBLIC HANDLERS
   ============================================================ */

export async function handleDocumentAuto(ctx: Context, env: Env): Promise<void> {
  const result = await downloadDocText(ctx, env);
  if (!result) return;

  const { text, fileId, filename } = result;
  const sourceType: 'base64' | 'html' = looksLikeHtml(text) ? 'html' : 'base64';

  const loading = await ctx.reply('🌐 Proses...');
  try {
    const processed = processText(text, sourceType);
    if (!processed) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        '❌ Tidak ada URL video yang bisa diekstrak.'
      );
      return;
    }

    const { videos, labels } = processed;
    const label = slugify(filename);
    const { replaced } = await saveFileRef(env.DB, label, filename, fileId);

    await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});

    await ctx.reply(
      replaced
        ? `♻️ Update: <code>${escapeHtml(label)}</code>`
        : `💾 Tersimpan: <code>${escapeHtml(label)}</code>`,
      { parse_mode: 'HTML' }
    );

    await sendResult(ctx, env, videos, label, labels, filename);

    await ctx.reply(
      `💡 Akses lagi: <code>/decode ${escapeHtml(label)}</code>`,
      { parse_mode: 'HTML' }
    );
  } catch (err: any) {
    console.error('[Decode] auto error:', err);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Error: ${escapeHtml(err?.message ?? 'unknown')}`
      )
      .catch(() => {});
  }
}

interface ProxyResponse {
  ok: boolean;
  status: number;
  body?: string;
  error?: string;
  truncated?: boolean;
}

async function fetchUrlViaProxy(
  env: Env,
  url: string
): Promise<string | null> {
  try {
    const res = await fetch(env.VAL_TOWN_FETCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      console.warn(`[Decode] proxy HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as ProxyResponse;

    if (!data.ok || !data.body) {
      console.warn(`[Decode] target HTTP ${data.status}: ${data.error ?? ''}`);
      return null;
    }

    console.log(
      `[Decode] fetched ${data.body.length} chars (truncated: ${data.truncated ?? false})`
    );

    return data.body;
  } catch (err) {
    console.warn('[Decode] proxy fetch failed:', err);
    return null;
  }
}

async function handleUrlAuto(
  ctx: Context,
  env: Env,
  url: string
): Promise<void> {
  const loading = await ctx.reply(
    `🌐 Fetch URL:\n<code>${escapeHtml(url)}</code>`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );

  try {
    const html = await fetchUrlViaProxy(env, url);
    if (!html) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        '❌ Gagal fetch URL.\n\n' +
          '<i>Kemungkinan:</i>\n' +
          '• Situs memblokir bot\n' +
          '• Situs butuh JS render (SPA)\n' +
          '• Situs down / timeout\n' +
          '• URL tidak valid',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const sourceType: 'base64' | 'html' = looksLikeHtml(html) ? 'html' : 'base64';
    const processed = processText(html, sourceType);

    if (!processed) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Tidak ada URL video yang bisa diekstrak.\n\n<i>Panjang HTML: ${html.length} char</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});

    const urlSlug = slugify(
      url.split('/').filter(Boolean).pop() ?? 'url'
    );

    await sendResult(
      ctx,
      env,
      processed.videos,
      urlSlug,
      processed.labels,
      null
    );
  } catch (err: any) {
    console.error('[Decode] url error:', err);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Error: ${escapeHtml(err?.message ?? 'unknown')}`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
}

export const decodeCommand: CommandDefinition = {
  name: 'decode',
  description: 'Decode HTML/Base64 atau buka tersimpan',
  usage: '/decode <base64|html|label>',
  adminOnly: true,

  handler: async (ctx, env) => {
    const doc = ctx.message?.document ?? ctx.message?.reply_to_message?.document;
    if (doc) {
      await handleDocumentAuto(ctx, env);
      return;
    }

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const replied = ctx.message?.reply_to_message?.text ?? '';
    const input = arg || replied;

    if (!input) {
      await ctx.reply(
        '<b>🔓 Decode</b>\n\n' +
          '<b>Kirim file</b> <code>.html</code> / <code>.txt</code> → auto proses + simpan\n' +
          '<b>One-shot:</b> <code>/decode &lt;base64&gt;</code>\n' +
          '<b>Buka tersimpan:</b> <code>/decode &lt;label&gt;</code>\n' +
          '<b>List:</b> <code>/list</code>\n' +
          '<b>Hapus:</b> <code>/delete &lt;label&gt;</code>',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    if (!looksLikeHtml(input) && !isLikelyBase64(input) && input.length < 60) {
      const ref = await getFileRef(env.DB, input);
      if (ref) {
        const text = await downloadByFileId(ctx, env, ref.file_id, true);
        if (!text) return;

        const sourceType: 'base64' | 'html' = looksLikeHtml(text) ? 'html' : 'base64';
        const loading = await ctx.reply('🌐 Proses...');
        try {
          const processed = processText(text, sourceType);
          if (!processed) {
            await ctx.api.editMessageText(
              ctx.chat!.id,
              loading.message_id,
              '❌ Tidak ada URL video yang bisa diekstrak.'
            );
            return;
          }
          await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await sendResult(
            ctx,
            env,
            processed.videos,
            ref.label,
            processed.labels,
            ref.filename
          );
        } catch (err: any) {
          await ctx.api
            .editMessageText(
              ctx.chat!.id,
              loading.message_id,
              `❌ Error: ${escapeHtml(err?.message ?? 'unknown')}`
            )
            .catch(() => {});
        }
        return;
      }
    }
    
    if (/^https?:\/\//i.test(input)) {
      await handleUrlAuto(ctx, env, input);
      return;
    }

    if (input.length > MAX_INPUT_LEN) {
      await ctx.reply(`❌ Terlalu panjang: ${input.length} char. Kirim sebagai file.`, { parse_mode: 'HTML' });
      return;
    }

    const sourceType: 'base64' | 'html' = looksLikeHtml(input) ? 'html' : 'base64';
    const loading = await ctx.reply('🔓 Proses...');
    try {
      const processed = processText(input, sourceType);
      if (!processed) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          loading.message_id,
          '❌ Tidak ada URL video yang bisa diekstrak.'
        );
        return;
      }
      await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
      await sendResult(ctx, env, processed.videos, undefined, processed.labels, null);
    } catch (err: any) {
      console.error('[Decode] error:', err);
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ Error: ${escapeHtml(err?.message ?? 'unknown')}`
        )
        .catch(() => {});
    }
  },
};

export const listCommand: CommandDefinition = {
  name: 'list',
  description: 'Lihat file referensi tersimpan',
  usage: '/list',
  adminOnly: true,

  handler: async (ctx, env) => {
    const rows = await listFileRefs(env.DB, 30);
    if (rows.length === 0) {
      await ctx.reply('📭 Belum ada file tersimpan.\n\n<i>Kirim file .html/.txt ke bot untuk mulai.</i>', {
        parse_mode: 'HTML',
      });
      return;
    }

    const lines: string[] = [];
    lines.push(`📚 <b>File Tersimpan (${rows.length})</b>\n`);
    for (const r of rows) {
      const days = Math.floor((Date.now() - r.last_accessed) / 86400000);
      const age = days === 0 ? 'hari ini' : days === 1 ? '1 hari lalu' : `${days} hari lalu`;
      const fname = r.filename ? ` — <i>${escapeHtml(r.filename)}</i>` : '';
      lines.push(`• <code>${escapeHtml(r.label)}</code>${fname} — <i>${age}</i>`);
    }
    lines.push('');
    lines.push('<i>Buka ulang: <code>/decode &lt;label&gt;</code></i>');

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  },
};

export const deleteCommand: CommandDefinition = {
  name: 'delete',
  description: 'Hapus referensi file',
  usage: '/delete <label>',
  adminOnly: true,

  handler: async (ctx, env) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (!arg) {
      await ctx.reply('Usage: <code>/delete &lt;label&gt;</code>', { parse_mode: 'HTML' });
      return;
    }

    const ok = await deleteFileRef(env.DB, arg);
    if (ok) {
      await ctx.reply(
        `✅ <code>${escapeHtml(arg)}</code> dihapus dari DB.\n\n<i>File HTML di Telegram tetap ada.</i>`,
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.reply(`❌ Tidak ada: <code>${escapeHtml(arg)}</code>`, { parse_mode: 'HTML' });
    }
  },
};
