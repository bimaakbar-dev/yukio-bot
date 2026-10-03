import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import type { Env } from '../types/env';
import { InlineKeyboard } from 'grammy';

const MAX_INPUT_LEN = 8000;
const MAX_FILE_CHARS = 300_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LAYERS = 5;
const MAX_URLS_SHOWN = 15;
const MAX_CANDIDATES = 800;
const MAX_PARAM_DEPTH = 2;

const BASE64_PARAM_NAMES = new Set([
  'bsrc', 'src', 'url', 'link', 'u', 'q', 'data',
  'em', 'embed', 'target', 'id', 'file', 'video',
]);

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

/* ─────────────────────────────────────────────
   EXTRACT URL DARI HASIL DECODE
   ───────────────────────────────────────────── */

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

/* ─────────────────────────────────────────────
   EXPAND QUERY PARAMS (bsrc, url, dll)
   ───────────────────────────────────────────── */

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
    const keyLower = key.toLowerCase();
    if (!BASE64_PARAM_NAMES.has(keyLower)) continue;

    // Case A: value berupa Base64
    if (isLikelyBase64(value)) {
      const decoded = decodeBase64(value);
      if (decoded && isPrintable(decoded)) {
        const trimmed = decoded.trim();
        if (/^https?:\/\//i.test(trimmed)) {
          for (const sub of expandUrlParams(trimmed, depth + 1)) out.add(sub);
        }
      }
    }

    // Case B: value berupa URL-encoded URL (http%3A%2F%2F...)
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

/* ─────────────────────────────────────────────
   KLASIFIKASI URL
   ───────────────────────────────────────────── */

const VIDEO_HOST_HINTS = [
  'player.', 'streamtape', 'dood', 'filemoon', 'voe', 'mp4upload',
  'mixdrop', 'abyss', 'framezi', 'kturb', 'pixeldrain', 'vikingfile',
  'buzzheavier', 'mega.nz',
];

