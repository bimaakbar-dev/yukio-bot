// src/commands/add.ts
//
// /add — unified flow: fetch metadata + cache section + publish ke yukio-data.
// Self-contained. Tidak bergantung pada commands lama (anime.ts, post.ts, dll).
// Session pakai tabel qimochi_sessions (shared dengan /dba).

import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { AniListMedia } from '../types/anime';

import { chainSearch } from '../services/qimochi-chain';
import {
  chainCharacters,
  chainEpisodes,
  chainRelations,
  type ChainContext,
} from '../services/qimochi-chain-extras';
import { getSynopsisRaw } from '../services/qimochi-yaml';
import { searchShikimori, shikimoriToAniList } from '../services/shikimori';
import { searchKitsu, kitsuToAniList } from '../services/kitsu';
import { getMetadataFromAniList } from '../services/anilist';
import { askAI } from '../services/ai';

import { escapeHtml, withTimeout, slugify } from '../lib/utils';
import {
  safeFetch,
  fallbackJson,
  parseJsonArray,
  parseJsonMedia,
} from '../lib/dba-common';
import {
  ensureDb,
  saveSession,
  getSession,
  getLatestSessionByUser,
  updateSessionMetadata,
  updateSessionSummary,
  deleteSession,
  type SessionRow,
} from '../lib/dba-session';
import {
  detectMissing,
  mergeMetadata,
  buildMetadataKeyboard,
  buildMetadataView,
} from '../lib/dba-metadata';
import {
  saveCharCache,
  getCharCache,
  deleteCharCache,
  getCharacterPart,
  countParts,
  buildPartsKeyboard,
  markPartSent,
  CHAR_PART_SIZE,
} from '../lib/dba-characters';
import { saveEpCache, deleteEpCache } from '../lib/dba-episodes';
import { saveVoiceActors } from '../lib/dba-voice-actors';
import { showVaMenu } from './va';
import {
  sendTextSection,
  sendJsonSection,
  sendAutoDelete,
  trackMessage,
  clearTrackedSession,
  type Tracker,
} from '../lib/telegram-utils';

const AI_TIMEOUT_MS = 12000;
const SOURCE_TIMEOUT_MS = 8000;
const CHAR_FETCH_TIMEOUT_MS = 25000;

function buildChainContext(session: SessionRow): ChainContext {
  return {
    malId: session.mal_id,
    kitsuId: session.kitsu_id,
    title: session.title,
  };
}

function buildKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('📋 Metadata', `ad:m:${sessionId}`)
    .text('👥 Characters', `ad:c:${sessionId}`)
    .row()
    .text('🎬 Episodes', `ad:e:${sessionId}`)
    .text('🔗 Franchises', `ad:f:${sessionId}`)
    .row()
    .text('🎤 Voice Actors', `ad:v:${sessionId}`)
    .text('📝 Summary', `ad:s:${sessionId}`)
    .row()
    .text('📤 Publish ke yukio-data', `ad:pub:${sessionId}`)
    .row()
    .text('❌ Batal', `ad:x:${sessionId}`);
}

function buildPreviewText(session: SessionRow): string {
  const lines: string[] = [];
  lines.push(`<b>${escapeHtml(session.title)}</b>`);
  lines.push('');
  if (session.year) lines.push(`📅 ${escapeHtml(session.year)}`);
  if (session.type) lines.push(`🎬 ${escapeHtml(session.type)}`);
  if (session.studio) lines.push(`🏢 ${escapeHtml(session.studio)}`);
  if (session.source) lines.push(`📡 ${escapeHtml(session.source)}`);
  lines.push('');
  lines.push('<i>Klik section untuk fetch data, lalu 📤 Publish.</i>');
  return lines.join('\n');
}

