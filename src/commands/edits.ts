// src/commands/edit.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import type { Env } from '../types/env';
import {
  getActiveEditSession,
  getEditSession,
} from './edit/state';
import { handleSlugInput, applyValueAndReturn, resolveField } from './edit/flow';
import { buildTargetKeyboard } from './edit/ui';
import { targetLabel } from './edit/schema';

export const editCommand: CommandDefinition = {
  name: 'edit',
  description: 'Edit file markdown di qimochi/yukionime',
  usage: '/edit',
  adminOnly: true,

  handler: async (ctx, env) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Cek session aktif — kalau ada, tawarin resume
    const active = await getActiveEditSession(env.DB, userId);
    if (active && active.state !== 'awaiting_slug') {
      await ctx.reply(
        `⚠️ <b>Ada session edit aktif</b>\n\n` +
          `🆔 <code>${active.slug}</code>\n` +
          `📄 ${targetLabel(active.target)}\n\n` +
          `<i>Lanjutkan session itu, atau mulai baru dengan memilih target:</i>`,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: buildTargetKeyboard(),
        }
      );
      return;
    }

    await ctx.reply(
      `✏️ <b>Edit File Anime</b>\n\n` +
        `Pilih target repo:\n` +
        `• <b>qimochi</b> — frontend web\n` +
        `• <b>yukionime</b> — database web\n\n` +
        `<i>Setelah pilih target, kirim slug anime.</i>`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: buildTargetKeyboard(),
      }
    );
  },
};

/**
 * Dipanggil dari index.ts di handler `bot.on('message:text')`.
 * Cek apakah ada session edit aktif dengan state awaiting_slug/awaiting_value.
 * Return true kalau sudah di-handle (biar nggak fallback ke handler lain).
 */
export async function handleEditTextInput(
  ctx: Context,
  env: Env
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;

  const text = ctx.message?.text ?? '';
  if (!text || text.startsWith('/')) return false;

  const session = await getActiveEditSession(env.DB, userId);
  if (!session) return false;

  if (session.state === 'awaiting_slug') {
    const slug = text.trim().toLowerCase();
    if (!slug) return false;
    await handleSlugInput(ctx, env, session, slug);
    return true;
  }

  if (session.state === 'awaiting_value') {
    if (!session.active_field) return false;
    const field = resolveField(session.target, session.active_field);
    if (!field) return false;
    if (field.type === 'choice') return false; // choice harus via tombol

    const value = text.trim();
    if (!value) return false;
    await applyValueAndReturn(ctx, env, session, field, value);
    return true;
  }

  return false;
}

// Re-export biar gampang
export { getEditSession };