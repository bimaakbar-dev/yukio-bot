// src/commands/track/ui.ts
import { InlineKeyboard } from 'grammy';
import { escapeHtml } from '../../lib/utils';
import type { TrackSessionRow } from './state';
import type { SiteKey, TrackedAnimeRow } from '../../lib/cron/state';

export const SITE_LABEL: Record<SiteKey, string> = {
  lexanime: '🎬 lexanime',
  animesub: '🎬 animesub',
  samehadaku: '🎬 samehadaku',
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

/* ============================================================
   MAIN MENU
   ============================================================ */

export function buildMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('➕ Tambah Baru', 'tr:a')
    .text('📋 Lihat Daftar', 'tr:l')
    .row()
    .text('🗑️ Hapus Anime', 'tr:dm')
    .text('🔄 Cek Episode Baru', 'tr:c');
}

export function buildMainMenuText(
  total: number,
  active: number,
  paused: number,
  pending: number
): string {
  const lines: string[] = [];
  lines.push('📡 <b>Track Anime</b>');
  lines.push('');
  lines.push(`📊 Total: <b>${total}</b> anime`);
  if (active > 0) lines.push(`🟢 Active: ${active}`);
  if (paused > 0) lines.push(`⏸️ Paused: ${paused}`);
  if (pending > 0) {
    lines.push('');
    lines.push(`⚠️ <b>${pending} anime tertinggal!</b>`);
  }
  lines.push('');
  lines.push('<i>Pilih action di bawah:</i>');
  return lines.join('\n');
}

/* ============================================================
   ADD FLOW (existing)
   ============================================================ */

export function buildSiteKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('🎬 lexanime', `tr:site:${sessionId}:lexanime`)
    .text('🎬 animesub', `tr:site:${sessionId}:animesub`)
    .row()
    .text('🎬 samehadaku', `tr:site:${sessionId}:samehadaku`)
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
  if (site === 'samehadaku') {
    return (
      `<b>Step 3/5</b> · Slug di <b>${escapeHtml(site)}</b>\n\n` +
      `🆔 Qimochi: <code>${escapeHtml(qimochiSlug)}</code>\n\n` +
      `<b>Opsi input:</b>\n` +
      `• Kirim <b>URL anime</b> Samehadaku, contoh:\n` +
      `<code>https://samehadaku.li/anime/tensei-goblin-dakedo-shitsumon-aru/</code>\n` +
      `• Atau kirim <b>slug</b> langsung\n` +
      `• Atau kirim <code>-</code> kalau sama dengan qimochi`
    );
  }

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

/* ============================================================
   DELETE MENU
   ============================================================ */

export function buildDeleteMenuKeyboard(counts: {
  lexanime: number;
  animesub: number;
  samehadaku: number;
}): InlineKeyboard {
  const kb = new InlineKeyboard();

  const buttons: { label: string; site: SiteKey; count: number }[] = [
    { label: '🎬 lexanime', site: 'lexanime', count: counts.lexanime },
    { label: '🎬 animesub', site: 'animesub', count: counts.animesub },
    { label: '🎬 samehadaku', site: 'samehadaku', count: counts.samehadaku },
  ];

  for (const b of buttons) {
    if (b.count > 0) {
      kb.text(`${b.label} (${b.count})`, `tr:ds:${b.site}`).row();
    }
  }

  kb.text('◀️ Kembali', 'tr:h');
  return kb;
}

export function buildDeleteMenuText(counts: {
  lexanime: number;
  animesub: number;
  samehadaku: number;
}): string {
  const total = counts.lexanime + counts.animesub + counts.samehadaku;
  return (
    '🗑️ <b>Hapus Anime</b>\n\n' +
    `Total: <b>${total}</b> anime\n\n` +
    '<i>Pilih situs untuk lihat daftarnya:</i>'
  );
}

export function buildDeleteSiteActionKeyboard(
  site: SiteKey,
  count: number
): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(`🗑️ Hapus Semua (${count})`, `tr:dall:${site}`).row();
  kb.text('☑️ Pilih Satu-satu', `tr:dsel:${site}`).row();
  kb.text('◀️ Kembali', 'tr:dm');
  return kb;
}

