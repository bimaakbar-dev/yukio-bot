import type { CommandDefinition } from './registry';
import type { Context, Bot } from 'grammy';
import type { Env } from '../types/env';
import { InlineKeyboard } from 'grammy';
import type { D1Database } from '@cloudflare/workers-types';

/* ═══════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════ */

const MAX_INPUT_LEN = 8000;
const MAX_FILE_CHARS = 300_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LAYERS = 5;
const MAX_CANDIDATES = 800;
const MAX_PARAM_DEPTH = 3;
const PAGE_CHAR_BUDGET = 3500;
const YAML_CHAR_BUDGET = 3500;
const SESSION_TTL_MS = 60 * 60 * 1000;

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
  abyss: 'abyss',
  dodo: 'doply',
  doply: 'doply',
  pixel: 'pixeldrain',
  pixeldrain: 'pixeldrain',
  viking: 'vikingfile',
  vikingfile: 'vikingfile',
  mix: 'mixdrop',
  mixdrop: 'mixdrop',
  buzi: 'buzzheavier',
  buzzheavier: 'buzzheavier',
  mp4: 'mp4upload',
  mp4upload: 'mp4upload',
  mega: 'mega',
  lokal: 'lokal',
  kamado: 'kamado',
  pancal: 'pancal',
};

/* ═══════════════════════════════════════════════
   DB
   ═══════════════════════════════════════════════ */

let dbReady = false;
let dbInitPromise: Promise<void> | null = null;

async function ensureDb(db: D1Database): Promise<void> {
  if (dbReady) return;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS temp_decode (
            session_id  TEXT PRIMARY KEY,
            chat_id     INTEGER NOT NULL,
            user_id     INTEGER NOT NULL,
            pages       TEXT NOT NULL,
            total       INTEGER NOT NULL,
            page_count  INTEGER NOT NULL,
            created_at  INTEGER NOT NULL,
            expires_at  INTEGER NOT NULL
          )`
        )
        .run();

      await db
        .prepare('CREATE INDEX IF NOT EXISTS idx_temp_expires ON temp_decode(expires_at)')
        .run();

      await db
        .prepare('CREATE INDEX IF NOT EXISTS idx_temp_chat ON temp_decode(chat_id)')
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

/* ═══════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════ */

interface PageItem {
  url: string;
  resolution: string | null;
  server: string | null;
}

interface TempSession {
  session_id: string;
  user_id: number;
  pages: PageItem[][];
  total: number;
  page_count: number;
}

interface RawEntry {
  base64: string;
  label: string | null;
}

interface ResolvedEntry {
  url: string;
  resolution: string | null;
  server: string | null;
}

/* ═══════════════════════════════════════════════
   SESSION
   ═══════════════════════════════════════════════ */

async function createSession(
  db: D1Database,
  chatId: number,
  userId: number,
  pages: PageItem[][]
): Promise<string> {
  await ensureDb(db);

  const sessionId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const now = Date.now();
  const total = pages.reduce((s, p) => s + p.length, 0);

  await db
    .prepare(
      `INSERT INTO temp_decode
         (session_id, chat_id, user_id, pages, total, page_count, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      chatId,
      userId,
      JSON.stringify(pages),
      total,
      pages.length,
      now,
      now + SESSION_TTL_MS
    )
    .run();

  return sessionId;
}

async function getSession(
  db: D1Database,
  sessionId: string
): Promise<TempSession | null> {
  await ensureDb(db);

  const row = await db
    .prepare(
      'SELECT session_id, user_id, pages, total, page_count, expires_at FROM temp_decode WHERE session_id = ?'
    )
    .bind(sessionId)
    .first<{
      session_id: string;
      user_id: number;
      pages: string;
      total: number;
      page_count: number;
      expires_at: number;
    }>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM temp_decode WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }

  return {
    session_id: row.session_id,
    user_id: row.user_id,
    pages: JSON.parse(row.pages),
    total: row.total,
    page_count: row.page_count,
  };
}

async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM temp_decode WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.error('[Decode] delete error:', err);
  }
}

/* ═══════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════ */

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
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', {
      fatal: false,
      ignoreBOM: false,
    }).decode(bytes);
  } catch {
    return null;
  }
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
    /<!DOCTYPE/i.test(s) ||
    /<html[\s>]/i.test(s) ||
    /<script[\s>]/i.test(s) ||
    /<iframe[\s>]/i.test(s) ||
    /<\/?[a-z][a-z0-9-]*[\s>]/i.test(s)
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
  } catch {
    return false;
  }
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

/* ═══════════════════════════════════════════════
   URL EXTRACTION
   ═══════════════════════════════════════════════ */