async function rewriteSynopsis(
  env: Env,
  title: string,
  originalSynopsis: string
): Promise<string | null> {
  if (!originalSynopsis || originalSynopsis.length < 30) return null;

  const prompt =
    `Tulis ulang sinopsis anime berikut menjadi sinopsis baru dalam bahasa Indonesia.\n\n` +
    `Judul: ${title}\n\n` +
    `Sinopsis referensi (English):\n${originalSynopsis}\n\n` +
    `ATURAN:\n` +
    `- Tulis sebagai sinopsis baru, BUKAN terjemahan literal\n` +
    `- Bahasa Indonesia natural dan mengalir\n` +
    `- 2-3 paragraf pendek\n` +
    `- Jangan spoiler\n` +
    `- Jangan tambahkan info yang tidak ada di referensi\n` +
    `- Langsung mulai dari tokoh utama atau setting\n\n` +
    `Output hanya sinopsis, tanpa penjelasan tambahan.`;

  try {
    const result = await Promise.race([
      askAI(env, prompt, { maxTokens: 700, temperature: 0.6, smart: true }),
      new Promise<string>((r) => setTimeout(() => r(''), AI_TIMEOUT_MS)),
    ]);

    return result && result.length > 50 ? result.trim() : null;
  } catch (err) {
    console.error('[Add] AI rewrite failed:', err);
    return null;
  }
}

