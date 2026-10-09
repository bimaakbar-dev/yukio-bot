// src/commands/track.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import { escapeHtml } from '../lib/utils';
import { githubGetFile } from '../lib/github';
import {
  deleteTrackedAnime,
  listAllTrackedAnime,
  saveTrackedAnime,
  isInScheduleWindow,
  type SiteKey,
} from '../lib/cron/state';
import { updateTrackedAnime } from '../lib/cron/state-extra';
import { createLazyInit } from '../lib/lazy-init';

const ALL_SITES: SiteKey[] = ['lexanime', 'animesub', 'samehadaku'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const PER_PAGE = 8;
const SESSION_TTL_MS = 15 * 60 * 1000;
const DAYS = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
const DAYS_SHORT = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

export type EditStep =
  | 'add_site' | 'add_slug' | 'add_source' | 'add_day' | 'add_hour'
  | 'add_confirm' | 'edit_value';

export interface TrackSessionRow {
  session_id: string;
  user_id: number;
  step: EditStep;
  site: string | null;
  slug: string | null;
  source_slug: string | null;
  schedule_day: string | null;
  schedule_hour: number | null;
  schedule_minute: number | null;
  buffer_min: number;
  edit_field: string | null;
  created_at: number;
  expires_at: number;
}

const ensureSessionDb = createLazyInit('TrackSessV2', async (db) => {
  await db.prepare(`CREATE TABLE IF NOT EXISTS track_sessions_v2 (
    session_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    step TEXT NOT NULL,
    site TEXT, slug TEXT, source_slug TEXT,
    schedule_day TEXT, schedule_hour INTEGER, schedule_minute INTEGER,
    buffer_min INTEGER NOT NULL DEFAULT 60,
    edit_field TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`).run();
});

export async function createSession(
  db: D1Database,
  userId: number,
  step: EditStep,
  initial: Partial<TrackSessionRow> = {}
): Promise<string> {
  await ensureSessionDb(db);
  const sessionId = 'ts_' + crypto.randomUUID().replace(/-/g, '').slice(0, 13);
  const now = Date.now();
  await db.prepare(`INSERT INTO track_sessions_v2
    (session_id, user_id, step, site, slug, source_slug, schedule_day,
     schedule_hour, schedule_minute, buffer_min, edit_field, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(sessionId, userId, step,
      initial.site ?? null, initial.slug ?? null, initial.source_slug ?? null,
      initial.schedule_day ?? null, initial.schedule_hour ?? null,
      initial.schedule_minute ?? null, initial.buffer_min ?? 60,
      initial.edit_field ?? null, now, now + SESSION_TTL_MS)
    .run();
  return sessionId;
}

export async function getSession(
  db: D1Database,
  sessionId: string
): Promise<TrackSessionRow | null> {
  await ensureSessionDb(db);
  const row = await db.prepare('SELECT * FROM track_sessions_v2 WHERE session_id = ?')
    .bind(sessionId).first<TrackSessionRow>();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await db.prepare('DELETE FROM track_sessions_v2 WHERE session_id = ?')
      .bind(sessionId).run().catch(() => {});
    return null;
  }
  return row;
}

export async function getLatestSession(
  db: D1Database,
  userId: number
): Promise<TrackSessionRow | null> {
  await ensureSessionDb(db);
  return db.prepare(`SELECT * FROM track_sessions_v2
    WHERE user_id = ? AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1`)
    .bind(userId, Date.now()).first<TrackSessionRow>();
}

export async function updateSession(
  db: D1Database,
  sessionId: string,
  patch: Partial<TrackSessionRow>
): Promise<void> {
  await ensureSessionDb(db);
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === 'session_id' || k === 'user_id' || k === 'created_at') continue;
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (sets.length === 0) return;
  values.push(sessionId);
  await db.prepare(`UPDATE track_sessions_v2 SET ${sets.join(', ')} WHERE session_id = ?`)
    .bind(...values).run();
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  try {
    await ensureSessionDb(db);
    await db.prepare('DELETE FROM track_sessions_v2 WHERE session_id = ?')
      .bind(sessionId).run();
  } catch {}
}

function isValidSite(s: string): s is SiteKey {
  return ALL_SITES.includes(s as SiteKey);
}

function parseTime(input: string): { hour: number; minute: number } | null {
  const cleaned = input.trim().replace(/[.,]/g, ':');
  const parts = cleaned.split(':');
  if (parts.length === 1) {
    const h = parseInt(parts[0] ?? '', 10);
    if (isNaN(h) || h < 0 || h > 23) return null;
    return { hour: h, minute: 0 };
  }
  if (parts.length === 2) {
    const h = parseInt(parts[0] ?? '', 10);
    const m = parseInt(parts[1] ?? '', 10);
    if (isNaN(h) || isNaN(m)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return { hour: h, minute: m };
  }
  return null;
}

function extractSamehadakuSlug(url: string): string | null {
  const t = url.trim();
  const m1 = t.match(/\/anime\/([a-z0-9-]+)\/?/i);
  if (m1?.[1]) return m1[1].toLowerCase();
  const m2 = t.match(/\/([a-z0-9-]+?)-episode-\d+-subtitle-indonesia\/?/i);
  if (m2?.[1]) return m2[1].toLowerCase();
  return null;
}

/* ============================================================
   MENU
   ============================================================ */

export async function showMainMenu(
  ctx: Context,
  env: Env,
  edit = false
): Promise<void> {
  const all = await listAllTrackedAnime(env.DB);
  const total = all.length;
  const active = all.filter((r) => r.status === 'active').length;
  const paused = all.filter((r) => r.status === 'paused').length;
  const pending = all.filter((r) => r.status === 'active' && isInScheduleWindow(r)).length;

  const lines: string[] = [];
  lines.push('📡 <b>Track Anime</b>');
  lines.push('');
  lines.push(`📊 Total: <b>${total}</b>`);
  if (active > 0) lines.push(`🟢 Active: ${active}`);
  if (paused > 0) lines.push(`⏸️ Paused: ${paused}`);
  if (pending > 0) {
    lines.push('');
    lines.push(`⚠️ <b>${pending} tertinggal!</b>`);
  }
  lines.push('');
  lines.push('<i>Pilih action:</i>');

  const kb = new InlineKeyboard()
    .text('➕ Tambah Baru', 'tr:a')
    .text('📋 Daftar', 'tr:l')
    .row()
    .text('🗑️ Hapus', 'tr:dm')
    .text('🔄 Catch-up', 'tr:c');

  const payload = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  };

  if (edit && ctx.callbackQuery?.message?.message_id) {
    await ctx
      .api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message.message_id, lines.join('\n'), payload)
      .catch(() => {});
    return;
  }

  await ctx.reply(lines.join('\n'), payload);
}

export async function showList(ctx: Context, env: Env, page = 0): Promise<void> {
  const all = await listAllTrackedAnime(env.DB);
  all.sort((a, b) => a.slug.localeCompare(b.slug));

  if (all.length === 0) {
    const payload = {
      parse_mode: 'HTML' as const,
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard().text('◀️ Kembali', 'tr:h'),
    };
    if (ctx.callbackQuery?.message?.message_id) {
      await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message.message_id, '📭 Belum ada anime.', payload).catch(() => {});
    } else {
      await ctx.reply('📭 Belum ada anime.', payload);
    }
    return;
  }

  const totalPages = Math.max(1, Math.ceil(all.length / PER_PAGE));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const start = p * PER_PAGE;
  const items = all.slice(start, start + PER_PAGE);

  const lines: string[] = [];
  lines.push(`📋 <b>Tracked (${all.length})</b>`);
  lines.push(`<i>Halaman ${p + 1}/${totalPages}</i>`);
  lines.push('');
  lines.push('<i>Tap anime untuk detail & edit:</i>');

  const kb = new InlineKeyboard();
  for (const r of items) {
    const icon = r.status === 'active' ? '🟢' : r.status === 'paused' ? '⏸️' : '✅';
    const pending = isInScheduleWindow(r) ? ' ⚠️' : '';
    const label = `${icon} ${r.slug}${pending}`;
    const short = label.length > 50 ? label.slice(0, 48) + '…' : label;
    kb.text(short, `tr:v:${r.slug}`).row();
  }

  if (totalPages > 1) {
    if (p > 0) kb.text('◀️', `tr:lp:${p - 1}`);
    if (p < totalPages - 1) kb.text('▶️', `tr:lp:${p + 1}`);
    kb.row();
  }
  kb.text('◀️ Kembali', 'tr:h');

  const payload = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  };

  if (ctx.callbackQuery?.message?.message_id) {
    await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message.message_id, lines.join('\n'), payload).catch(() => {});
    return;
  }
  await ctx.reply(lines.join('\n'), payload);
}

export async function showDetail(
  ctx: Context,
  env: Env,
  slug: string,
  edit = false
): Promise<void> {
  const all = await listAllTrackedAnime(env.DB);
  const row = all.find((r) => r.slug === slug);

  if (!row) {
    await ctx.answerCallbackQuery({ text: '❌ Tidak ditemukan', show_alert: true }).catch(() => {});
    return;
  }

  const statusIcon = row.status === 'active' ? '🟢' : row.status === 'paused' ? '⏸️' : '✅';
  const hh = String(row.schedule_hour).padStart(2, '0');
  const mm = String(row.schedule_minute ?? 0).padStart(2, '0');
  const pending = isInScheduleWindow(row) ? ' ⚠️' : '';

  const lines: string[] = [];
  lines.push(`📄 <code>${escapeHtml(row.slug)}</code>${pending}`);
  lines.push('');
  lines.push(`🎬 Site: <b>${row.site}</b>`);
  lines.push(`🔗 Source: <code>${escapeHtml(row.source_slug)}</code>`);
  lines.push(`📅 ${row.schedule_day} ${hh}:${mm} WIB`);
  lines.push(`${statusIcon} Status: <b>${row.status}</b>`);
  lines.push(`📼 Last ep: <b>${row.last_ep}</b>`);
  lines.push(`📦 Chunk: <b>${row.chunk_start}-${row.chunk_end}</b>`);
  lines.push(`⏱️ Buffer: <b>${row.buffer_min}</b> menit`);
  if (row.last_check_at) {
    const ago = Math.round((Date.now() - row.last_check_at) / 60000);
    const agoStr = ago < 60 ? `${ago}m lalu` : `${Math.round(ago / 60)}j lalu`;
    lines.push(`🕐 Last check: ${agoStr}`);
  }
  lines.push('');
  lines.push('<i>Pilih field untuk edit:</i>');

  const kb = new InlineKeyboard()
    .text('🎬 Site', `tr:e:${slug}:site`)
    .text('🔗 Source', `tr:e:${slug}:source_slug`)
    .row()
    .text('📅 Hari', `tr:e:${slug}:schedule_day`)
    .text('⏰ Jam', `tr:e:${slug}:schedule_hour`)
    .row()
    .text('📼 Last Ep', `tr:e:${slug}:last_ep`)
    .text('📦 Chunk', `tr:e:${slug}:chunk`)
    .row()
    .text('⏱️ Buffer', `tr:e:${slug}:buffer_min`)
    .text('🔀 Status', `tr:e:${slug}:status`)
    .row()
    .text('🔄 Check', `tr:cx:${slug}`)
    .text('♻️ Reset', `tr:rs:${slug}`)
    .row()
    .text('🗑️ Hapus', `tr:dv:${slug}`)
    .text('◀️ Kembali', 'tr:l');

  const payload = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  };

  if (edit && ctx.callbackQuery?.message?.message_id) {
    await ctx
      .api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message.message_id, lines.join('\n'), payload)
      .catch(() => {});
    return;
  }
  await ctx.reply(lines.join('\n'), payload);
}

export async function promptEdit(
  ctx: Context,
  env: Env,
  userId: number,
  slug: string,
  field: string
): Promise<void> {
  const all = await listAllTrackedAnime(env.DB);
  const row = all.find((r) => r.slug === slug);

  if (!row) {
    await ctx.answerCallbackQuery({ text: '❌ Tidak ditemukan' }).catch(() => {});
    return;
  }

  const sessionId = await createSession(env.DB, userId, 'edit_value', {
    slug,
    edit_field: field,
  });

  let prompt = '';
  let kb: InlineKeyboard | undefined;

  switch (field) {
    case 'site':
      prompt = `🎬 <b>Edit Site</b>\n\nAnime: <code>${escapeHtml(slug)}</code>\nSite sekarang: <b>${row.site}</b>\n\nPilih site baru:`;
      kb = new InlineKeyboard()
        .text('🎬 lexanime', `tr:set:${sessionId}:lexanime`)
        .text('🎬 animesub', `tr:set:${sessionId}:animesub`)
        .row()
        .text('🎬 samehadaku', `tr:set:${sessionId}:samehadaku`)
        .row()
        .text('❌ Batal', `tr:v:${slug}`);
      break;
    case 'status':
      prompt = `🔀 <b>Edit Status</b>\n\nAnime: <code>${escapeHtml(slug)}</code>\nStatus sekarang: <b>${row.status}</b>\n\nPilih status baru:`;
      kb = new InlineKeyboard()
        .text('🟢 Active', `tr:set:${sessionId}:active`)
        .text('⏸️ Paused', `tr:set:${sessionId}:paused`)
        .row()
        .text('✅ Finished', `tr:set:${sessionId}:finished`)
        .row()
        .text('❌ Batal', `tr:v:${slug}`);
      break;
    case 'schedule_day': {
      prompt = `📅 <b>Edit Hari</b>\n\nAnime: <code>${escapeHtml(slug)}</code>\nSekarang: <b>${row.schedule_day}</b>\n\nPilih hari baru:`;
      const kbd = new InlineKeyboard();
      for (let i = 0; i < 7; i++) {
        kbd.text(DAYS_SHORT[i]!, `tr:set:${sessionId}:${DAYS[i]}`);
        if ((i + 1) % 4 === 0) kbd.row();
      }
      kbd.text('🎲 Random', `tr:set:${sessionId}:Random`).row();
      kbd.text('❌ Batal', `tr:v:${slug}`);
      kb = kbd;
      break;
    }
    case 'schedule_hour':
      prompt = `⏰ <b>Edit Jam</b>\n\nAnime: <code>${escapeHtml(slug)}</code>\nSekarang: <b>${String(row.schedule_hour).padStart(2, '0')}:${String(row.schedule_minute ?? 0).padStart(2, '0')} WIB</b>\n\nKirim jam baru:\n<code>18</code> / <code>18:30</code> / <code>18.15</code>`;
      kb = new InlineKeyboard().text('❌ Batal', `tr:v:${slug}`);
      break;
    case 'last_ep':
      prompt = `📼 <b>Edit Last Episode</b>\n\nAnime: <code>${escapeHtml(slug)}</code>\nSekarang: <b>${row.last_ep}</b>\n\nKirim angka last_ep baru (0 = reset):`;
      kb = new InlineKeyboard().text('❌ Batal', `tr:v:${slug}`);
      break;
    case 'chunk':
      prompt = `📦 <b>Edit Chunk</b>\n\nAnime: <code>${escapeHtml(slug)}</code>\nSekarang: <b>${row.chunk_start}-${row.chunk_end}</b>\n\nKirim range: <code>2-6</code>`;
      kb = new InlineKeyboard().text('❌ Batal', `tr:v:${slug}`);
      break;
    case 'buffer_min':
      prompt = `⏱️ <b>Edit Buffer</b>\n\nAnime: <code>${escapeHtml(slug)}</code>\nSekarang: <b>${row.buffer_min}</b> menit\n\nKirim buffer baru (5-480):`;
      kb = new InlineKeyboard().text('❌ Batal', `tr:v:${slug}`);
      break;
    case 'source_slug':
      prompt = `🔗 <b>Edit Source Slug</b>\n\nAnime: <code>${escapeHtml(slug)}</code>\nSekarang: <code>${escapeHtml(row.source_slug)}</code>\n\nKirim slug baru, atau URL Samehadaku:`;
      kb = new InlineKeyboard().text('❌ Batal', `tr:v:${slug}`);
      break;
    default:
      await ctx.answerCallbackQuery({ text: '❌ Field tidak dikenal' }).catch(() => {});
      return;
  }

  await ctx.answerCallbackQuery().catch(() => {});
  await ctx
    .api.editMessageText(ctx.chat!.id, ctx.callbackQuery!.message!.message_id!, prompt, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
    })
    .catch(() => {});
}

export async function startAddFlow(
  ctx: Context,
  env: Env,
  userId: number
): Promise<void> {
  const sessionId = await createSession(env.DB, userId, 'add_site');
  const text =
    '<b>➕ Track Anime Baru</b>\n\n' +
    '<b>Step 1/5</b> · Pilih situs sumber:\n\n' +
    '<i>Bot akan cek situs ini setiap hari untuk episode baru.</i>';
  const kb = new InlineKeyboard()
    .text('🎬 lexanime', `tr:site:${sessionId}:lexanime`)
    .text('🎬 animesub', `tr:site:${sessionId}:animesub`)
    .row()
    .text('🎬 samehadaku', `tr:site:${sessionId}:samehadaku`)
    .row()
    .text('❌ Batal', `tr:x:${sessionId}`);

  const payload = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  };

  if (ctx.callbackQuery?.message?.message_id) {
    await ctx
      .api.editMessageText(ctx.chat!.id, ctx.callbackQuery.message.message_id, text, payload)
      .catch(() => {});
    return;
  }
  await ctx.reply(text, payload);
}

export async function handleCatchup(ctx: Context, env: Env): Promise<void> {
  const loading = await ctx.reply('🔍 Mencari anime yang tertinggal...');
  try {
    const all = await listAllTrackedAnime(env.DB);
    const active = all.filter((r) => r.status === 'active');
    const candidates = active.filter(isInScheduleWindow);

    if (candidates.length === 0) {
      await ctx.api.api.editMessageText(
        ctx.chat!.id, loading.message_id,
        `✅ <b>Semua anime up-to-date.</b>\n\n<i>Total aktif: ${active.length}.</i>`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard().text('🏠 Menu', 'tr:h') }
      );
      return;
    }

    const MAX_PER_RUN = 3;
    const batch = candidates.slice(0, MAX_PER_RUN);
    const remaining = candidates.length - batch.length;
    const results: { slug: string; pushed: number; error?: string }[] = [];
    let totalPushed = 0;

    for (let i = 0; i < batch.length; i++) {
      const row = batch[i]!;
      await ctx.api.api.editMessageText(
        ctx.chat!.id, loading.message_id,
        `🔄 <b>Catch-up</b> [${i + 1}/${batch.length}]\n\n🎬 <code>${escapeHtml(row.slug)}</code>`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      ).catch(() => {});
      try {
        const { runManualCheck } = await import('../lib/cron/runner');
        const res = await runManualCheck(env, row.slug);
        totalPushed += res.episodesPushed;
        results.push({ slug: row.slug, pushed: res.episodesPushed,
          error: res.errors.length > 0 ? res.errors[0] : undefined });
      } catch (err: any) {
        results.push({ slug: row.slug, pushed: 0, error: err?.message ?? 'unknown' });
      }
    }

    const lines: string[] = [];
    lines.push(`✅ <b>Catch-up selesai</b>`);
    lines.push('');
    lines.push(`📼 Push: <b>${totalPushed}</b>`);
    lines.push(`🔍 Dicek: <b>${batch.length}</b>`);
    const success = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    if (success.length > 0) {
      lines.push('');
      lines.push(`<b>✅ Sukses:</b>`);
      for (const r of success.slice(0, 10)) lines.push(`• <code>${escapeHtml(r.slug)}</code> — ${r.pushed} ep`);
    }
    if (failed.length > 0) {
      lines.push('');
      lines.push(`<b>⚠️ Gagal:</b>`);
      for (const r of failed.slice(0, 5))
        lines.push(`• <code>${escapeHtml(r.slug)}</code> — <i>${escapeHtml((r.error ?? '').slice(0, 80))}</i>`);
    }
    if (remaining > 0) {
      lines.push('');
      lines.push(`<i>⏭️ ${remaining} lain. Klik 🔄 lagi.</i>`);
    }
    const kb = new InlineKeyboard();
    if (remaining > 0) kb.text('🔄 Lanjut', 'tr:c').row();
    kb.text('🏠 Menu', 'tr:h');
    await ctx.api.api.editMessageText(ctx.chat!.id, loading.message_id, lines.join('\n'), {
      parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: kb,
    }).catch(() => {});
  } catch (err: any) {
    await ctx.api.api.editMessageText(
      ctx.chat!.id, loading.message_id,
      `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
}

/* ============================================================
   TEXT INPUT
   ============================================================ */

export async function handleTrackTextV2(ctx: Context, env: Env): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  const text = ctx.message?.text?.trim() ?? '';
  if (!text || text.startsWith('/')) return false;
  const session = await getLatestSession(env.DB, userId);
  if (!session) return false;
  switch (session.step) {
    case 'add_slug': return await handleAddSlug(ctx, env, session, text);
    case 'add_source': return await handleAddSource(ctx, env, session, text);
    case 'add_hour': return await handleAddHour(ctx, env, session, text);
    case 'edit_value': return await handleEditValue(ctx, env, session, text);
    default: return false;
  }
}

async function handleAddSlug(ctx: Context, env: Env, session: TrackSessionRow, slug: string): Promise<boolean> {
  if (!SLUG_RE.test(slug)) { await ctx.reply('❌ Slug invalid. Coba lagi:'); return true; }
  const path = `src/content/anime/${slug}.md`;
  let file: Awaited<ReturnType<typeof githubGetFile>> = null;
  try { file = await githubGetFile(env, path, 'qimochi'); } catch {}
  if (!file) {
    await ctx.reply(
      `❌ <b>Markdown belum ada di qimochi.</b>\n\nPath: <code>${escapeHtml(path)}</code>\n\n<i>Push dulu via /anime.</i>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return true;
  }
  await updateSession(env.DB, session.session_id, { slug, source_slug: slug, step: 'add_source' });
  const isSamehadaku = session.site === 'samehadaku';
  const prompt = isSamehadaku
    ? `<b>Step 3/5</b> · Slug di <b>samehadaku</b>\n\n🆔 Qimochi: <code>${escapeHtml(slug)}</code>\n\n<b>Opsi:</b>\n• URL anime Samehadaku\n• Slug langsung\n• <code>-</code> kalau sama`
    : `<b>Step 3/5</b> · Slug di <b>${session.site}</b>\n\n🆔 Qimochi: <code>${escapeHtml(slug)}</code>\n\n<b>Kalau sama:</b> kirim <code>-</code>\n<b>Kalau beda:</b> kirim slug situs`;
  await ctx.reply(prompt, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  return true;
}

async function handleAddSource(ctx: Context, env: Env, session: TrackSessionRow, input: string): Promise<boolean> {
  let sourceSlug: string;
  if (input === '-') {
    sourceSlug = session.slug ?? '';
  } else if (session.site === 'samehadaku' && /^https?:\/\//i.test(input)) {
    const extracted = extractSamehadakuSlug(input);
    if (!extracted) {
      await ctx.reply(
        '❌ URL Samehadaku invalid.\n• <code>https://samehadaku.li/anime/{slug}/</code>\n• <code>https://samehadaku.li/{slug}-episode-N-subtitle-indonesia/</code>',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return true;
    }
    sourceSlug = extracted;
    await ctx.reply(`✅ Slug: <code>${escapeHtml(sourceSlug)}</code>`, { parse_mode: 'HTML' });
  } else {
    sourceSlug = input.trim();
  }
  if (!SLUG_RE.test(sourceSlug)) { await ctx.reply('❌ Slug invalid. Kirim ulang:'); return true; }
  await updateSession(env.DB, session.session_id, { source_slug: sourceSlug, step: 'add_day' });
  const kb = new InlineKeyboard();
  for (let i = 0; i < 7; i++) {
    kb.text(DAYS_SHORT[i]!, `tr:day:${session.session_id}:${DAYS[i]}`);
    if ((i + 1) % 4 === 0) kb.row();
  }
  kb.text('🎲 Random', `tr:day:${session.session_id}:Random`).row();
  kb.text('❌ Batal', `tr:x:${session.session_id}`);
  await ctx.reply('<b>Step 4/5</b> · Pilih hari rilis:', {
    parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: kb,
  });
  return true;
}

async function handleAddHour(ctx: Context, env: Env, session: TrackSessionRow, input: string): Promise<boolean> {
  const parsed = parseTime(input);
  if (!parsed) {
    await ctx.reply('❌ Format jam invalid.\n\nContoh: <code>18</code> / <code>18:30</code> / <code>18.15</code>', { parse_mode: 'HTML' });
    return true;
  }
  await updateSession(env.DB, session.session_id, {
    schedule_hour: parsed.hour, schedule_minute: parsed.minute, step: 'add_confirm',
  });
  const hh = String(parsed.hour).padStart(2, '0');
  const mm = String(parsed.minute).padStart(2, '0');
  await ctx.reply(
    `📋 <b>Konfirmasi</b>\n\n🎬 Site: <b>${session.site}</b>\n🆔 <code>${escapeHtml(session.slug ?? '-')}</code>\n🔗 <code>${escapeHtml(session.source_slug ?? '-')}</code>\n📅 ${session.schedule_day} ${hh}:${mm} WIB\n\n<i>Klik Simpan.</i>`,
    {
      parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .text('✅ Simpan', `tr:save:${session.session_id}`)
        .text('❌ Batal', `tr:x:${session.session_id}`),
    }
  );
  return true;
}

async function handleEditValue(ctx: Context, env: Env, session: TrackSessionRow, input: string): Promise<boolean> {
  const slug = session.slug;
  const field = session.edit_field;
  if (!slug || !field) { await deleteSession(env.DB, session.session_id); return false; }

  const patch: Record<string, unknown> = {};
  let error: string | null = null;

  if (field === 'schedule_hour') {
    const parsed = parseTime(input);
    if (parsed) { patch.schedule_hour = parsed.hour; patch.schedule_minute = parsed.minute; }
    else error = 'Format jam invalid. Contoh: 18 atau 18:30';
  } else if (field === 'last_ep') {
    const n = parseInt(input.trim(), 10);
    if (!isNaN(n) && n >= 0 && n <= 9999) patch.last_ep = n;
    else error = 'Angka 0-9999';
  } else if (field === 'chunk') {
    const m = input.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { patch.chunk_start = parseInt(m[1] ?? '0', 10); patch.chunk_end = parseInt(m[2] ?? '0', 10); }
    else error = 'Format: 2-6';
  } else if (field === 'buffer_min') {
    const n = parseInt(input.trim(), 10);
    if (!isNaN(n) && n >= 5 && n <= 480) patch.buffer_min = n;
    else error = 'Angka 5-480';
  } else if (field === 'source_slug') {
    let s = input.trim();
    if (session.site === 'samehadaku' && /^https?:\/\//i.test(s)) {
      const extracted = extractSamehadakuSlug(s);
      if (extracted) s = extracted;
    }
    if (SLUG_RE.test(s)) patch.source_slug = s;
    else error = 'Slug invalid';
  }

  if (error) { await ctx.reply(`❌ ${error}\n\nCoba lagi:`); return true; }

  await updateTrackedAnime(env.DB, slug, patch);
  await deleteSession(env.DB, session.session_id);
  await ctx.reply(`✅ <b>Updated:</b> <code>${escapeHtml(slug)}</code>`, {
    parse_mode: 'HTML', link_preview_options: { is_disabled: true },
  });
  await showDetail(ctx, env, slug, false);
  return true;
}

/* ============================================================
   COMMAND
   ============================================================ */

export const trackCommand: CommandDefinition = {
  name: 'track',
  description: 'Track anime + episode auto-fetch',
  usage: '/track',
  adminOnly: true,

  handler: async (ctx, env) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const parts = arg.split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? '').toLowerCase();

    if (!sub) { await showMainMenu(ctx, env); return; }
    if (sub === 'add') {
      const userId = ctx.from?.id;
      if (!userId) return;
      await startAddFlow(ctx, env, userId);
      return;
    }
    if (sub === 'list') { await showList(ctx, env, 0); return; }
    if (sub === 'catchup') { await handleCatchup(ctx, env); return; }
    if (sub === 'remove') {
      const slug = parts[1];
      if (!slug) { await ctx.reply('Usage: <code>/track remove &lt;slug&gt;</code>', { parse_mode: 'HTML' }); return; }
      const ok = await deleteTrackedAnime(env.DB, slug);
      await ctx.reply(ok ? `✅ <code>${escapeHtml(slug)}</code> dihapus.` : `❌ Tidak ada: <code>${escapeHtml(slug)}</code>`, { parse_mode: 'HTML' });
      return;
    }
    if (sub === 'check') {
      const slug = parts[1];
      if (!slug) { await ctx.reply('Usage: <code>/track check &lt;slug&gt;</code>', { parse_mode: 'HTML' }); return; }
      const loading = await ctx.reply(`🔍 Cek <code>${escapeHtml(slug)}</code>...`, {
        parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      });
      try {
        const { runManualCheck } = await import('../lib/cron/runner');
        const result = await runManualCheck(env, slug);
        const lines: string[] = [];
        lines.push(`📡 <b>Check: ${escapeHtml(slug)}</b>`);
        lines.push('');
        lines.push(`🔍 Dicek: <b>${result.animeChecked}</b>`);
        lines.push(`📼 Push: <b>${result.episodesPushed}</b>`);
        if (result.errors.length > 0) {
          lines.push('');
          lines.push('⚠️ <b>Error:</b>');
          for (const e of result.errors) lines.push(`• <code>${escapeHtml(e.slice(0, 200))}</code>`);
        }
        await ctx.api.api.editMessageText(ctx.chat!.id, loading.message_id, lines.join('\n'), {
          parse_mode: 'HTML', link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard().text('🏠 Menu', 'tr:h'),
        }).catch(() => {});
      } catch (err: any) {
        await ctx.api.api.editMessageText(
          ctx.chat!.id, loading.message_id,
          `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
      return;
    }
    await ctx.reply('❌ Subcommand tidak dikenal.\n\n<i>Ketik <code>/track</code> untuk menu.</i>', { parse_mode: 'HTML' });
  },
};

/* ============================================================
   CALLBACKS
   ============================================================ */

export function setupTrackCallbacks(bot: Bot, env: Env): void {
  // Menu actions
  bot.callbackQuery(/^tr:h$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '🏠' });
    await showMainMenu(ctx, env, true);
  });
  bot.callbackQuery(/^tr:a$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    await ctx.answerCallbackQuery({ text: '➕' });
    await startAddFlow(ctx, env, userId);
  });
  bot.callbackQuery(/^tr:l$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showList(ctx, env, 0);
  });
  bot.callbackQuery(/^tr:c$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '🔄' });
    await handleCatchup(ctx, env);
  });
  bot.callbackQuery(/^tr:lp:(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1] ?? '0', 10);
    await ctx.answerCallbackQuery().catch(() => {});
    await showList(ctx, env, page);
  });
  bot.callbackQuery(/^tr:v:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await ctx.answerCallbackQuery().catch(() => {});
    await showDetail(ctx, env, slug, true);
  });
  bot.callbackQuery(/^tr:e:(.+):(\w+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    const field = ctx.match[2] ?? '';
    const userId = ctx.from?.id;
    if (!userId) return;
    await promptEdit(ctx, env, userId, slug, field);
  });
  bot.callbackQuery(/^tr:set:(ts_[a-z0-9]+):(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const value = ctx.match[2] ?? '';
    const session = await getSession(env.DB, sessionId);
    if (!session) { await ctx.answerCallbackQuery({ text: '⏱️ Kadaluarsa', show_alert: true }); return; }
    if (ctx.from?.id !== session.user_id) { await ctx.answerCallbackQuery({ text: '⛔' }); return; }
    if (!session.slug || !session.edit_field) { await ctx.answerCallbackQuery({ text: '❌ Data kurang' }); return; }
    const patch: Record<string, unknown> = {};
    const field = session.edit_field;
    if (field === 'site') { if (!isValidSite(value)) { await ctx.answerCallbackQuery({ text: '❌' }); return; } patch.site = value; }
    else if (field === 'status') { if (!['active','paused','finished'].includes(value)) { await ctx.answerCallbackQuery({ text: '❌' }); return; } patch.status = value; }
    else if (field === 'schedule_day') { patch.schedule_day = value; }
    else { await ctx.answerCallbackQuery({ text: '❌ Butuh input teks' }); return; }
    await updateTrackedAnime(env.DB, session.slug, patch);
    await deleteSession(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '✅' });
    await showDetail(ctx, env, session.slug!, true);
  });
  bot.callbackQuery(/^tr:cx:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await ctx.answerCallbackQuery({ text: '🔄 Cek...' });
    const loading = await ctx.reply(`🔍 Cek <code>${escapeHtml(slug)}</code>...`, {
      parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    });
    try {
      const { runManualCheck } = await import('../lib/cron/runner');
      const result = await runManualCheck(env, slug);
      const lines: string[] = [];
      lines.push(`📡 <b>Check: ${escapeHtml(slug)}</b>`);
      lines.push('');
      lines.push(`🔍 Dicek: <b>${result.animeChecked}</b>`);
      lines.push(`📼 Push: <b>${result.episodesPushed}</b>`);
      if (result.errors.length > 0) {
        lines.push('');
        lines.push('⚠️ <b>Error:</b>');
        for (const e of result.errors.slice(0, 3)) lines.push(`• <code>${escapeHtml(e.slice(0, 150))}</code>`);
      }
      await ctx.api.api.editMessageText(ctx.chat!.id, loading.message_id, lines.join('\n'), {
        parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().text('◀️ Kembali', `tr:v:${slug}`),
      }).catch(() => {});
    } catch (err: any) {
      await ctx.api.api.editMessageText(ctx.chat!.id, loading.message_id,
        `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 200))}</code>`,
        { parse_mode: 'HTML' }).catch(() => {});
    }
  });
  bot.callbackQuery(/^tr:rs:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await updateTrackedAnime(env.DB, slug, { last_ep: 0, chunk_start: 0, chunk_end: 0 });
    await ctx.answerCallbackQuery({ text: '♻️ Reset' });
    await showDetail(ctx, env, slug, true);
  });
  bot.callbackQuery(/^tr:dv:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await ctx.answerCallbackQuery({ text: '⚠️' });
    await ctx.api.editMessageText(ctx.chat!.id, ctx.callbackQuery!.message!.message_id!,
      `⚠️ <b>Hapus anime?</b>\n\n<code>${escapeHtml(slug)}</code>`,
      {
        parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text('✅ Ya, Hapus', `tr:dvy:${slug}`)
          .text('❌ Batal', `tr:v:${slug}`),
      }).catch(() => {});
  });
  bot.callbackQuery(/^tr:dvy:(.+)$/, async (ctx) => {
    const slug = ctx.match[1] ?? '';
    await deleteTrackedAnime(env.DB, slug);
    await ctx.answerCallbackQuery({ text: '🗑️ Terhapus' });
    await showList(ctx, env, 0);
  });

  // Delete menu
  bot.callbackQuery(/^tr:dm$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showDeleteMenu(ctx, env);
  });
  bot.callbackQuery(/^tr:ds:(\w+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    if (!isValidSite(site)) { await ctx.answerCallbackQuery({ text: '❌' }); return; }
    await ctx.answerCallbackQuery().catch(() => {});
    await showDeleteSite(ctx, env, site);
  });
  bot.callbackQuery(/^tr:dall:(\w+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    if (!isValidSite(site)) { await ctx.answerCallbackQuery({ text: '❌' }); return; }
    await ctx.answerCallbackQuery({ text: '⚠️' });
    await confirmDeleteAll(ctx, env, site);
  });
  bot.callbackQuery(/^tr:dally:(\w+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    if (!isValidSite(site)) { await ctx.answerCallbackQuery({ text: '❌' }); return; }
    await ctx.answerCallbackQuery({ text: '🗑️' });
    await execDeleteAll(ctx, env, site);
  });
  bot.callbackQuery(/^tr:dsel:(\w+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    if (!isValidSite(site)) { await ctx.answerCallbackQuery({ text: '❌' }); return; }
    await ctx.answerCallbackQuery().catch(() => {});
    await showDeleteSelect(ctx, env, site, 0);
  });
  bot.callbackQuery(/^tr:dt:(\w+):(\d+):(\d+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    const mask = parseInt(ctx.match[2] ?? '0', 10);
    const idx = parseInt(ctx.match[3] ?? '0', 10);
    if (!isValidSite(site)) { await ctx.answerCallbackQuery({ text: '❌' }); return; }
    await toggleDeleteSelect(ctx, env, site, mask, idx);
  });
  bot.callbackQuery(/^tr:dgo:(\w+):(\d+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    const mask = parseInt(ctx.match[2] ?? '0', 10);
    if (!isValidSite(site)) { await ctx.answerCallbackQuery({ text: '❌' }); return; }
    await confirmDeleteSelected(ctx, env, site, mask);
  });
  bot.callbackQuery(/^tr:dgy:(\w+):(\d+)$/, async (ctx) => {
    const site = ctx.match[1] ?? '';
    const mask = parseInt(ctx.match[2] ?? '0', 10);
    if (!isValidSite(site)) { await ctx.answerCallbackQuery({ text: '❌' }); return; }
    await execDeleteSelected(ctx, env, site, mask);
  });

  // Add flow callbacks
  bot.callbackQuery(/^tr:site:(ts_[a-z0-9]+):(lexanime|animesub|samehadaku)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const site = (ctx.match[2] ?? '') as SiteKey;
    const session = await getSession(env.DB, sessionId);
    if (!session) { await ctx.answerCallbackQuery({ text: '⏱️', show_alert: true }); return; }
    if (ctx.from?.id !== session.user_id) { await ctx.answerCallbackQuery({ text: '⛔' }); return; }
    await updateSession(env.DB, sessionId, { site, step: 'add_slug' });
    await ctx.answerCallbackQuery({ text: site });
    await ctx.api.editMessageText(
      '<b>Step 2/5</b> · Kirim <b>slug anime</b> qimochi.\n\n<i>Contoh: <code>tensei-goblin-dakedo-shitsumon-aru</code></i>',
      {
        parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().text('❌ Batal', `tr:x:${sessionId}`),
      }
    ).catch(() => {});
  });
  bot.callbackQuery(/^tr:day:(ts_[a-z0-9]+):([A-Za-z]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const day = ctx.match[2] ?? '';
    const session = await getSession(env.DB, sessionId);
    if (!session) { await ctx.answerCallbackQuery({ text: '⏱️', show_alert: true }); return; }
    if (ctx.from?.id !== session.user_id) { await ctx.answerCallbackQuery({ text: '⛔' }); return; }
    await updateSession(env.DB, sessionId, { schedule_day: day, step: 'add_hour' });
    await ctx.answerCallbackQuery({ text: day });
    await ctx.api.editMessageText(
      `<b>Step 5/5</b> · Hari: <b>${day}</b>\n\nKirim <b>jam rilis</b> (WIB):\n\n• <code>18</code> → 18:00\n• <code>18:30</code> → 18:30\n• <code>18.15</code> → 18:15`,
      {
        parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().text('❌ Batal', `tr:x:${sessionId}`),
      }
    ).catch(() => {});
  });
  bot.callbackQuery(/^tr:save:(ts_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const session = await getSession(env.DB, sessionId);
    if (!session) { await ctx.answerCallbackQuery({ text: '⏱️', show_alert: true }); return; }
    if (ctx.from?.id !== session.user_id) { await ctx.answerCallbackQuery({ text: '⛔' }); return; }
    if (!session.site || !session.slug || !session.source_slug || !session.schedule_day || session.schedule_hour === null) {
      await ctx.answerCallbackQuery({ text: '❌ Data kurang', show_alert: true }); return;
    }
    const site = session.site as SiteKey;
    const fallbackSite: SiteKey | null =
      site === 'lexanime' ? 'animesub' : site === 'animesub' ? 'lexanime' : null;
    await saveTrackedAnime(env.DB, {
      slug: session.slug, site, sourceSlug: session.source_slug, fallbackSite,
      scheduleDay: session.schedule_day, scheduleHour: session.schedule_hour,
      scheduleMinute: session.schedule_minute ?? 0, bufferMin: session.buffer_min,
    });
    await deleteSession(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '✅ Tersimpan' });
    const hh = String(session.schedule_hour).padStart(2, '0');
    const mm = String(session.schedule_minute ?? 0).padStart(2, '0');
    await ctx.api.editMessageText(
      `✅ <b>Anime di-track!</b>\n\n🆔 <code>${escapeHtml(session.slug)}</code>\n🎬 ${site}\n📅 ${session.schedule_day} ${hh}:${mm} WIB`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: undefined }
    ).catch(() => {});
  });
  bot.callbackQuery(/^tr:x:(ts_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    await deleteSession(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '🗑️' });
    await ctx.api.editMessageText('❌ <b>Dibatalkan.</b>', { parse_mode: 'HTML', reply_markup: undefined }).catch(() => {});
  });
}