function extractUrlsFromDecoded(s: string): string[] {
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

function expandUrlParams(url: string, depth = 0): string[] {
  const out = new Set<string>([url]);
  if (depth > MAX_PARAM_DEPTH) return [...out];

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [...out];
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
      } catch {
        /* ignore */
      }
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

/* ═══════════════════════════════════════════════
   RESOLVE
   ═══════════════════════════════════════════════ */

function collectResolvedVideos(entries: RawEntry[]): ResolvedEntry[] {
  const resolved = new Map<string, { resolution: string | null; server: string | null }>();
  const unresolved = new Map<string, { resolution: string | null; server: string | null }>();

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
    for (const url of dec.urls) {
      resolve(url, resolution, server, 0, new Set());
    }
  }

  const final: ResolvedEntry[] = [];
  for (const [url, info] of resolved) {
    if (isVideoUrl(url)) {
      final.push({ url, resolution: info.resolution, server: info.server });
    }
  }

  if (final.length === 0) {
    for (const [url, info] of unresolved) {
      final.push({ url, resolution: info.resolution, server: info.server });
    }
  }

  final.sort((a, b) => {
    const ra = resolutionRank(a.resolution);
    const rb = resolutionRank(b.resolution);
    if (ra !== rb) return rb - ra;
    return a.url.length - b.url.length;
  });

  return final;
}

/* ═══════════════════════════════════════════════
   PAGINATION
   ═══════════════════════════════════════════════ */