function isVideoUrl(url: string): boolean {
  if (/\.(mp4|m3u8|mkv|webm|ts|mov)(\?|#|$)/i.test(url)) return true;
  const lower = url.toLowerCase();
  return VIDEO_HOST_HINTS.some((h) => lower.includes(h));
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/* ─────────────────────────────────────────────
   MULTI-LAYER DECODE
   ───────────────────────────────────────────── */

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

/* ─────────────────────────────────────────────
   EXTRACT KANDIDAT BASE64 DARI HTML
   ───────────────────────────────────────────── */

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

/* ─────────────────────────────────────────────
   PROSES KANDIDAT → URL FINAL
   ───────────────────────────────────────────── */

interface FinalUrl {
  url: string;
  layers: number;
  is_video: boolean;
  host: string;
  fromParam: boolean;
}

function addUrl(
  map: Map<string, FinalUrl>,
  url: string,
  layers: number,
  fromParam: boolean
): void {
  if (url.length > 2000) return;
  const existing = map.get(url);
  const is_video = isVideoUrl(url);
  const host = extractHost(url);

  if (!existing) {
    map.set(url, { url, layers, is_video, host, fromParam });
  } else if (existing.fromParam && !fromParam) {
    existing.fromParam = false;
  }
}

function processCandidates(candidates: string[]): FinalUrl[] {
  const map = new Map<string, FinalUrl>();

  for (const raw of candidates) {
    const res = multiLayerDecode(raw);
    if (!res || res.urls.length === 0) continue;

    for (const url of res.urls) {
      addUrl(map, url, res.layers, false);
      for (const expanded of expandUrlParams(url)) {
        if (expanded === url) continue;
        addUrl(map, expanded, res.layers, true);
      }
    }
  }

  return [...map.values()].sort((a, b) => {
    if (a.is_video !== b.is_video) return a.is_video ? -1 : 1;
    if (a.fromParam !== b.fromParam) return a.fromParam ? 1 : -1;
    return a.url.length - b.url.length;
  });
}

/* ─────────────────────────────────────────────
   RENDER
   ───────────────────────────────────────────── */

function renderOutput(urls: FinalUrl[]): {
  text: string;
  keyboard: InlineKeyboard | undefined;
} {
  const videos = urls.filter((u) => u.is_video && !u.fromParam);
  const others = urls.filter((u) => !u.is_video && !u.fromParam);
  const fromParams = urls.filter((u) => u.fromParam);

  const lines: string[] = [];
  lines.push('✅ <b>Decode berhasil</b>');
  lines.push('');
  lines.push(
    `🔗 URL: <b>${urls.length}</b>  ·  🎬 Video: <b>${videos.length}</b>`
  );
  lines.push('');

  if (videos.length > 0) {
    lines.push('<b>🎬 Video / Embed:</b>');
    videos.slice(0, MAX_URLS_SHOWN).forEach((u, i) => {
      const suffix = u.layers > 1 ? ` <i>(${u.layers}x)</i>` : '';
      lines.push(`${i + 1}. <code>${escapeHtml(u.url)}</code>${suffix}`);
    });
    if (videos.length > MAX_URLS_SHOWN) {
      lines.push(`<i>… +${videos.length - MAX_URLS_SHOWN} lagi</i>`);
    }
    lines.push('');
  }

  if (others.length > 0) {
    const show = videos.length > 0 ? 5 : MAX_URLS_SHOWN;
    lines.push(
      videos.length > 0 ? '<b>🔗 URL lain:</b>' : '<b>🔗 URL:</b>'
    );
    others.slice(0, show).forEach((u, i) => {
      lines.push(`${i + 1}. <code>${escapeHtml(u.url)}</code>`);
    });
    if (others.length > show) {
      lines.push(`<i>… +${others.length - show} URL lain</i>`);
    }
    lines.push('');
  }

  if (fromParams.length > 0) {
    lines.push('<b>🔍 Dari dalam URL (param):</b>');
    fromParams.slice(0, MAX_URLS_SHOWN).forEach((u, i) => {
      lines.push(`${i + 1}. <code>${escapeHtml(u.url)}</code>`);
    });
    if (fromParams.length > MAX_URLS_SHOWN) {
      lines.push(`<i>… +${fromParams.length - MAX_URLS_SHOWN} lagi</i>`);
    }
  }

  const keyboard = new InlineKeyboard();
  const top = [...videos, ...others, ...fromParams].slice(0, 6);
  top.forEach((u, i) => {
    if (u.url.length < 1900) {
      const icon = u.is_video ? '🎬' : u.fromParam ? '🔍' : '🔗';
      keyboard.url(`${icon} ${i + 1}`, u.url);
      if ((i + 1) % 3 === 0) keyboard.row();
    }
  });

  return {
    text: lines.join('\n'),
    keyboard: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
  };
}

/* ─────────────────────────────────────────────
   CORE PROCESS
   ───────────────────────────────────────────── */

export async function processHtmlInput(
  ctx: Context,
  html: string
): Promise<void> {
  const candidates = extractBase64Candidates(html);

  if (candidates.length === 0) {
    await ctx.reply('🌐 <b>HTML terdeteksi</b>\n\n❌ Tidak ada Base64.', {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    return;
  }

  const urls = processCandidates(candidates);

  if (urls.length === 0) {
    await ctx.reply(
      `🌐 <b>HTML terdeteksi</b>\n\n` +
        `📦 Kandidat: ${candidates.length}\n` +
        `❌ Tidak ada URL valid.`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  const { text, keyboard } = renderOutput(urls);
  const header = `🌐 <b>HTML terdeteksi</b>\n📦 Kandidat: ${candidates.length}\n\n`;

  await ctx.reply(header + text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard,
  });
}

export async function processBase64Input(
  ctx: Context,
  input: string
): Promise<void> {
  const result = multiLayerDecode(input);

  if (!result || result.urls.length === 0) {
    const preview =
      input.length > 80 ? input.slice(0, 40) + '…' + input.slice(-20) : input;
    await ctx.reply(
      '❌ <b>Gagal decode / tidak ada URL</b>\n\n' +
        `<code>${escapeHtml(preview)}</code>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  const urls: FinalUrl[] = [];
  const map = new Map<string, FinalUrl>();
  for (const u of result.urls) {
    addUrl(map, u, result.layers, false);
    for (const exp of expandUrlParams(u)) {
      if (exp === u) continue;
      addUrl(map, exp, result.layers, true);
    }
  }
  urls.push(...map.values());

  const { text, keyboard } = renderOutput(urls);

  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard,
  });
}

/* ─────────────────────────────────────────────
   DOWNLOAD FILE
   ───────────────────────────────────────────── */

export async function downloadDocText(
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

/* ─────────────────────────────────────────────
   AUTO HANDLER (dipanggil dari index.ts)
   ───────────────────────────────────────────── */

export async function handleDocumentAuto(
  ctx: Context,
  env: Env
): Promise<void> {
  const text = await downloadDocText(ctx, env);
  if (!text) return;

  if (looksLikeHtml(text)) {
    await processHtmlInput(ctx, text);
  } else if (isLikelyBase64(text)) {
    await processBase64Input(ctx, text.trim());
  } else {
    await processHtmlInput(ctx, text);
  }
}

/* ─────────────────────────────────────────────
   COMMAND
   ───────────────────────────────────────────── */

export const decodeCommand: CommandDefinition = {
  name: 'decode',
  description: 'Decode Base64 / HTML → URL (auto + param expand)',
  usage: '/decode base64-atau-html',
  adminOnly: true,

  handler: async (ctx, env) => {
    const doc =
      ctx.message?.document ?? ctx.message?.reply_to_message?.document;
    if (doc) {
      const text = await downloadDocText(ctx, env);
      if (!text) return;
      if (looksLikeHtml(text)) {
        await processHtmlInput(ctx, text);
      } else if (isLikelyBase64(text)) {
        await processBase64Input(ctx, text.trim());
      } else {
        await processHtmlInput(ctx, text);
      }
      return;
    }

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const replied = ctx.message?.reply_to_message?.text ?? '';
    const input = arg || replied;

    if (!input) {
      await ctx.reply(
        '<b>🔓 Decode Base64 / HTML</b>\n\n' +
          '<b>Mode teks:</b> <code>/decode aHR0cHM6...</code>\n' +
          '<b>Mode reply:</b> reply ke pesan → /decode\n' +
          '<b>Mode file:</b> kirim .html/.txt → auto proses\n\n' +
          '<i>Auto expand <code>bsrc=</code>, <code>url=</code>, dll.</i>',
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
      await processHtmlInput(ctx, input);
    } else {
      await processBase64Input(ctx, input);
    }
  },
};