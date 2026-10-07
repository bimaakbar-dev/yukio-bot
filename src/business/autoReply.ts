import type { Bot } from 'grammy';
import type { Env } from '../types/env';
import { askAI } from '../services/ai';
import { isOwner } from '../lib/permissions';

/**
 * Setup business handler untuk auto-reply chat pribadi.
 * Bot akan balas pesan yang masuk ke akun personal (business mode).
 */
export function setupBusinessHandler(bot: Bot, env: Env): void {
  // ────────────────────────────────────────────────────
  // Auto-reply saat ada pesan masuk ke akun personal
  // ────────────────────────────────────────────────────
  bot.on('business_message', async (ctx) => {
    const msg = ctx.businessMessage;
    if (!msg) return;

    // Skip pesan dari diri sendiri (owner) — cegah loop
    if (isOwner(msg.from?.id, env)) return;

    // Skip pesan tanpa text (sticker, foto, dll)
    const userMessage = msg.text?.trim();
    if (!userMessage) return;

    // Skip command — biarkan user kirim command ke owner manual
    if (userMessage.startsWith('/')) return;

    // Skip pesan terlalu pendek (emoticon, "ok", dll)
    if (userMessage.length < 3) return;

    try {
      // Generate AI reply
      const aiReply = await askAI(env, userMessage, {
        system: buildAutoReplyPrompt(),
        maxTokens: 250,
        temperature: 0.5,
      });

      if (!aiReply) {
        console.warn('[Business] AI returned empty');
        return;
      }

      // Kirim balasan sebagai owner (business reply)
      await ctx.reply(aiReply, {
        business_connection_id: msg.business_connection_id,
      });

      // Notif ke admin (kamu)
      await notifyOwner(bot, env, {
        senderName: getSenderName(msg.from),
        senderUsername: msg.from?.username,
        senderId: msg.from?.id,
        userMessage,
        aiReply,
      });
    } catch (err) {
      console.error('[Business] auto-reply error:', err);
    }
  });

  // ────────────────────────────────────────────────────
  // Business connection state change (connect/disconnect)
  // ────────────────────────────────────────────────────
  bot.on('business_connection', async (ctx) => {
    const conn = ctx.businessConnection;
    if (!conn) return;

    console.log(
      `[Business] connection ${conn.id} — enabled: ${conn.is_enabled}`
    );
  });
}

/* ==========================================================
   HELPERS
   ========================================================== */

function buildAutoReplyPrompt(): string {
  return `Kamu adalah asisten pribadi dari pemilik akun ini.
Tugas: balas pesan yang masuk dengan sopan dan singkat.

Aturan:
- Maksimal 2-3 kalimat
- Bahasa sama dengan user (Indonesia atau English)
- Jangan mengaku sebagai pemilik — kamu asisten
- Kalau pertanyaan spesifik yang hanya pemilik bisa jawab, bilang:
  "Pemilik akan segera balas ya."
- Jangan kasih info pribadi tentang pemilik
- Kalau user minta tolong hal teknis, bilang akan diteruskan`;
}

function getSenderName(from: {
  first_name?: string;
  last_name?: string;
  username?: string;
} | undefined): string {
  if (!from) return 'Unknown';

  if (from.username) return `@${from.username}`;

  const fullName = [from.first_name, from.last_name]
    .filter(Boolean)
    .join(' ');

  return fullName || 'Unknown';
}

async function notifyOwner(
  bot: Bot,
  env: Env,
  data: {
    senderName: string;
    senderUsername?: string;
    senderId?: number;
    userMessage: string;
    aiReply: string;
  }
): Promise<void> {
  const senderLink = data.senderId
    ? `<a href="tg://user?id=${data.senderId}">${escapeHtml(data.senderName)}</a>`
    : escapeHtml(data.senderName);

  const notification =
    `📩 <b>Chat Baru</b>\n\n` +
    `<b>Dari:</b> ${senderLink}\n\n` +
    `<b>Pesan:</b>\n${escapeHtml(data.userMessage.slice(0, 300))}\n\n` +
    `<b>Yukio balas:</b>\n${escapeHtml(data.aiReply.slice(0, 300))}`;

  try {
    await bot.api.sendMessage(env.ADMIN_USER_ID, notification, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error('[Business] notify owner failed:', err);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}