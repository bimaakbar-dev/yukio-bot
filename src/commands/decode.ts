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
const MAX_PARAM_DEPTH = 2;
const PAGE_CHAR_BUDGET = 3500;
const SESSION_TTL_MS = 60 * 60 * 1000;

const BASE64_PARAM_NAMES = new Set([
  'bsrc', 'src', 'url', 'link', 'u', 'q', 'data',
  'em', 'embed', 'target', 'id', 'file', 'video',
]);

const VIDEO_EXT_RE = /\.(mp4|m3u8|mkv|webm|ts|mov)(\?|#|$)/i;
const VIDEO_HOSTS = [
  'player.', 'streamtape', 'dood', 'filemoon', 'voe', 'mp4upload',
  'mixdrop', 'abyss', 'framezi', 'kturb', 'pixeldrain', 'vikingfile',
  'buzzheavier', 'mega.nz', 'doply',
];

/* ═══════════════════════════════════════════════
   DB: AUTO-CREATE TABLE (idempotent, dijalankan sekali per isolate)
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
        .prepare(
          'CREATE INDEX IF NOT EXISTS idx_temp_expires ON temp_decode(expires_at)'
        )
        .run();

      await db
        .prepare(
          'CREATE INDEX IF NOT EXISTS idx_temp_chat ON temp_decode(chat_id)'
        )
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
   SESSION HELPERS (inline)
   ═══════════════════════════════════════════════ */

interface TempSession {
  session_id: string;
  user_id: number;
  pages: string[][];
  total: number;
  page_count: number;
}

async function createSession(
  db: D1Database,
  chatId: number,
  userId: number,
  pages: string[][]
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

async function deleteSession(
  db: D1Database,
  sessionId: string
): Promise<void> {
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

  for (const m of cleaned.matchAll(
    /<iframe\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi
  )) {
    const u = htmlDecode(m[1] ?? '');
    if (/^https?:\/\//i.test(u)) found.add(u);
  }

  if (found.size === 0) {
    for (const m of cleaned.matchAll(
      /src\s*=\s*["'](https?:\/\/[^"']+)["']/gi
    )) {
      const u = htmlDecode(m[1] ?? '');
      if (u) found.add(u);
    }
  }

  if (found.size === 0) {
    for (const m of cleaned.matchAll(
      /href\s*=\s*["'](https?:\/\/[^"']+)["']/gi
    )) {
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

    if (isLikelyBase64(value)) {
      const decoded = decodeBase64(value);
      if (decoded && isPrintable(decoded)) {
        const trimmed = decoded.trim();
        if (/^https?:\/\//i.test(trimmed)) {
          for (const sub of expandUrlParams(trimmed, depth + 1)) out.add(sub);
        }
      }
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

function extractBase64Candidates(html: string): string[] {
  const found = new Map<string, number>();

  for (const m of html.matchAll(
    /atob\s*\(\s*["']([A-Za-z0-9+/=\-_]{16,})["']\s*\)/gi
  )) {
    const c = m[1];
    if (c && !found.has(c)) found.set(c, 1);
  }

  for (const m of html.matchAll(
    /data-[a-z0-9-]+\s*=\s*["']([A-Za-z0-9+/=\-_]{20,})["']/gi
  )) {
    const c = m[1];
    if (c && !found.has(c)) found.set(c, 2);
  }

  for (const m of html.matchAll(/[A-Za-z0-9+/\-_]{24,}={0,2}/g)) {
    if (found.size >= MAX_CANDIDATES) break;
    const c = m[0];
    if (c && !found.has(c)) found.set(c, 3);
  }

  return [...found.entries()]
    .sort((a, b) => a[1] - b[1] || b[0].length - a[0].length)
    .map(([c]) => c);
}

function collectVideoUrls(candidates: string[]): string[] {
  const videos = new Set<string>();

  for (const raw of candidates) {
    const res = multiLayerDecode(raw);
    if (!res || res.urls.length === 0) continue;

    for (const url of res.urls) {
      if (isVideoUrl(url)) videos.add(url);
      for (const expanded of expandUrlParams(url)) {
        if (expanded !== url && isVideoUrl(expanded)) videos.add(expanded);
      }
    }
  }

  return [...videos];
}

function paginate(urls: string[], budget = PAGE_CHAR_BUDGET): string[][] {
  const pages: string[][] = [];
  let cur: string[] = [];
  let curLen = 0;

  urls.forEach((url, i) => {
    const lineLen = `${i + 1}. <code>${url}</code>\n`.length;
    if (curLen + lineLen > budget && cur.length > 0) {
      pages.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(url);
    curLen += lineLen;
  });
  if (cur.length > 0) pages.push(cur);
  return pages.length > 0 ? pages : [[]];
}

/* ═══════════════════════════════════════════════
   RENDER HALAMAN
   ═══════════════════════════════════════════════ */

function renderPage(opts: {
  sessionId: string;
  pageIdx: number;
  pageCount: number;
  urls: string[];
  total: number;
  offset: number;
}): { text: string; keyboard: InlineKeyboard } {
  const { sessionId, pageIdx, pageCount, urls, total, offset } = opts;

  const lines: string[] = [];
  lines.push('🎬 <b>URL Video</b>');
  lines.push('');
  lines.push(
    `Total: <b>${total}</b>  ·  Halaman <b>${pageIdx + 1}/${pageCount}</b>`
  );
  lines.push('');

  urls.forEach((u, i) => {
    lines.push(`${offset + i + 1}. <code>${escapeHtml(u)}</code>`);
  });

  const kb = new InlineKeyboard();

  if (pageIdx > 0) {
    kb.text('⬅ Prev', `dc:p:${sessionId}:${pageIdx - 1}`);
  } else {
    kb.text('·', 'dc:noop');
  }
  kb.text(`${pageIdx + 1}/${pageCount}`, 'dc:noop');
  if (pageIdx < pageCount - 1) {
    kb.text('Next ➡', `dc:p:${sessionId}:${pageIdx + 1}`);
  } else {
    kb.text('·', 'dc:noop');
  }
  kb.row();

  kb.text('✅ Selesai & Hapus', `dc:x:${sessionId}`).row();

  urls.slice(0, 3).forEach((u, i) => {
    if (u.length < 1900) {
      kb.url(`🎬 Buka ${offset + i + 1}`, u);
      if ((i + 1) % 3 === 0) kb.row();
    }
  });

  return { text: lines.join('\n'), keyboard: kb };
}

/* ═══════════════════════════════════════════════
   PROSES INPUT
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
    const candidates =
      sourceType === 'html' ? extractBase64Candidates(input) : [input];

    if (candidates.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        '❌ Tidak ada Base64 yang ditemukan.'
      );
      return;
    }

    const videos = collectVideoUrls(candidates);

    if (videos.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Tidak ada URL video.\n\n` +
          `<i>Dari ${candidates.length} kandidat Base64, ` +
          `tidak ada yang decode ke URL video.</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const pages = paginate(videos);
    const sessionId = await createSession(
      env.DB,
      ctx.chat!.id,
      ctx.from!.id,
      pages
    );

    await ctx.api
      .deleteMessage(ctx.chat!.id, loading.message_id)
      .catch(() => {});

    const { text, keyboard } = renderPage({
      sessionId,
      pageIdx: 0,
      pageCount: pages.length,
      urls: pages[0] ?? [],
      total: videos.length,
      offset: 0,
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

async function downloadDocText(
  ctx: Context,
  env: Env
): Promise<string | null> {
  const doc =
    ctx.message?.document ?? ctx.message?.reply_to_message?.document;
  if (!doc) return null;

  const size = doc.file_size ?? 0;
  if (size > MAX_FILE_BYTES) {
    await ctx.reply(
      `❌ File terlalu besar: <b>${(size / 1024).toFixed(0)} KB</b>.`,
      { parse_mode: 'HTML' }
    );
    return null;
  }

  const name = doc.file_name ?? '';
  const mime = doc.mime_type ?? '';
  const ok =
    /\.(html?|txt|json|js|css)$/i.test(name) ||
    /^text\/|json|javascript/i.test(mime);
  if (!ok) {
    await ctx.reply(
      `❌ Tipe tidak didukung: <code>${escapeHtml(name || mime)}</code>`,
      { parse_mode: 'HTML' }
    );
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
    await ctx.api
      .deleteMessage(ctx.chat!.id, loading.message_id)
      .catch(() => {});
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
   AUTO HANDLER (untuk index.ts)
   ═══════════════════════════════════════════════ */

export async function handleDocumentAuto(
  ctx: Context,
  env: Env
): Promise<void> {
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
   CALLBACK HANDLERS
   ═══════════════════════════════════════════════ */

export function setupDecodeCallbacks(bot: Bot, env: Env): void {
  // Pagination
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
      await ctx
        .editMessageReplyMarkup({ reply_markup: undefined })
        .catch(() => {});
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
    for (let i = 0; i < pageIdx; i++) {
      offset += session.pages[i]?.length ?? 0;
    }

    const { text, keyboard } = renderPage({
      sessionId,
      pageIdx,
      pageCount: session.page_count,
      urls: session.pages[pageIdx] ?? [],
      total: session.total,
      offset,
    });

    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery();
  });

  // Selesai & hapus
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

  // Noop
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
    const doc =
      ctx.message?.document ?? ctx.message?.reply_to_message?.document;
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
          '<i>Hanya URL video yang ditampilkan.\n' +
          'Buffer sementara di DB (1 jam), auto-hapus setelah klik ✅.</i>',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    if (input.length > MAX_INPUT_LEN) {
      await ctx.reply(
        `❌ Terlalu panjang: ${input.length} char. Kirim sebagai file.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (looksLikeHtml(input)) {
      await processInput(ctx, env, input, 'html');
    } else {
      await processInput(ctx, env, input, 'base64');
    }
  },
};