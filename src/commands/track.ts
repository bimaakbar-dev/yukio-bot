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
  setTrackedStatus,
  formatScheduleTime,
  isInScheduleWindow,
  type SiteKey,
  type TrackedAnimeRow,
} from '../lib/cron/state';
import { updateTrackedAnime } from '../lib/cron/state-extra';
import { createLazyInit } from '../lib/lazy-init';

/* ============================================================
   CONSTANTS
   ============================================================ */

const ALL_SITES: SiteKey[] = ['lexanime', 'animesub', 'samehadaku'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const PER_PAGE = 8;
const SESSION_TTL_MS = 15 * 60 * 1000;

const SITE_LABEL: Record<SiteKey, string> = {
  lexanime: '🎬 lexanime',
  animesub: '🎬 animesub',
  samehadaku: '🎬 samehadaku',
};

const DAYS = [
  'Senin',
  'Selasa',
  'Rabu',
  'Kamis',
  'Jumat',
  'Sabtu',
  'Minggu',
  'Random',
];

const DAYS_SHORT = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

/* ============================================================
   INLINE STATE — EDIT SESSIONS
   ============================================================ */

export type EditStep =
  | 'add_site'
  | 'add_slug'
  | 'add_source'
  | 'add_day'
  | 'add_hour'
  | 'add_confirm'
  | 'edit_value';

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

export const ensureSessionDb = createLazyInit('TrackSessV2', async (db) => {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS track_sessions_v2 (
        session_id       TEXT PRIMARY KEY,
        user_id          INTEGER NOT NULL,
        step             TEXT NOT NULL,
        site             TEXT,
        slug             TEXT,
        source_slug      TEXT,
        schedule_day     TEXT,
        schedule_hour    INTEGER,
        schedule_minute  INTEGER,
        buffer_min       INTEGER NOT NULL DEFAULT 60,
        edit_field       TEXT,
        created_at       INTEGER NOT NULL,
        expires_at       INTEGER NOT NULL
      )`
    )
    .run();
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

  await db
    .prepare(
      `INSERT INTO track_sessions_v2
        (session_id, user_id, step, site, slug, source_slug, schedule_day,
         schedule_hour, schedule_minute, buffer_min, edit_field, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      userId,
      step,
      initial.site ?? null,
      initial.slug ?? null,
      initial.source_slug ?? null,
      initial.schedule_day ?? null,
      initial.schedule_hour ?? null,
      initial.schedule_minute ?? null,
      initial.buffer_min ?? 60,
      initial.edit_field ?? null,
      now,
      now + SESSION_TTL_MS
    )
    .run();

  return sessionId;
}

export async function getSession(
  db: D1Database,
  sessionId: string
): Promise<TrackSessionRow | null> {
  await ensureSessionDb(db);
  const row = await db
    .prepare('SELECT * FROM track_sessions_v2 WHERE session_id = ?')
    .bind(sessionId)
    .first<TrackSessionRow>();

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM track_sessions_v2 WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }
  return row;
}

export async function getLatestSession(
  db: D1Database,
  userId: number
): Promise<TrackSessionRow | null> {
  await ensureSessionDb(db);
  return db
    .prepare(
      `SELECT * FROM track_sessions_v2
       WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(userId, Date.now())
    .first<TrackSessionRow>();
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

  await db
    .prepare(`UPDATE track_sessions_v2 SET ${sets.join(', ')} WHERE session_id = ?`)
    .bind(...values)
    .run();
}

export async function deleteSession(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await ensureSessionDb(db);
    await db
      .prepare('DELETE FROM track_sessions_v2 WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch {}
}

/* ============================================================
   UTILS
   ============================================================ */

function isValidSite(s: string): s is SiteKey {
  return ALL_SITES.includes(s as SiteKey);
}

function countBits(n: number): number {
  let c = 0, x = n;
  while (x > 0) {
    c += x & 1;
    x >>>= 1;
  }
  return c;
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

async function fetchBySite(env: Env, site: SiteKey): Promise<TrackedAnimeRow[]> {
  const all = await listAllTrackedAnime(env.DB);
  return all.filter((r) => r.site === site).sort((a, b) => a.slug.localeCompare(b.slug));
}

async function countBySite(env: Env): Promise<Record<SiteKey, number>> {
  const all = await listAllTrackedAnime(env.DB);
  const result: Record<SiteKey, number> = { lexanime: 0, animesub: 0, samehadaku: 0 };
  for (const r of all) {
    if (r.site in result) result[r.site]++;
  }
  return result;
}

/* ============================================================
   MENU
   ============================================================ */

async function showMainMenu(ctx: Context, env: Env, edit = false): Promise<void> {
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

  if (edit && ctx.callbackQuery?.message?.message_id) {
    await ctx
      .editMessageText(lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      })
      .catch(() => {});
    return;
  }

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

/* ============================================================
   LIST
   ============================================================ */

async function showList(ctx: Context, env: Env, page = 0): Promise<void> {
  const all = await listAllTrackedAnime(env.DB);
  all.sort((a, b) => a.slug.localeCompare(b.slug));

  if (all.length === 0) {
    await ctx.reply('📭 Belum ada anime.\n\n<i>Klik ➕ Tambah Baru.</i>', {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard().text('◀️ Kembali', 'tr:h'),
    });
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
    await ctx
      .editMessageText(ctx.chat!.id, ctx.callbackQuery.message.message_id, lines.join('\n'), payload)
      .catch(() => {});
    return;
  }

  await ctx.reply(lines.join('\n'), payload);
}

/* ============================================================
   DETAIL VIEW
   ============================================================ */

async function showDetail(
  ctx: Context,
  env: Env,
  slug: string,
  edit = false
): Promise<void> {
  const all = await listAllTrackedAnime(env.DB);
  const row = all.find((r) => r.slug === slug);

  if (!row) {
    await ctx.answerCallbackQuery({
      text: '❌ Tidak ditemukan',
      show_alert: true,
    }).catch(() => {});
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
      .editMessageText(ctx.chat!.id, ctx.callbackQuery.message.message_id, lines.join('\n'), payload)
      .catch(() => {});
    return;
  }

  await ctx.reply(lines.join('\n'), payload);
}

/* ============================================================
   EDIT PROMPT
   ============================================================ */

async function promptEdit(
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
      prompt =
        `🎬 <b>Edit Site</b>\n\n` +
        `Anime: <code>${escapeHtml(slug)}</code>\n` +
        `Site sekarang: <b>${row.site}</b>\n\n` +
        `Pilih site baru:`;
      kb = new InlineKeyboard()
        .text('🎬 lexanime', `tr:set:${sessionId}:lexanime`)
        .text('🎬 animesub', `tr:set:${sessionId}:animesub`)
        .row()
        .text('🎬 samehadaku', `tr:set:${sessionId}:samehadaku`)
        .row()
        .text('❌ Batal', `tr:v:${slug}`);
      break;

    case 'status':
      prompt =
        `🔀 <b>Edit Status</b>\n\n` +
        `Anime: <code>${escapeHtml(slug)}</code>\n` +
        `Status sekarang: <b>${row.status}</b>\n\n` +
        `Pilih status baru:`;
      kb = new InlineKeyboard()
        .text('🟢 Active', `tr:set:${sessionId}:active`)
        .text('⏸️ Paused', `tr:set:${sessionId}:paused`)
        .row()
        .text('✅ Finished', `tr:set:${sessionId}:finished`)
        .row()
        .text('❌ Batal', `tr:v:${slug}`);
      break;

    case 'schedule_day':
      prompt =
        `📅 <b>Edit Hari</b>\n\n` +
        `Anime: <code>${escapeHtml(slug)}</code>\n` +
        `Sekarang: <b>${row.schedule_day}</b>\n\n` +
        `Pilih hari baru:`;
      {
        const kbd = new InlineKeyboard();
        for (let i = 0; i < 7; i++) {
          kbd.text(DAYS_SHORT[i]!, `tr:set:${sessionId}:${DAYS[i]}`);
          if ((i + 1) % 4 === 0) kbd.row();
        }
        kbd.text('🎲 Random', `tr:set:${sessionId}:Random`).row();
        kbd.text('❌ Batal', `tr:v:${slug}`);
        kb = kbd;
      }
      break;

    case 'schedule_hour':
      prompt =
        `⏰ <b>Edit Jam</b>\n\n` +
        `Anime: <code>${escapeHtml(slug)}</code>\n` +
        `Sekarang: <b>${String(row.schedule_hour).padStart(2, '0')}:${String(row.schedule_minute ?? 0).padStart(2, '0')} WIB</b>\n\n` +
        `Kirim jam baru (WIB, 24 jam):\n` +
        `<code>18</code> / <code>18:30</code> / <code>18.15</code>`;
      kb = new InlineKeyboard().text('❌ Batal', `tr:v:${slug}`);
      break;

    case 'last_ep':
      prompt =
        `📼 <b>Edit Last Episode</b>\n\n` +
        `Anime: <code>${escapeHtml(slug)}</code>\n` +
        `Sekarang: <b>${row.last_ep}</b>\n\n` +
        `Kirim angka last_ep baru (0 untuk reset):\n` +
        `<i>Set 0 → bot akan re-detect dari awal</i>`;
      kb = new InlineKeyboard().text('❌ Batal', `tr:v:${slug}`);
      break;

    case 'chunk':
      prompt =
        `📦 <b>Edit Chunk</b>\n\n` +
        `Anime: <code>${escapeHtml(slug)}</code>\n` +
        `Sekarang: <b>${row.chunk_start}-${row.chunk_end}</b>\n\n` +
        `Kirim range chunk baru:\n` +
        `Format: <code>2-6</code> (start-end)`;
      kb = new InlineKeyboard().text('❌ Batal', `tr:v:${slug}`);
      break;

    case 'buffer_min':
      prompt =
        `⏱️ <b>Edit Buffer</b>\n\n` +
        `Anime: <code>${escapeHtml(slug)}</code>\n` +
        `Sekarang: <b>${row.buffer_min}</b> menit\n\n` +
        `Kirim buffer baru (menit):\n` +
        `<i>Minimal 5, maksimal 480</i>`;
      kb = new InlineKeyboard().text('❌ Batal', `tr:v:${slug}`);
      break;

    case 'source_slug':
      prompt =
        `🔗 <b>Edit Source Slug</b>\n\n` +
        `Anime: <code>${escapeHtml(slug)}</code>\n` +
        `Sekarang: <code>${escapeHtml(row.source_slug)}</code>\n\n` +
        `Kirim slug baru:\n` +
        `• Slug langsung: <code>tensei-goblin-shitsumon-sub-indo</code>\n` +
        `• Atau URL Samehadaku: <code>https://samehadaku.li/anime/...</code>`;
      kb = new InlineKeyboard().text('❌ Batal', `tr:v:${slug}`);
      break;

    default:
      await ctx.answerCallbackQuery({ text: '❌ Field tidak dikenal' }).catch(() => {});
      return;
  }

  await ctx.answerCallbackQuery().catch(() => {});
  await ctx
    .editMessageText(ctx.chat!.id, ctx.callbackQuery!.message!.message_id!, prompt, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
    })
    .catch(() => {});
}