// src/commands/va.ts
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import type { CommandDefinition } from './registry';
import {
  trackMessage,
  clearTrackedSession,
  sendJsonSection,
  sendAutoDelete,
  sendDocumentViaApi,
  ensureTrackDb,
  type Tracker,
} from '../lib/telegram-utils';

/* ============================================================
   VA DATA
   ============================================================ */

interface VoiceActorRow {
  id: string;
  name: string;
  nameNative: string | null;
  image: string | null;
  defaultLanguage: string | null;
}

async function getAllVoiceActors(
  db: D1Database
): Promise<VoiceActorRow[]> {
  const res = await db
    .prepare(
      `SELECT id, name, nameNative, image, defaultLanguage
       FROM voice_actors
       ORDER BY id ASC`
    )
    .all<VoiceActorRow>();
  return res.results ?? [];
}

/* ============================================================
   SHOW MENU (dipakai /va dan redirect dari /dba)
   ============================================================ */

export async function showVaMenu(
  ctx: Context,
  env: Env
): Promise<void> {
  await ensureTrackDb(env.DB);

  const vas = await getAllVoiceActors(env.DB);
  const total = vas.length;

  const sessionId = `va_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

  // Track pesan user
  if (ctx.message?.message_id) {
    await trackMessage(env.DB, sessionId, ctx.message.message_id);
  }

  const kb = new InlineKeyboard()
    .text('📄 Preview', `va:p:${sessionId}`)
    .text('📥 File JSON', `va:f:${sessionId}`)
    .row()
    .text('❌ Batal', `va:x:${sessionId}`);

  const text =
    `🎤 <b>Voice Actors</b>\n\n` +
    `Total: <b>${total}</b> voice actor\n\n` +
    `Pilih action:`;

  const msg = await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });

  await trackMessage(env.DB, sessionId, msg.message_id);
}

/* ============================================================
   COMMAND /va
   ============================================================ */

export const vaCommand: CommandDefinition = {
  name: 'va',
  description: 'Lihat & kelola voice actors',
  adminOnly: true,
  handler: async (ctx, env) => {
    if (!ctx.from?.id) return;
    await showVaMenu(ctx, env);
  },
};

/* ============================================================
   CALLBACK HANDLERS
   ============================================================ */

export function setupVaCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^va:([pfx]):(va_[a-f0-9]+)$/, async (ctx) => {
    const match = ctx.match as RegExpMatchArray;
    const action = match[1];
    const sessionId = match[2];

    if (!action || !sessionId) {
      await ctx.answerCallbackQuery({ text: '❌ Callback invalid' });
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // === BATAL ===
    if (action === 'x') {
      await ctx.answerCallbackQuery({ text: '🗑️ Membersihkan...' });
      const deleted = await clearTrackedSession(
        ctx.api,
        env.DB,
        chatId,
        sessionId
      );
      await sendAutoDelete(
        ctx,
        `✅ <b>Selesai</b>\n<i>${deleted} pesan dihapus.</i>`
      );
      return;
    }

    await ctx.answerCallbackQuery({ text: '⏳ Memproses...' });

    const vas = await getAllVoiceActors(env.DB);

    if (vas.length === 0) {
      await ctx.answerCallbackQuery({
        text: '📭 Belum ada voice actor. Jalankan /dba dulu.',
        show_alert: true,
      });
      return;
    }

    const tracker: Tracker = (msgId) =>
      trackMessage(env.DB, sessionId, msgId);

    // Hapus keyboard dari menu
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

    if (action === 'p') {
      await sendJsonSection(
        ctx,
        `Voice Actors (${vas.length})`,
        vas,
        tracker
      );
    } else if (action === 'f') {
      const json = JSON.stringify(vas, null, 2) + '\n';
      const timestamp = new Date()
        .toISOString()
        .replace('T', ' ')
        .slice(0, 16);

      const caption =
        `📋 <b>Voice Actors</b>\n` +
        `${vas.length} total\n` +
        `<i>Generated: ${timestamp} UTC</i>`;

      try {
        await sendDocumentViaApi(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          'voice-actors.json',
          json,
          caption
        );
      } catch (err) {
        console.warn('[VA] sendDocument failed, fallback:', err);
        await sendJsonSection(
          ctx,
          `Voice Actors (${vas.length})`,
          json ? vas : vas,
          tracker
        );
      }
    }
  });
}