/* ============================================================
   DELETE MENU (internal)
   ============================================================ */

async function showDeleteMenu(ctx: Context, env: Env): Promise<void> {
  const all = await listAllTrackedAnime(env.DB);
  const counts: Record<SiteKey, number> = { lexanime: 0, animesub: 0, samehadaku: 0 };
  for (const r of all) { if (r.site in counts) counts[r.site]++; }
  const total = counts.lexanime + counts.animesub + counts.samehadaku;
  if (total === 0) {
    await ctx.api.editMessageText('📭 Belum ada anime.', {
      parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard().text('◀️ Kembali', 'tr:h'),
    }).catch(() => {});
    return;
  }
  const kb = new InlineKeyboard();
  if (counts.lexanime > 0) kb.text(`🎬 lexanime (${counts.lexanime})`, 'tr:ds:lexanime').row();
  if (counts.animesub > 0) kb.text(`🎬 animesub (${counts.animesub})`, 'tr:ds:animesub').row();
  if (counts.samehadaku > 0) kb.text(`🎬 samehadaku (${counts.samehadaku})`, 'tr:ds:samehadaku').row();
  kb.text('◀️ Kembali', 'tr:h');
  await ctx.api.editMessageText(
    `🗑️ <b>Hapus Anime</b>\n\nTotal: <b>${total}</b>\n\n<i>Pilih situs:</i>`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: kb }
  ).catch(() => {});
}