function paginate(items: ResolvedEntry[], budget = PAGE_CHAR_BUDGET): PageItem[][] {
  const pages: PageItem[][] = [];
  let cur: PageItem[] = [];
  let curLen = 0;

  for (const item of items) {
    const lineLen = item.url.length + 20;
    if (curLen + lineLen > budget && cur.length > 0) {
      pages.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push({ url: item.url, resolution: item.resolution, server: item.server });
    curLen += lineLen;
  }
  if (cur.length > 0) pages.push(cur);
  return pages.length > 0 ? pages : [[]];
}

/* ═══════════════════════════════════════════════
   YAML BUILDER
   ═══════════════════════════════════════════════ */

function buildYaml(items: PageItem[]): string {
  const byQuality = new Map<string, { name: string; url: string }[]>();

  for (const item of items) {
    const q = item.resolution ?? 'Unknown';
    if (!byQuality.has(q)) byQuality.set(q, []);
    byQuality.get(q)!.push({ name: item.server ?? 'unknown', url: item.url });
  }

  const qualities = [...byQuality.keys()].sort(
    (a, b) => resolutionRank(b) - resolutionRank(a)
  );

  const lines: string[] = [];
  lines.push('episodes:');
  lines.push('  - number: 1');
  lines.push('    streams:');

  for (const q of qualities) {
    lines.push(`      - quality: "${q}"`);
    lines.push('        servers:');
    for (const s of byQuality.get(q)!) {
      lines.push(`          - name: "${s.name}"`);
      lines.push(`            url: "${s.url}"`);
    }
  }

  return lines.join('\n');
}

function paginateYaml(yaml: string, budget = YAML_CHAR_BUDGET): string[] {
  if (yaml.length <= budget) return [yaml];
  const lines = yaml.split('\n');
  const pages: string[] = [];
  let cur: string[] = [];
  let curLen = 0;

  for (const line of lines) {
    if (curLen + line.length + 1 > budget && cur.length > 0) {
      pages.push(cur.join('\n'));
      cur = [];
      curLen = 0;
    }
    cur.push(line);
    curLen += line.length + 1;
  }
  if (cur.length > 0) pages.push(cur.join('\n'));
  return pages;
}

/* ═══════════════════════════════════════════════
   RENDER
   ═══════════════════════════════════════════════ */

function summaryByResolution(items: ResolvedEntry[]): string {
  const counts = new Map<string, number>();
  for (const it of items) {
    const key = it.resolution ?? 'Lainnya';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => {
    const ra = resolutionRank(a[0]);
    const rb = resolutionRank(b[0]);
    return rb - ra;
  });
  return sorted.map(([res, n]) => `${res} (${n})`).join(' · ');
}

function renderPage(opts: {
  sessionId: string;
  pageIdx: number;
  pageCount: number;
  items: PageItem[];
  total: number;
  offset: number;
  summary: string;
}): { text: string; keyboard: InlineKeyboard } {
  const { sessionId, pageIdx, pageCount, items, total, offset, summary } = opts;

  const lines: string[] = [];
  lines.push('🎬 <b>URL Video</b>');
  lines.push('');
  lines.push(`Total: <b>${total}</b>  ·  Halaman <b>${pageIdx + 1}/${pageCount}</b>`);
  if (summary) lines.push(`📊 ${summary}`);
  lines.push('');

  let lastRes: string | null | undefined = undefined;
  items.forEach((item, i) => {
    const res = item.resolution;
    if (res !== lastRes) {
      if (lastRes !== undefined) lines.push('');
      lines.push(`━━━ ${res ? escapeHtml(res) : 'Lainnya'} ━━━`);
      lastRes = res;
    }
    lines.push(`${offset + i + 1}. <code>${escapeHtml(item.url)}</code>`);
  });

  const kb = new InlineKeyboard();

  if (pageIdx > 0) kb.text('⬅ Prev', `dc:p:${sessionId}:${pageIdx - 1}`);
  else kb.text('·', 'dc:noop');
  kb.text(`${pageIdx + 1}/${pageCount}`, 'dc:noop');
  if (pageIdx < pageCount - 1) kb.text('Next ➡', `dc:p:${sessionId}:${pageIdx + 1}`);
  else kb.text('·', 'dc:noop');
  kb.row();

  kb.text('📋 YAML', `dc:y:${sessionId}`);
  kb.text('✅ Selesai', `dc:x:${sessionId}`);
  kb.row();

  items.slice(0, 3).forEach((item, i) => {
    if (item.url.length < 1900) {
      const icon = item.resolution ? `🎬 ${item.resolution}` : `🎬 ${offset + i + 1}`;
      kb.url(icon, item.url);
      if ((i + 1) % 3 === 0) kb.row();
    }
  });

  return { text: lines.join('\n'), keyboard: kb };
}

/* ═══════════════════════════════════════════════
   PROCESS INPUT
   ═══════════════════════════════════════════════ */

async function processInput(
  ctx: Context,
  env: Env,
  input: string,
  sourceType: 'base64' | 'html'
): Promise<void> {
  const loading = await ctx.reply(
    sourceType === 'html' ? '🌐 Proses HTML...' : '🔓 Proses Base64...'
  );

  try {
    const entries =
      sourceType === 'html'
        ? extractEntries(input)
        : [{ base64: input, label: null }];

    if (entries.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        '❌ Tidak ada Base64 yang ditemukan.'
      );
      return;
    }

    const videos = collectResolvedVideos(entries);

    if (videos.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Tidak ada URL video.\n\n<i>Dari ${entries.length} kandidat, tidak ada URL video valid.</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const pages = paginate(videos);
    const summary = summaryByResolution(videos);
    const sessionId = await createSession(
      env.DB,
      ctx.chat!.id,
      ctx.from!.id,
      pages
    );

    await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});

    const { text, keyboard } = renderPage({
      sessionId,
      pageIdx: 0,
      pageCount: pages.length,
      items: pages[0] ?? [],
      total: videos.length,
      offset: 0,
      summary,
    });

    await ctx.reply(text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    });
  } catch (err: any) {
    console.error('[Decode] process error:', err);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Error: ${escapeHtml(err?.message ?? 'unknown')}`
      )
      .catch(() => {});
  }
}

/* ═══════════════════════════════════════════════
   DOWNLOAD FILE
   ═══════════════════════════════════════════════ */

async function downloadDocText(ctx: Context, env: Env): Promise<string | null> {
  const doc = ctx.message?.document ?? ctx.message?.reply_to_message?.document;
  if (!doc) return null;

  const size = doc.file_size ?? 0;
  if (size > MAX_FILE_BYTES) {
    await ctx.reply(`❌ File terlalu besar: <b>${(size / 1024).toFixed(0)} KB</b>.`, {
      parse_mode: 'HTML',
    });
    return null;
  }

  const name = doc.file_name ?? '';
  const mime = doc.mime_type ?? '';
  const ok =
    /\.(html?|txt|json|js|css)$/i.test(name) ||
    /^text\/|json|javascript/i.test(mime);
  if (!ok) {
    await ctx.reply(`❌ Tipe tidak didukung: <code>${escapeHtml(name || mime)}</code>`, {
      parse_mode: 'HTML',
    });
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
    return text;
  } catch (err: any) {
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Error: ${escapeHtml(err?.message ?? 'unknown')}`
      )
      .catch(() => {});
    return null;
  }
}

/* ═══════════════════════════════════════════════
   AUTO HANDLER
   ═══════════════════════════════════════════════ */

export async function handleDocumentAuto(ctx: Context, env: Env): Promise<void> {
  const text = await downloadDocText(ctx, env);
  if (!text) return;

  if (looksLikeHtml(text)) {
    await processInput(ctx, env, text, 'html');
  } else if (isLikelyBase64(text)) {
    await processInput(ctx, env, text.trim(), 'base64');
  } else {
    await processInput(ctx, env, text, 'html');
  }
}

/* ═══════════════════════════════════════════════
   CALLBACKS
   ═══════════════════════════════════════════════ */

