// src/commands/track/ui.ts
import { InlineKeyboard } from 'grammy';
import { escapeHtml } from '../../lib/utils';
import type { TrackSessionRow } from './state';

export const SITE_LABELS: Record<string, string> = {
  lexanime: '🎬 lexanime',
  animesub: '🎬 animesub',
};

export const DAYS_ORDER = [
  'Senin',
  'Selasa',
  'Rabu',
  'Kamis',
  'Jumat',
  'Sabtu',
  'Minggu',
  'Random',
];

export function buildSiteKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('🎬 lexanime', `tr:site:${sessionId}:lexanime`)
    .text('🎬 animesub', `tr:site:${sessionId}:animesub`)
    .row()
    .text('❌ Batal', `tr:x:${sessionId}`);
}

export function buildDayKeyboard(sessionId: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  const short = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

  for (let i = 0; i < short.length; i++) {
    const day = DAYS_ORDER[i]!;
    kb.text(short[i]!, `tr:day:${sessionId}:${day}`);
    if ((i + 1) % 4 === 0) kb.row();
  }
  kb.text('🎲 Random', `tr:day:${sessionId}:Random`).row();
  kb.text('❌ Batal', `tr:x:${sessionId}`);
  return kb;
}

export function buildConfirmKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Simpan', `tr:save:${sessionId}`)
    .text('❌ Batal', `tr:x:${sessionId}`);
}

export function buildSitePrompt(sessionId: string): string {
  void sessionId;
  return (
    '<b>➕ Track Anime Baru</b>\n\n' +
    '<b>Step 1/5</b> · Pilih situs sumber:\n\n' +
    '<i>Bot akan cek situs ini setiap hari untuk episode baru.</i>'
  );
}

export function buildSlugPrompt(): string {
  return (
    '<b>Step 2/5</b> · Kirim <b>slug anime</b> yang ada di qimochi.\n\n' +
    '<i>Contoh: <code>tensei-goblin-dakedo-shitsumon-aru</code></i>\n\n' +
    '<i>Pastikan markdown anime sudah di-push via /anime → Post ke qimochi.</i>'
  );
}

export function buildSourceSlugPrompt(
  qimochiSlug: string,
  site: string
): string {
  return (
    `<b>Step 3/5</b> · Slug di <b>${escapeHtml(site)}</b> beda dengan qimochi?\n\n` +
    `🆔 Qimochi: <code>${escapeHtml(qimochiSlug)}</code>\n\n` +
    `<b>Kalau sama:</b> kirim <code>-</code> (tanda hubung)\n` +
    `<b>Kalau beda:</b> kirim slug di situs, contoh <code>tensei-goblin-shitsumon-sub-indo</code>`
  );
}

export function buildDayPrompt(): string {
  return (
    '<b>Step 4/5</b> · Pilih <b>hari rilis</b> di situs:\n\n' +
    '<i>Pilih "Random" kalau situs tidak tentukan jadwal tetap.</i>'
  );
}

export function buildHourPrompt(day: string): string {
  return (
    `<b>Step 5/5</b> · Hari: <b>${escapeHtml(day)}</b>\n\n` +
    'Kirim <b>jam rilis</b> (WIB) format 24 jam.\n\n' +
    '<b>Format:</b>\n' +
    '• <code>18</code> → jam 18:00 WIB\n' +
    '• <code>18:30</code> → jam 18:30 WIB\n' +
    '• <code>18.15</code> → jam 18:15 WIB\n\n' +
    '<i>Bot akan cek mulai jam tersebut + buffer 60 menit.</i>'
  );
}

export function buildSummary(
  session: TrackSessionRow,
  existsInRepo: boolean
): string {
  const hh = String(session.schedule_hour ?? 0).padStart(2, '0');
  const mm = String(session.schedule_minute ?? 0).padStart(2, '0');

  const lines: string[] = [];
  lines.push('<b>📋 Konfirmasi Track</b>');
  lines.push('');
  lines.push(`🎬 <b>Situs:</b> ${escapeHtml(session.site ?? '-')}`);
  lines.push(
    `🆔 <b>Slug Qimochi:</b> <code>${escapeHtml(session.slug ?? '-')}</code>`
  );
  if (session.source_slug && session.source_slug !== session.slug) {
    lines.push(
      `🔗 <b>Slug Sumber:</b> <code>${escapeHtml(session.source_slug)}</code>`
    );
  }
  lines.push(
    `📅 <b>Jadwal:</b> ${escapeHtml(session.schedule_day ?? '-')} ${hh}:${mm} WIB`
  );
  lines.push(`⏱️ <b>Buffer:</b> ${session.buffer_min} menit`);
  lines.push('');
  if (existsInRepo) {
    lines.push('✅ Markdown qimochi ditemukan.');
  } else {
    lines.push(
      '⚠️ <b>Markdown belum ada di qimochi!</b>\n' +
        '<i>Push dulu via /anime → Post ke qimochi.</i>'
    );
  }
  lines.push('');
  lines.push('<i>Klik ✅ Simpan kalau cocok.</i>');
  return lines.join('\n');
}