async function showDeleteSite(ctx: Context, env: Env, site: SiteKey): Promise<void> {
  const all = await listAllTrackedAnime(env.DB);
  const list = all.filter((r) => r.site === site).sort((a, b) => a.slug.localeCompare(b.slug));
  if (list.length === 0) {
    await ctx.api.editMessageText(`📭 Tidak ada anime dari <b>${site}</b>.`, {
      parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard().text('◀️ Kembali', 'tr:dm'),
    }).catch(() => {});
    return;
  }
  const lines: string[] = [];
  lines.push(`🗑️ <b>Hapus dari ${escapeHtml(site)}</b>`);
  lines.push('');
  lines.push(`📊 Total: <b>${list.length}</b>`);
  lines.push('');
  for (const r of list.slice(0, 8)) lines.push(`• <code>${escapeHtml(r.slug)}</code>`);
  if (list.length > 8) lines.push(`<i>… dan ${list.length - 8} lainnya</i>`);
  const kb = new InlineKeyboard()
    .text(`🗑️ Hapus Semua (${list.length})`, `tr:dall:${site}`)
    .row()
    .text('☑️ Pilih Satu-satu', `tr:dsel:${site}`)
    .row()
    .text('◀️ Kembali', 'tr:dm');
  await ctx.api.editMessageText(lines.join('\n'), {
    parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: kb,
  }).catch(() => {});
}