export function setupDecodeCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^dc:p:([a-f0-9]+):(\d+)$/, async (ctx) => {
    const [, sessionId, pageStr] = ctx.match as RegExpMatchArray;
    const pageIdx = parseInt(pageStr ?? '0', 10);
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌ Session tidak valid' });
      return;
    }

    const session = await getSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Session kadaluarsa. Kirim ulang file.',
        show_alert: true,
      });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return;
    }

    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }

    if (pageIdx < 0 || pageIdx >= session.page_count) {
      await ctx.answerCallbackQuery({ text: '❌ Halaman tidak ada' });
      return;
    }

    let offset = 0;
    for (let i = 0; i < pageIdx; i++) offset += session.pages[i]?.length ?? 0;

    const allItems: ResolvedEntry[] = session.pages.flat().map((p) => ({
      url: p.url,
      resolution: p.resolution,
      server: p.server,
    }));
    const summary = summaryByResolution(allItems);

    const { text, keyboard } = renderPage({
      sessionId,
      pageIdx,
      pageCount: session.page_count,
      items: session.pages[pageIdx] ?? [],
      total: session.total,
      offset,
      summary,
    });

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^dc:y:([a-f0-9]+)$/, async (ctx) => {
    const [, sessionId] = ctx.match as RegExpMatchArray;
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌ Session tidak valid' });
      return;
    }

    const session = await getSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: '⏱️ Session kadaluarsa.', show_alert: true });
      return;
    }

    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }

    const allItems: PageItem[] = session.pages.flat();
    const yaml = buildYaml(allItems);
    const parts = paginateYaml(yaml);

    await ctx.answerCallbackQuery({ text: '📋 Generate YAML...' });

    for (let i = 0; i < parts.length; i++) {
      const header =
        parts.length > 1
          ? `📋 <b>YAML Streams</b> (part ${i + 1}/${parts.length})\n\n`
          : '📋 <b>YAML Streams</b>\n\n';
      const footer = i === parts.length - 1 ? '\n\n<i>Tap code block untuk copy.</i>' : '';

      await ctx.reply(header + `<pre>${escapeHtml(parts[i] ?? '')}</pre>` + footer, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    }
  });

  bot.callbackQuery(/^dc:x:([a-f0-9]+)$/, async (ctx) => {
    const [, sessionId] = ctx.match as RegExpMatchArray;
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌ Session tidak valid' });
      return;
    }

    const session = await getSession(env.DB, sessionId);
    if (session && ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }

    await deleteSession(env.DB, sessionId);

    await ctx
      .editMessageText('✅ <b>Selesai</b> — data sudah dihapus dari DB.', {
        parse_mode: 'HTML',
        reply_markup: undefined,
      })
      .catch(() => {});

    await ctx.answerCallbackQuery({ text: '🗑️ Session dihapus' });
  });

  bot.callbackQuery('dc:noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });
}

/* ═══════════════════════════════════════════════
   COMMAND
   ═══════════════════════════════════════════════ */

export const decodeCommand: CommandDefinition = {
  name: 'decode',
  description: 'Decode HTML/Base64 → URL video',
  usage: '/decode base64-atau-html',
  adminOnly: true,

  handler: async (ctx, env) => {
    const doc = ctx.message?.document ?? ctx.message?.reply_to_message?.document;
    if (doc) {
      const text = await downloadDocText(ctx, env);
      if (!text) return;
      if (looksLikeHtml(text)) {
        await processInput(ctx, env, text, 'html');
      } else if (isLikelyBase64(text)) {
        await processInput(ctx, env, text.trim(), 'base64');
      } else {
        await processInput(ctx, env, text, 'html');
      }
      return;
    }

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const replied = ctx.message?.reply_to_message?.text ?? '';
    const input = arg || replied;

    if (!input) {
      await ctx.reply(
        '<b>🔓 Decode → URL Video</b>\n\n' +
          '<b>Mode teks:</b> <code>/decode aHR0cHM6...</code>\n' +
          '<b>Mode reply:</b> reply ke pesan → /decode\n' +
          '<b>Mode file:</b> kirim .html/.txt → auto proses\n\n' +
          '<b>Tombol:</b>\n' +
          '📋 YAML — generate untuk copy ke .md\n' +
          '✅ Selesai — hapus session',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    if (input.length > MAX_INPUT_LEN) {
      await ctx.reply(`❌ Terlalu panjang: ${input.length} char. Kirim sebagai file.`, {
        parse_mode: 'HTML',
      });
      return;
    }

    if (looksLikeHtml(input)) {
      await processInput(ctx, env, input, 'html');
    } else {
      await processInput(ctx, env, input, 'base64');
    }
  },
};