export function buildDeleteSiteActionText(
  site: SiteKey,
  list: TrackedAnimeRow[]
): string {
  const lines: string[] = [];
  lines.push(`🗑️ <b>Hapus dari ${escapeHtml(site)}</b>`);
  lines.push('');
  lines.push(`📊 Total: <b>${list.length}</b> anime`);
  lines.push('');
  lines.push('<b>Daftar:</b>');
  const preview = list.slice(0, 8);
  for (const r of preview) {
    lines.push(`• <code>${escapeHtml(r.slug)}</code>`);
  }
  if (list.length > preview.length) {
    lines.push(`<i>… dan ${list.length - preview.length} lainnya</i>`);
  }
  lines.push('');
  lines.push('<i>Pilih action:</i>');
  return lines.join('\n');
}

export function buildDeleteAllConfirmKeyboard(site: SiteKey): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Ya, Hapus Semua', `tr:dally:${site}`)
    .text('❌ Batal', `tr:ds:${site}`);
}

export function buildDeleteAllConfirmText(
  site: SiteKey,
  list: TrackedAnimeRow[]
): string {
  const lines: string[] = [];
  lines.push('⚠️ <b>Konfirmasi Hapus Semua</b>');
  lines.push('');
  lines.push(
    `Yakin hapus <b>${list.length}</b> anime dari <b>${escapeHtml(site)}</b>?`
  );
  lines.push('');
  const preview = list.slice(0, 10);
  for (const r of preview) {
    lines.push(`• <code>${escapeHtml(r.slug)}</code>`);
  }
  if (list.length > preview.length) {
    lines.push(`<i>… dan ${list.length - preview.length} lainnya</i>`);
  }
  lines.push('');
  lines.push('<b>⚠️ Tidak bisa dibatalkan.</b>');
  return lines.join('\n');
}

/* ============================================================
   DELETE SELECT MODE
   ============================================================ */

export function buildDeleteSelectKeyboard(
  site: SiteKey,
  list: TrackedAnimeRow[],
  mask: number
): InlineKeyboard {
  const kb = new InlineKeyboard();

  list.forEach((row, i) => {
    const checked = (mask & (1 << i)) !== 0;
    const mark = checked ? '✅' : '⬜';
    const label = `${mark} ${row.slug}`;
    const shortLabel = label.length > 40 ? label.slice(0, 38) + '…' : label;

    kb.text(shortLabel, `tr:dt:${site}:${mask}:${i}`);
    kb.row();
  });

  const selectedCount = countBits(mask);
  const delLabel =
    selectedCount > 0
      ? `🗑️ Hapus (${selectedCount})`
      : `🗑️ Hapus (0)`;

  kb.text(delLabel, `tr:dgo:${site}:${mask}`)
    .text('❌ Batal', `tr:ds:${site}`);

  return kb;
}

export function buildDeleteSelectText(
  site: SiteKey,
  list: TrackedAnimeRow[],
  mask: number
): string {
  const selected = countBits(mask);
  const lines: string[] = [];
  lines.push(`☑️ <b>Pilih Anime — ${escapeHtml(site)}</b>`);
  lines.push('');
  lines.push(`Total: <b>${list.length}</b> · Dipilih: <b>${selected}</b>`);
  lines.push('');
  lines.push('<i>Tap untuk toggle. Klik 🗑️ Hapus kalau sudah selesai.</i>');
  return lines.join('\n');
}

export function buildDeleteSelectedConfirmKeyboard(
  site: SiteKey,
  mask: number
): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Ya, Hapus', `tr:dgy:${site}:${mask}`)
    .text('❌ Batal', `tr:dsel:${site}`);
}

export function buildDeleteSelectedConfirmText(
  site: SiteKey,
  list: TrackedAnimeRow[],
  mask: number
): string {
  const selected = list.filter((_, i) => (mask & (1 << i)) !== 0);

  const lines: string[] = [];
  lines.push('⚠️ <b>Konfirmasi Hapus</b>');
  lines.push('');
  lines.push(
    `Yakin hapus <b>${selected.length}</b> anime dari <b>${escapeHtml(site)}</b>?`
  );
  lines.push('');
  for (const r of selected.slice(0, 15)) {
    lines.push(`• <code>${escapeHtml(r.slug)}</code>`);
  }
  if (selected.length > 15) {
    lines.push(`<i>… dan ${selected.length - 15} lainnya</i>`);
  }
  return lines.join('\n');
}

/* ============================================================
   HELPERS
   ============================================================ */

export function countBits(n: number): number {
  let count = 0;
  let x = n;
  while (x > 0) {
    count += x & 1;
    x >>>= 1;
  }
  return count;
}