async function confirmDeleteAll(ctx: Context, env: Env, site: SiteKey): Promise<void> {
  const all = await listAllTrackedAnime(env.DB);
  const list = all.filter((r) => r.site === site);
  const lines: string[] = [];
  lines.push('⚠️ <b>Konfirmasi Hapus Semua</b>');
  lines.push('');
  lines.push(`Yakin hapus <b>${list.length}</b> anime dari <b>${escapeHtml(site)}</b>?`);
  lines.push('');
  for (const r of list.slice(0, 10)) lines.push(`• <code>${escapeHtml(r.slug)}</code>`);
  if (list.length > 10) lines.push(`<i>… dan ${list.length - 10} lainnya</i>`);
  lines.push('');
  lines.push('<b>⚠️ Tidak bisa dibatalkan.</b>');
  await ctx.api.editMessageText(lines.join('\n'), {
    parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    reply_markup: new InlineKeyboard()
      .text('✅ Ya, Hapus Semua', `tr:dally:${site}`)
      .text('❌ Batal', `tr:ds:${site}`),
  }).catch(() => {});
}

async function execDeleteAll(ctx: Context, env: Env, site: SiteKey): Promise<void> {
  const all = await listAllTrackedAnime(env.DB);
  const list = all.filter((r) => r.site === site);
  let deleted = 0;
  for (const r of list) {
    const ok = await deleteTrackedAnime(env.DB, r.slug);
    if (ok) deleted++;
  }
  await ctx.api.editMessageText(
    `✅ <b>Hapus selesai</b>\n\n🗑️ Dihapus: <b>${deleted}</b>\nSitus: <b>${escapeHtml(site)}</b>`,
    {
      parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .text('🗑️ Hapus Lagi', 'tr:dm')
        .text('🏠 Menu', 'tr:h'),
    }
  ).catch(() => {});
}

