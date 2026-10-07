// src/commands/publish-data.ts
import type { CommandDefinition } from './registry';
import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Env } from '../types/env';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface SessionRow {
  session_id: string;
  user_id: number;
  mal_id: number | null;
  kitsu_id: string | null;
  title: string;
  expires_at: number;
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function getSession(
  env: Env,
  userId: number
): Promise<SessionRow | null> {
  return env.DB
    .prepare(
      `SELECT * FROM qimochi_sessions
       WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(userId, Date.now())
    .first<SessionRow>();
}

export function setupPublishDataCallbacks(bot: Bot, _env: Env): void {
  bot.callbackQuery(/^pd:(meta|chars|eps|fr|va):([a-z0-9-]+)$/, async (ctx) => {
    const section = ctx.match[1] ?? '';
    const slug = ctx.match[2] ?? '';

    await ctx.answerCallbackQuery({
      text: `⏳ ${section} — segera hadir`,
    });

    await ctx.reply(
      `🚧 <b>Section ${escapeHtml(section)}</b> belum diimplementasi.\n\n` +
        `Slug: <code>${escapeHtml(slug)}</code>`,
      { parse_mode: 'HTML' }
    );
  });
}

export const publishDataCommand: CommandDefinition = {
  name: 'publish_data',
  description: 'Push JSON data ke yukio-data',
  usage: '/publish_data',
  adminOnly: true,

  handler: async (ctx, env) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = await getSession(env, userId);

    if (!session) {
      await ctx.reply(
        '📭 Tidak ada session /dba aktif.\n\n' +
          'Kirim <code>/dba &lt;judul&gt;</code> dulu.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const slug = slugify(session.title);
    const kb = new InlineKeyboard()
      .text('👥 Characters', `pd:chars:${slug}`)
      .text('🎬 Episodes', `pd:eps:${slug}`)
      .row()
      .text('🔗 Franchises', `pd:fr:${slug}`)
      .text('🎤 Voice Actors', `pd:va:${slug}`)
      .row()
      .text('❌ Batal', `pd:batal:${slug}`);

    await ctx.reply(
      `📤 <b>Publish Data</b>\n\n` +
        `🎬 <code>${escapeHtml(session.title)}</code>\n` +
        `📁 Target: <code>yukio-data</code>\n\n` +
        `Pilih section yang mau di-push:`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      }
    );
  },
};