async function handleCommand(ctx: Context, env: Env): Promise<void> {
  const query = typeof ctx.match === 'string' ? ctx.match.trim() : '';

  if (!query) {
    await ctx.reply(
      '<b>➕ Add Anime</b>\n\n' +
        '<b>Contoh:</b>\n' +
        '<code>/add nama anime</code>\n\n' +
        '<i>Alur:</i>\n' +
        '1. Fetch metadata (AniList → Shikimori → Kitsu)\n' +
        '2. Klik section: Characters, Episodes, Franchises, Summary\n' +
        '3. Klik 📤 Publish untuk commit ke yukio-data\n\n' +
        '<i>Ketik /end untuk membersihkan session.</i>',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
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
    console.error('[Add] command error:', err);
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

export const addAnimeCommand: CommandDefinition = {
  name: 'add',
  description: 'Tambah anime → yukio-data (metadata + cache + publish)',
  usage: '/add <judul>',
  adminOnly: true,
  handler: handleCommand,
};

/* ============================================================
   CALLBACKS — semua pakai prefix `ad:` biar tidak tabrakan
   ============================================================ */

async function handleMetadataShow(
  ctx: Context,
  env: Env,
  session: SessionRow,
  tracker: Tracker
): Promise<void> {
  let media = parseJsonMedia(session.metadata);

  if (!media) {
    const fetched = await withTimeout(
      () => getMetadataFromAniList(session.title),
      SOURCE_TIMEOUT_MS
    );

    if (!fetched) {
      const msg = await ctx.reply('❌ Gagal fetch metadata dari AniList.', {
        parse_mode: 'HTML',
      });
      await tracker(msg.message_id);
      return;
    }

    media = fetched;
    await updateSessionMetadata(env.DB, session.session_id, media, ['anilist']);
  }

  const sources = parseJsonArray(session.fetched_sources);
  const missing = detectMissing(media, sources);
  const view = buildMetadataView(session, media, missing, sources);
  const kb = buildMetadataKeyboard(session.session_id, missing);

  const msg = await ctx.reply(view, {
    parse_mode: 'HTML',
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
  await tracker(msg.message_id);
}

async function handleMetadataMerge(
  ctx: Context,
  env: Env,
  session: SessionRow,
  sourceName: 'shikimori' | 'kitsu',
  tracker: Tracker
): Promise<void> {
  const media = parseJsonMedia(session.metadata);
  if (!media) {
    const msg = await ctx.reply('❌ Session tidak punya metadata.');
    await tracker(msg.message_id);
    return;
  }

  const sources = parseJsonArray(session.fetched_sources);
  if (sources.includes(sourceName)) {
    const msg = await ctx.reply(
      `ℹ️ ${sourceName} sudah pernah di-fetch.`,
      { parse_mode: 'HTML' }
    );
    await tracker(msg.message_id);
    return;
  }

  let incoming: AniListMedia | null = null;

  if (sourceName === 'shikimori') {
    const shiki = await withTimeout(
      () => searchShikimori(session.title),
      SOURCE_TIMEOUT_MS
    );
    if (shiki) incoming = shikimoriToAniList(shiki);
  } else if (sourceName === 'kitsu') {
    const kitsu = await withTimeout(
      () => searchKitsu(session.title),
      SOURCE_TIMEOUT_MS
    );
    if (kitsu) incoming = kitsuToAniList(kitsu);
  }

  if (!incoming) {
    const msg = await ctx.reply(`❌ Gagal fetch dari ${sourceName}.`, {
      parse_mode: 'HTML',
    });
    await tracker(msg.message_id);
    return;
  }

  const { merged, filled } = mergeMetadata(media, incoming, sourceName);
  const newSources = [...sources, sourceName];
  await updateSessionMetadata(env.DB, session.session_id, merged, newSources);

  const updatedSession = (await getSession(env.DB, session.session_id))!;

  if (filled.length === 0) {
    const msg = await ctx.reply(
      `ℹ️ <i>Tidak ada field baru dari ${sourceName}.</i>`,
      { parse_mode: 'HTML' }
    );
    await tracker(msg.message_id);
    return;
  }

  const missing = detectMissing(merged, newSources);
  const view = buildMetadataView(updatedSession, merged, missing, newSources);
  const kb = buildMetadataKeyboard(session.session_id, missing);

  const msg = await ctx.reply(view, {
    parse_mode: 'HTML',
    reply_markup: kb,
    link_preview_options: { is_disabled: true },
  });
  await tracker(msg.message_id);
}

export function setupAddCallbacks(bot: Bot, env: Env): void {
  /* ── Part characters ── */
  bot.callbackQuery(/^ad:cp:(\d+):(q_[a-f0-9]+)$/, async (ctx) => {
    const partIndex = parseInt(ctx.match[1] ?? '0', 10);
    const sessionId = ctx.match[2];

    if (!sessionId || isNaN(partIndex)) {
      await ctx.answerCallbackQuery({ text: '❌ Callback invalid' });
      return;
    }

    const session = await getSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Session kadaluarsa. Ulangi /add.',
        show_alert: true,
      });
      return;
    }
    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '⏳ Mengirim part...' });

    const tracker: Tracker = (msgId) => trackMessage(env.DB, sessionId, msgId);

    const cache = await getCharCache(env.DB, sessionId);
    if (!cache) {
      const msg = await ctx.reply(
        '⏱️ Cache characters kadaluarsa. Klik 👥 Characters lagi.',
        { parse_mode: 'HTML' }
      );
      await tracker(msg.message_id);
      return;
    }

    const part = getCharacterPart(cache.chars, partIndex);
    if (!part) {
      const msg = await ctx.reply('❌ Part tidak ditemukan.', { parse_mode: 'HTML' });
      await tracker(msg.message_id);
      return;
    }

    const numParts = countParts(cache.total);

    await sendJsonSection(
      ctx,
      `Characters ${part.start}-${part.end} dari ${cache.total} — ${session.title} [${partIndex + 1}/${numParts}]`,
      part.items,
      tracker
    );

    await markPartSent(env.DB, sessionId, partIndex);
  });

  /* ── Main actions ── */
  bot.callbackQuery(
    /^ad:(ms|mk|mo|m|c|e|f|s|v|x|pub):(q_[a-f0-9]+)$/,
    async (ctx) => {
      const action = ctx.match[1];
      const sessionId = ctx.match[2];

      if (!action || !sessionId) {
        await ctx.answerCallbackQuery({ text: '❌ Callback invalid' });
        return;
      }

      const session = await getSession(env.DB, sessionId);
      if (!session) {
        await ctx.answerCallbackQuery({
          text: '⏱️ Session kadaluarsa. Ulangi /add.',
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

      /* ── Cancel ── */
      if (action === 'x') {
        await ctx.answerCallbackQuery({ text: '🗑️ Membersihkan...' });
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        const deleted = await clearTrackedSession(
          ctx.api,
          env.DB,
          chatId,
          sessionId
        );

        await deleteCharCache(env.DB, sessionId);
        await deleteEpCache(env.DB, sessionId);
        await deleteSession(env.DB, sessionId);

        await sendAutoDelete(
          ctx,
          `✅ <b>Selesai</b>\n<i>${deleted} pesan dihapus.</i>`
        );
        return;
      }

      /* ── Publish ── */
      if (action === 'pub') {
        await ctx.answerCallbackQuery({ text: '📤 Menyiapkan preview publish...' });

        const { doPublishNew } = await import('./publish/core');

        // doPublishNew ambil session dari user (getLatestSessionByUser),
        // jadi session yang aktif pasti session ini.
        await doPublishNew(ctx, env);
        return;
      }

      /* ── Metadata done ── */
      if (action === 'mo') {
        await ctx.answerCallbackQuery({ text: '✅ Selesai!' });
        await ctx
          .editMessageReplyMarkup({ reply_markup: undefined })
          .catch(() => {});
        return;
      }

      /* ── Metadata merge ── */
      if (action === 'ms') {
        await ctx.answerCallbackQuery({ text: '📡 Cari Shikimori...' });
        const tracker: Tracker = (msgId) => trackMessage(env.DB, sessionId, msgId);
        await handleMetadataMerge(ctx, env, session, 'shikimori', tracker);
        return;
      }
      if (action === 'mk') {
        await ctx.answerCallbackQuery({ text: '📡 Cari Kitsu...' });
        const tracker: Tracker = (msgId) => trackMessage(env.DB, sessionId, msgId);
        await handleMetadataMerge(ctx, env, session, 'kitsu', tracker);
        return;
      }

      /* ── Voice Actors menu ── */
      if (action === 'v') {
        await ctx.answerCallbackQuery({ text: '🎤 Buka menu Voice Actors...' });
        await showVaMenu(ctx, env);
        return;
      }

      await ctx.answerCallbackQuery({ text: '⏳ Memproses...' });

      const tracker: Tracker = (msgId) => trackMessage(env.DB, sessionId, msgId);

      try {
        const chainCtx = buildChainContext(session);

        /* ── Metadata ── */
        if (action === 'm') {
          await handleMetadataShow(ctx, env, session, tracker);
          return;
        }

        /* ── Characters ── */
        if (action === 'c') {
          const cached = await getCharCache(env.DB, sessionId);

          if (cached) {
            const numParts = countParts(cached.total);
            const kb = buildPartsKeyboard(sessionId, cached.total, cached.sentParts);
            const msg = await ctx.reply(
              `📋 <b>Characters — ${escapeHtml(session.title)}</b>\n` +
                `Total: <b>${cached.total}</b> karakter (${numParts} part × ${CHAR_PART_SIZE})\n` +
                `Sumber: ${escapeHtml(cached.source)}\n\n` +
                `<i>Pilih part:</i>`,
              {
                parse_mode: 'HTML',
                reply_markup: kb,
                link_preview_options: { is_disabled: true },
              }
            );
            await tracker(msg.message_id);
            return;
          }

          const { data: result, error } = await safeFetch(
            () => chainCharacters(chainCtx),
            CHAR_FETCH_TIMEOUT_MS
          );

          if (!result || !result.data || result.data.length === 0) {
            const errs = result?.errors ?? [error ?? 'unknown'];
            await sendTextSection(
              ctx,
              `Characters — ${session.title} [FAILED]`,
              fallbackJson(errs),
              tracker
            );
            return;
          }

          const chars = result.data;
          const vas = result.voiceActors;
          const source = result.source;

          let vaResult = { newCount: 0, skippedCount: 0 };
          if (vas.length > 0) {
            try {
              vaResult = await saveVoiceActors(env.DB, vas);
            } catch (err) {
              console.warn('[Add] Gagal simpan VA:', err);
            }
          }

          try {
            await saveCharCache(env.DB, sessionId, chars, vas, source);
          } catch (err) {
            console.warn('[Add] Gagal simpan cache chars:', err);
          }

          const total = chars.length;
          const numParts = countParts(total);
          const kb = buildPartsKeyboard(sessionId, total);

          let text =
            `📋 <b>Characters — ${escapeHtml(session.title)}</b>\n` +
            `Total: <b>${total}</b> karakter (${numParts} part × ${CHAR_PART_SIZE})\n` +
            `Sumber: ${escapeHtml(source)}\n`;

          if (vaResult.newCount > 0) {
            text += `🎤 <b>${vaResult.newCount}</b> VA baru tersimpan (${vaResult.skippedCount} skip)\n`;
          }
          text += `\n<i>Pilih part:</i>`;

          const menuMsg = await ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup: kb,
            link_preview_options: { is_disabled: true },
          });
          await tracker(menuMsg.message_id);
          return;
        }

        /* ── Episodes ── */
        if (action === 'e') {
          const { data: result, error } = await safeFetch(
            () => chainEpisodes(chainCtx),
            30000
          );

          if (!result || !result.data || result.data.length === 0) {
            const errs = result?.errors ?? [error ?? 'unknown'];
            await sendTextSection(
              ctx,
              `Episodes — ${session.title} [FAILED]`,
              fallbackJson(errs),
              tracker
            );
            return;
          }

          const eps = result.data;

          try {
            await saveEpCache(
              env.DB,
              sessionId,
              eps.map((e) => ({
                number: e.number,
                title: e.title,
                aired: e.aired,
                duration: e.duration,
              })),
              result.source,
              result.truncated ?? false
            );
          } catch (err) {
            console.warn('[Add] Gagal simpan ep cache:', err);
          }

          const truncNote = result.truncated ? ' [⚠️ truncated]' : '';

          await sendJsonSection(
            ctx,
            `Episodes — ${session.title} [${result.source}]${truncNote}`,
            eps,
            tracker
          );
          return;
        }

        /* ── Franchises ── */
        if (action === 'f') {
          const { data: result, error } = await safeFetch(
            () => chainRelations(chainCtx),
            25000
          );

          if (!result || !result.data || result.data.length === 0) {
            const errs = result?.errors ?? [error ?? 'unknown'];
            await sendTextSection(
              ctx,
              `Franchises — ${session.title} [FAILED]`,
              fallbackJson(errs),
              tracker
            );
            return;
          }

          await sendJsonSection(
            ctx,
            `Franchises — ${session.title} [${result.source}]`,
            result.data,
            tracker
          );
          return;
        }

        /* ── Summary ── */
        if (action === 's') {
          let result;
          try {
            result = await chainSearch(session.title);
          } catch (err: any) {
            const msg = await ctx.reply(
              `❌ Gagal: ${escapeHtml((err?.message ?? 'unknown').slice(0, 200))}`,
              { parse_mode: 'HTML' }
            );
            await tracker(msg.message_id);
            return;
          }

          const raw = getSynopsisRaw(result.media);
          const { data: ai } = await safeFetch(
            () => rewriteSynopsis(env, session.title, raw),
            AI_TIMEOUT_MS
          );

          const body = ai ?? raw ?? 'Tulis sinopsis manual...';

          try {
            await updateSessionSummary(env.DB, sessionId, body);
          } catch (err) {
            console.warn('[Add] Gagal simpan summary:', err);
          }

          await sendTextSection(
            ctx,
            `Summary — ${session.title}`,
            body,
            tracker
          );
          return;
        }
      } catch (err: any) {
        console.error('[Add] callback error:', err);
        const msg = err?.message ?? 'unknown';

        let hint = '';
        if (msg.includes('aborted') || msg.includes('timeout')) {
          hint = '\n\n<i>API lambat. Coba lagi dalam 30 detik.</i>';
        } else if (msg.includes('429')) {
          hint = '\n\n<i>Rate limit. Tunggu 1 menit.</i>';
        } else if (msg.includes('HTTP 5')) {
          hint = '\n\n<i>Server down. Coba lagi nanti.</i>';
        }

        const m = await ctx.reply(
          `❌ Gagal: ${escapeHtml(msg.slice(0, 200))}${hint}`,
          { parse_mode: 'HTML' }
        );
        await tracker(m.message_id).catch(() => {});
      }
    }
  );
}

void slugify;