function countBits(n: number): number {
  let c = 0, x = n;
  while (x > 0) { c += x & 1; x >>>= 1; }
  return c;
}

async function showDeleteSelect(ctx: Context, env: Env, site: SiteKey, mask: number): Promise<void> {
  const all = await listAllTrackedAnime(env.DB);
  const list = all.filter((r) => r.site === site).sort((a, b) => a.slug.localeCompare(b.slug));
  const selected = countBits(mask);
  const kb = new InlineKeyboard();
  list.forEach((row, i) => {
    const mark = (mask & (1 << i)) !== 0 ? '✅' : '⬜';
    const label = `${mark} ${row.slug}`;
    const short = label.length > 44 ? label.slice(0, 42) + '…' : label;
    kb.text(short, `tr:dt:${site}:${mask}:${i}`).row();
  });
  kb.text(`🗑️ Hapus (${selected})`, `tr:dgo:${site}:${mask}`)
    .text('❌ Batal', `tr:ds:${site}`);
  await ctx.api.editMessageText(
    `☑️ <b>Pilih — ${escapeHtml(site)}</b>\n\nTotal: <b>${list.length}</b> · Dipilih: <b>${selected}</b>\n\n<i>Tap untuk toggle.</i>`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: kb }
  ).catch(() => {});
}

