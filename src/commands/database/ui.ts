import { InlineKeyboard } from 'grammy';
import { escapeHtml } from '../../lib/utils';

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'choice' | 'csv' | 'url' | 'body';
  choices?: string[];
  hint?: string;
}

export const EDIT_FIELDS: FieldDef[] = [
  { key: 'title', label: '📄 Title', type: 'text' },
  { key: 'titleEnglish', label: '📄 Title EN', type: 'text' },
  { key: 'titleNative', label: '📄 Title JP', type: 'text' },
  {
    key: 'type',
    label: '🎬 Type',
    type: 'choice',
    choices: ['TV', 'Movie', 'OVA', 'ONA', 'Special', 'Music', 'Unknown'],
  },
  {
    key: 'status',
    label: '📊 Status',
    type: 'choice',
    choices: ['airing', 'finished', 'upcoming', 'hiatus', 'cancelled'],
  },
  { key: 'source', label: '📖 Source', type: 'text' },
  {
    key: 'season',
    label: '🌤️ Season',
    type: 'choice',
    choices: ['winter', 'spring', 'summer', 'fall'],
  },
  { key: 'year', label: '📅 Year', type: 'number', hint: '1900-2100' },
  { key: 'episodes', label: '📼 Episodes', type: 'number' },
  { key: 'duration', label: '⏱️ Duration', type: 'number', hint: 'menit' },
  {
    key: 'rating',
    label: '🔞 Age Rating',
    type: 'choice',
    choices: ['G', 'PG', 'PG-13', 'R', 'R+', 'Rx'],
  },
  { key: 'stats.score', label: '⭐ Score', type: 'number', hint: '0.0 - 10.0' },
  { key: 'malId', label: '🆔 MAL ID', type: 'number' },
  { key: 'anilistId', label: '🆔 AniList ID', type: 'number' },
  { key: 'genres', label: '🏷️ Genres', type: 'csv', hint: 'action, comedy' },
  { key: 'studios', label: '🏢 Studios', type: 'csv', hint: 'mappa, bones' },
  { key: 'image', label: '🖼️ Image', type: 'url' },
  { key: 'banner', label: '🖼️ Banner', type: 'url' },
  { key: 'trailer', label: '🎬 Trailer', type: 'text' },
  { key: 'body', label: '📝 Sinopsis', type: 'body' },
];

export function findField(key: string): FieldDef | null {
  return EDIT_FIELDS.find((f) => f.key === key) ?? null;
}

export function buildMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔍 Cari Slug', 'db:search')
    .text('📊 Stats', 'db:stats')
    .row()
    .text('🔄 Sync', 'db:sync');
}

export function buildDetailKeyboard(
  slug: string,
  hasChars: boolean,
  hasEps: boolean,
  hasStreams: boolean,
  hasFr: boolean
): InlineKeyboard {
  void hasChars;
  void hasEps;
  void hasFr;

  const kb = new InlineKeyboard()
    .text('✏️ Edit', `db:edit:${slug}`)
    .text('🗑️ Hapus', `db:del:${slug}`)
    .row();

  if (hasStreams) {
    kb.text('🎬 Episodes', `db:ep:${slug}`).row();
  }

  kb.text('🔍 Cari Lagi', 'db:search').text('◀️ Menu', 'db:home');

  return kb;
}

export function buildEditMenuKeyboard(
  slug: string,
  edits: Record<string, string>
): InlineKeyboard {
  const kb = new InlineKeyboard();
  let i = 0;
  for (const f of EDIT_FIELDS) {
    const mark = edits[f.key] !== undefined ? '✅' : '⬜';
    kb.text(`${mark} ${f.label}`, `db:ef:${f.key}`);
    i++;
    if (i % 2 === 0) kb.row();
  }
  if (i % 2 !== 0) kb.row();

  kb.text(`💾 Save (${Object.keys(edits).length})`, 'db:save');
  kb.text('❌ Batal', `db:view:${slug}`);
  kb.row();
  kb.text('◀️ Detail', `db:view:${slug}`);

  return kb;
}

export function buildValueKeyboard(
  fieldKey: string,
  choices: string[]
): InlineKeyboard {
  const kb = new InlineKeyboard();
  choices.forEach((c, i) => {
    kb.text(c, `db:ev:${i}`);
    if ((i + 1) % 3 === 0) kb.row();
  });
  if (choices.length % 3 !== 0) kb.row();
  kb.text('↩️ Balik', 'db:edit:back');
  void fieldKey;
  return kb;
}

export function buildFieldMenuText(
  slug: string,
  edits: Record<string, string>
): string {
  const count = Object.keys(edits).length;
  const lines: string[] = [];
  lines.push(`✏️ <b>Edit — ${escapeHtml(slug)}</b>`);
  lines.push('');

  if (count === 0) {
    lines.push('<i>Belum ada perubahan.</i>');
  } else {
    lines.push(`<b>📝 Perubahan pending (${count}):</b>`);
    for (const [k, v] of Object.entries(edits)) {
      const f = findField(k);
      const label = f?.label ?? k;
      const preview =
        k === 'body'
          ? `${v.slice(0, 40).replace(/\n/g, ' ')}…`
          : v.length > 40
            ? v.slice(0, 38) + '…'
            : v;
      lines.push(`• ${label} → <code>${escapeHtml(preview)}</code>`);
    }
  }

  lines.push('');
  lines.push('<i>Tap field untuk ubah:</i>');
  return lines.join('\n');
}

export function buildValuePromptText(
  slug: string,
  field: FieldDef,
  current: string | null
): string {
  const lines: string[] = [];
  lines.push(`✏️ <b>Edit: ${escapeHtml(field.label)}</b>`);
  lines.push('');
  lines.push(`🆔 <code>${escapeHtml(slug)}</code>`);

  if (current !== null && current !== '') {
    const cur = current.length > 200 ? current.slice(0, 200) + '…' : current;
    lines.push(`📌 Sekarang: <code>${escapeHtml(cur)}</code>`);
  } else {
    lines.push(`📌 Sekarang: <i>(kosong)</i>`);
  }
  lines.push('');

  if (field.type === 'choice' && field.choices) {
    lines.push('<i>Pilih dari tombol di bawah:</i>');
  } else if (field.type === 'url') {
    lines.push('<i>Kirim URL baru (https://...):</i>');
  } else if (field.type === 'body') {
    lines.push('<i>Kirim isi body baru (sinopsis, multi-baris):</i>');
  } else if (field.hint) {
    lines.push(`<i>Kirim value baru. Format: ${escapeHtml(field.hint)}</i>`);
  } else {
    lines.push('<i>Kirim value baru:</i>');
  }

  return lines.join('\n');
}