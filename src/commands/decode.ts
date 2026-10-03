import type { CommandDefinition } from './registry';
import { InlineKeyboard } from 'grammy';

const MAX_INPUT_LEN = 8000;
const MAX_LAYERS = 5;
const MAX_OUTPUT_PREVIEW = 3500;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Normalisasi Base64:
 * - URL-safe (-, _) → standard (+, /)
 * - Tambah padding yang benar
 * Return null kalau panjang invalid.
 */
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

/**
 * Decode Base64 → UTF-8 string. Return null kalau gagal.
 */
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

/**
 * Heuristik: apakah string "kelihatan" Base64?
 */
function isLikelyBase64(s: string): boolean {
  const trimmed = s.trim().replace(/\s+/g, '');
  if (trimmed.length < 12 || trimmed.length > MAX_INPUT_LEN) return false;
  return /^[A-Za-z0-9+/\-_]+=*$/.test(trimmed);
}

/**
 * Heuristik: apakah hasil decode masuk akal (bukan binary sampah)?
 */
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

interface DecodeResult {
  output: string;
  layers: number;
  isUrl: boolean;
  history: string[];
}

/**
 * Decode berlapis-lapis sampai hasilnya bukan Base64 lagi,
 * atau sampai MAX_LAYERS.
 */
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

  return {
    output: current,
    layers,
    isUrl: isUrl(current),
    history,
  };
}

export const decodeCommand: CommandDefinition = {
  name: 'decode',
  description: 'Decode Base64 jadi URL/teks asli',
  usage: '/decode <base64>\nAtau reply pesan berisi Base64',
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
          'Atau reply ke pesan yang berisi Base64, lalu kirim <code>/decode</code>.\n\n' +
          '<b>Support:</b>\n' +
          '• Base64 standar (<code>+ / =</code>)\n' +
          '• Base64 URL-safe (<code>- _</code>)\n' +
          '• Multi-layer (sampai 5x)\n' +
          '• Auto-detect padding',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    if (input.length > MAX_INPUT_LEN) {
      await ctx.reply(
        `❌ Input terlalu panjang: <b>${input.length}</b> char (max ${MAX_INPUT_LEN}).`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const result = multiLayerDecode(input);

    if (!result) {
      const preview =
        input.length > 80
          ? input.slice(0, 40) + '…' + input.slice(-20)
          : input;
      await ctx.reply(
        '❌ <b>Gagal decode</b>\n\n' +
          'Input tidak terdeteksi sebagai Base64 valid.\n\n' +
          '<b>Input:</b>\n' +
          `<code>${escapeHtml(preview)}</code>\n\n` +
          '<i>Pastikan tidak ada karakter di luar Base64. ' +
          'URL-safe (-, _) juga didukung.</i>',
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
        `<pre>${escapeHtml(result.output.slice(0, MAX_OUTPUT_PREVIEW))}\n… [truncated]</pre>`
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

    // Kalau multi-layer & hasil bukan URL, tampilkan detail langkah
    if (result.layers > 1 && !result.isUrl) {
      const steps: string[] = ['<b>🔍 Detail Layer</b>'];
      for (let i = 1; i < result.history.length; i++) {
        const step = result.history[i];
        if (!step) continue;
        const short =
          step.length > 60
            ? step.slice(0, 40) + '…' + step.slice(-15)
            : step;
        steps.push(`<b>L${i}:</b> <code>${escapeHtml(short)}</code>`);
      }
      await ctx.reply(steps.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    }
  },
};