async function toggleDeleteSelect(ctx: Context, env: Env, site: SiteKey, mask: number, idx: number): Promise<void> {
  const all = await listAllTrackedAnime(env.DB);
  const list = all.filter((r) => r.site === site).sort((a, b) => a.slug.localeCompare(b.slug));
  if (idx < 0 || idx >= list.length) { await ctx.answerCallbackQuery({ text: '❌' }); return; }
  const newMask = mask ^ (1 << idx);
  await ctx.answerCallbackQuery({ text: '✓' });
  await showDeleteSelect(ctx, env, site, newMask);
}

async function confirmDeleteSelected(ctx: Context, env: Env, site: SiteKey, mask: number): Promise<void> {
  if (mask === 0) { await ctx.answerCallbackQuery({ text: '❌ Tidak ada dipilih', show_alert: true }); return; }
  const all = await listAllTrackedAnime(env.DB);
  const list = all.filter((r) => r.site === site).sort((a, b) => a.slug.localeCompare(b.slug));
  const selected = list.filter((_, i) => (mask & (1 << i)) !== 0);
  const lines: string[] = [];
  lines.push('⚠️ <b>Konfirmasi</b>');
  lines.push('');
  lines.push(`Hapus <b>${selected.length}</b> anime?`);
  lines.push('');
  for (const r of selected.slice(0, 15)) lines.push(`• <code>${escapeHtml(r.slug)}</code>`);
  await ctx.answerCallbackQuery({ text: '⚠️' });
  await ctx.api.editMessageText(lines.join('\n'), {
    parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    reply_markup: new InlineKeyboard()
      .text('✅ Ya, Hapus', `tr:dgy:${site}:${mask}`)
      .text('❌ Batal', `tr:dsel:${site}`),
  }).catch(() => {});
}

async function execDeleteSelected(ctx: Context, env: Env, site: SiteKey, mask: number): Promise<void> {
  const all = await listAllTrackedAnime(env.DB);
  const list = all.filter((r) => r.site === site).sort((a, b) => a.slug.localeCompare(b.slug));
  const selected = list.filter((_, i) => (mask & (1 << i)) !== 0);
  if (selected.length === 0) { await ctx.answerCallbackQuery({ text: '❌' }); return; }
  await ctx.answerCallbackQuery({ text: '🗑️' });
  let deleted = 0;
  for (const r of selected) {
    const ok = await deleteTrackedAnime(env.DB, r.slug);
    if (ok) deleted++;
  }
  await ctx.api.editMessageText(
    `✅ <b>Selesai</b>\n\n🗑️ Dihapus: <b>${deleted}</b>\nSitus: <b>${escapeHtml(site)}</b>`,
    {
      parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .text('🗑️ Hapus Lagi', 'tr:dm')
        .text('🏠 Menu', 'tr:h'),
    }
  ).catch(() => {});
}