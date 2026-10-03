import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';

const MAX_INPUT_LEN = 8000;
const MAX_LAYERS = 5;
const MAX_OUTPUT_PREVIEW = 3500;
const MAX_URLS_SHOWN = 10;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalizeBase64(input: string): string | null {
  let b64 = input.trim().replace(/\s+/g, '');
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  b64 = b64.replace(/=+$/, '');
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
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function isLikelyBase64(s: string): boolean {
  const t = s.trim().replace(/\s+/g, '');
  if (t.length < 12 || t.length > MAX_INPUT_LEN) return false;
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

function isUrl(s: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(s.trim());
}

function looksLikeHtml(s: string): boolean {
  if (s.length < 30) return false;
  return (
    /<!DOCTYPE/i.test(s) ||
    /<html[\s>]/i.test(s) ||
    /<script[\s>]/i.test(s) ||
    /<\/?[a-z][a-z0-9-]*[\s>]/i.test(s)
  );
}

interface DecodeResult {
  output: string;
  layers: number;
  isUrl: boolean;
  history: string[];
}

function multiLayerDecode(input: string): DecodeResult | null {
  if (!isLikelyBase64(input)) return null;
  let current = input.trim();
  let layers = 0;
  const history: string[] = [current];

  for (let i = 0; i < MAX_LAYERS; i++) {
    const decoded = decodeBase64(current);
    if (decoded === null || decoded === current) break;
    if (!isPrintable(decoded)) break;
    current = decoded;
    history.push(current);
    layers++;
    if (isUrl(current)) break;
    if (!isLikelyBase64(current)) break;
  }
  if (layers === 0) return null;
  return { output: current, layers, isUrl: isUrl(current), history };
}

function extractBase64Candidates(html: string): string[] {
  const found = new Map<string, number>();

  // Priority 1: atob("...")
  for (const m of html.matchAll(
    /atob\s*\(\s*["']([A-Za-z0-9+/=\-_]{16,})["']\s*\)/gi
  )) {
    const c = m[1];
    if (c && !found.has(c)) found.set(c, 1);
  }

  // Priority 2: data-* attributes
  for (const m of html.matchAll(
    /data-[a-z0-9-]+\s*=\s*["']([A-Za-z0-9+/=\-_]{20,})["']/gi
  )) {
    const c = m[1];
    if (c && !found.has(c)) found.set(c, 2);
  }

  // Priority 3: general long base64-like blobs
  for (const m of html.matchAll(/[A-Za-z0-9+/\-_]{24,}={0,2}/g)) {
    const c = m[0];
    if (c && !found.has(c)) found.set(c, 3);
  }

  return [...found.entries()]
    .sort((a, b) => a[1] - b[1] || b[0].length - a[0].length)
    .map(([c]) => c);
}

interface Candidate {
  decoded: string;
  layers: number;
  isUrl: boolean;
}

async function handleHtmlInput(ctx: Context, html: string): Promise<void> {
  const candidates = extractBase64Candidates(html);

  if (candidates.length === 0) {
    await ctx.reply(
      '🌐 <b>HTML terdeteksi</b>\n\n' +
        '❌ Tidak ada kandidat Base64 ditemukan.\n\n' +
        '<i>Cari manual di view-source: <code>atob(</code>, ' +
        '<code>data-*</code>, atau string panjang di dalam ' +
        '<code>&lt;script&gt;</code>.</i>',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  const decoded: Candidate[] = [];
  for (const raw of candidates) {
    const result = multiLayerDecode(raw);
    if (result) {
      decoded.push({
        decoded: result.output,
        layers: result.layers,
        isUrl: result.isUrl,
      });
    }
  }

  const uniqueMap = new Map<string, Candidate>();
  for (const c of decoded) {
    const existing = uniqueMap.get(c.decoded);
    if (!existing || (!existing.isUrl && c.isUrl)) {
      uniqueMap.set(c.decoded, c);
    }
  }
  const unique = [...uniqueMap.values()];
  const urls = unique.filter((c) => c.isUrl);
  const texts = unique.filter((c) => !c.isUrl);

  const lines: string[] = [];
  lines.push('🌐 <b>HTML terdeteksi</b>');
  lines.push('');
  lines.push(`📦 Kandidat Base64: <b>${candidates.length}</b>`);
  lines.push(`✅ Berhasil decode: <b>${unique.length}</b>`);
  lines.push(`🔗 URL: <b>${urls.length}</b>  ·  📄 Teks: <b>${texts.length}</b>`);
  lines.push('');

  if (urls.length > 0) {
    lines.push('<b>🔗 URL ditemukan:</b>');
    urls.slice(0, MAX_URLS_SHOWN).forEach((c, i) => {
      const suffix = c.layers > 1 ? ` <i>(${c.layers}x)</i>` : '';
      lines.push(`${i + 1}. <code>${escapeHtml(c.decoded)}</code>${suffix}`);
    });
    if (urls.length > MAX_URLS_SHOWN) {
      lines.push(`<i>… +${urls.length - MAX_URLS_SHOWN} URL lain</i>`);
    }
  }

  if (texts.length > 0 && urls.length === 0) {
    lines.push('<b>📄 Teks (non-URL):</b>');
    texts.slice(0, 5).forEach((c, i) => {
      const preview =
        c.decoded.length > 80 ? c.decoded.slice(0, 60) + '…' : c.decoded;
      lines.push(`${i + 1}. <code>${escapeHtml(preview)}</code>`);
    });
  }

  const keyboard = new InlineKeyboard();
  urls.slice(0, 3).forEach((c, i) => {
    if (c.decoded.length < 1900) {
      keyboard.url(`🔗 Buka #${i + 1}`, c.decoded).row();
    }
  });

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: urls.length > 0 ? keyboard : undefined,
  });
}

async function handleBase64Input(ctx: Context, input: string): Promise<void> {
  const result = multiLayerDecode(input);

  if (!result) {
    const preview =
      input.length > 80 ? input.slice(0, 40) + '…' + input.slice(-20) : input;
    await ctx.reply(
      '❌ <b>Gagal decode</b>\n\n' +
        'Input tidak terdeteksi sebagai Base64 valid.\n\n' +
        '<b>Input:</b>\n' +
        `<code>${escapeHtml(preview)}</code>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  const lines: string[] = [];
  lines.push('✅ <b>Decode berhasil</b>');
  lines.push('');
  lines.push(`📥 Input: <code>${input.length}</code> char`);
  lines.push(`🔄 Layer: <b>${result.layers}x</b>`);
  lines.push(`📤 Output: <code>${result.output.length}</code> char`);
  lines.push(`🏷️ Tipe: ${result.isUrl ? '🔗 URL' : '📄 Teks'}`);
  lines.push('');

  if (result.isUrl) {
    lines.push('<b>URL:</b>');
    lines.push(`<code>${escapeHtml(result.output)}</code>`);
  } else if (result.output.length <= MAX_OUTPUT_PREVIEW) {
    lines.push('<b>Output:</b>');
    lines.push(`<pre>${escapeHtml(result.output)}</pre>`);
  } else {
    lines.push('<b>Output (terpotong):</b>');
    lines.push(
      `<pre>${escapeHtml(
        result.output.slice(0, MAX_OUTPUT_PREVIEW)
      )}\n… [truncated]</pre>`
    );
  }

  const keyboard = new InlineKeyboard();
  if (result.isUrl && result.output.length < 1900) {
    keyboard.url('🔗 Buka', result.output).row();
  }
  keyboard.copyText('📋 Copy', result.output);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard,
  });
}

export const decodeCommand: CommandDefinition = {
  name: 'decode',
  description: 'Decode Base64 jadi URL/teks (support HTML)',
  usage: '/decode <base64|html>\nAtau reply pesan berisi Base64/HTML',
  adminOnly: true,

  handler: async (ctx) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const repliedText = ctx.message?.reply_to_message?.text ?? '';
    const input = arg || repliedText;

    if (!input) {
      await ctx.reply(
        '<b>🔓 Decode Base64</b>\n\n' +
          '<b>Cara pakai:</b>\n' +
          '<code>/decode aHR0cHM6Ly8...</code>\n\n' +
          'Atau reply ke pesan berisi Base64 / HTML, lalu kirim <code>/decode</code>.\n\n' +
          '<b>Support:</b>\n' +
          '• Base64 standar & URL-safe\n' +
          '• Multi-layer (max 5x)\n' +
          '• <b>HTML view-source</b> — auto-extract dari <code>atob()</code>, <code>data-*</code>, script\n' +
          '• Auto-detect padding',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    if (input.length > MAX_INPUT_LEN) {
      await ctx.reply(
        `❌ Input terlalu panjang: <b>${input.length}</b> char (max ${MAX_INPUT_LEN}).\n\n` +
          '<i>Kalau HTML-nya besar, potong dulu bagian yang ada ' +
          '<code>atob()</code>, <code>data-*</code>, atau script intinya.</i>',
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (looksLikeHtml(input)) {
      await handleHtmlInput(ctx, input);
    } else {
      await handleBase64Input(ctx, input);
    }
  },
};