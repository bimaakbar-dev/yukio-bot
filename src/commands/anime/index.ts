import type { CommandDefinition } from '../registry';
import type { Context } from 'grammy';
import type { Env } from '../../types/env';
import { chainSearch } from '../../services/qimochi-chain';
import { escapeHtml } from '../../lib/utils';
import {
  saveSession,
  getSession,
} from '../../lib/dba-session';
import { trackMessage } from '../../lib/telegram-utils';
import { buildKeyboard, buildPreviewText } from './ui';

async function handleCommand(ctx: Context, env: Env): Promise<void> {
  const query = typeof ctx.match === 'string' ? ctx.match.trim() : '';

  if (!query) {
    await ctx.reply(
      '<b>➕ Add Anime</b>\n\n' +
        '<b>Contoh:</b>\n' +
        '<code>/anime nama anime</code>\n\n' +
        '<i>Alur:</i>\n' +
        '1. Fetch metadata (AniList → Shikimori → Kitsu)\n' +
        '2. Klik section: Characters, Episodes, Franchises, Summary\n' +
        '3. Klik 📤 Publish untuk commit ke data repo\n\n' +
        '<i>Ketik /anime end untuk membersihkan session.</i>',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  if (query.toLowerCase() === 'end') {
    const { getLatestSessionByUser, deleteSession } = await import('../../lib/dba-session');
    const { deleteCharCache } = await import('../../lib/dba-characters');
    const { deleteEpCache } = await import('../../lib/dba-episodes');
    const { clearTrackedSession, sendAutoDelete } = await import('../../lib/telegram-utils');

    if (!ctx.from?.id || !ctx.chat?.id) return;
    const session = await getLatestSessionByUser(env.DB, ctx.from.id);
    if (!session) {
      await ctx.reply('📭 <i>Tidak ada session /anime aktif.</i>', {
        parse_mode: 'HTML',
      });
      return;
    }

    const deleted = await clearTrackedSession(
      ctx.api,
      env.DB,
      ctx.chat.id,
      session.session_id
    );
    await deleteCharCache(env.DB, session.session_id);
    await deleteEpCache(env.DB, session.session_id);
    await deleteSession(env.DB, session.session_id);
    await sendAutoDelete(ctx, `✅ <b>Selesai</b>\n<i>${deleted} pesan dihapus.</i>`);
    return;
  }

  const loading = await ctx.reply('🔍 Mencari (AniList → Shikimori → Kitsu)...');

  try {
    let result;
    try {
      result = await chainSearch(query);
    } catch (err: any) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Anime <b>${escapeHtml(query)}</b> tidak ditemukan.\n\n` +
          `<i>${escapeHtml((err?.message ?? 'unknown').slice(0, 400))}</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const media = result.media;
    const studio = media.studios?.nodes?.[0]?.name ?? null;

    const sessionId = await saveSession(env.DB, ctx.from!.id, {
      malId: result.malId,
      kitsuId: result.kitsuId,
      title: media.title.romaji,
      cover: media.coverImage.extraLarge,
      year: media.seasonYear ? String(media.seasonYear) : null,
      type: media.format,
      studio,
      source: result.source,
      metadata: media,
      fetchedSources: ['anilist'],
    });

    const session = await getSession(env.DB, sessionId);
    if (!session) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        '❌ Gagal simpan session.'
      );
      return;
    }

    if (ctx.message?.message_id) {
      await trackMessage(env.DB, sessionId, ctx.message.message_id);
    }
    await trackMessage(env.DB, sessionId, loading.message_id);
    await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});

    if (session.cover) {
      const msg = await ctx.replyWithPhoto(session.cover, {
        caption: buildPreviewText(session),
        parse_mode: 'HTML',
        reply_markup: buildKeyboard(sessionId),
      });
      await trackMessage(env.DB, sessionId, msg.message_id);
    } else {
      const msg = await ctx.reply(buildPreviewText(session), {
        parse_mode: 'HTML',
        reply_markup: buildKeyboard(sessionId),
        link_preview_options: { is_disabled: true },
      });
      await trackMessage(env.DB, sessionId, msg.message_id);
    }
  } catch (err: any) {
    console.error('[Anime] command error:', err);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Gagal: ${escapeHtml((err?.message ?? 'unknown').slice(0, 200))}`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
}

export const animeCommand: CommandDefinition = {
  name: 'anime',
  description: 'Tambah anime → yukio-data (fetch + cache + publish)',
  usage: '/anime <judul>',
  adminOnly: true,
  handler: handleCommand,
};
