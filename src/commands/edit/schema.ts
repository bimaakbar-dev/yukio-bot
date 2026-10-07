// src/commands/edit/schema.ts
import type { EditTarget, FieldDef } from './types';

export const QIMOCHI_FIELDS: FieldDef[] = [
  { key: 'title', label: '📄 Title', type: 'text' },
  { key: 'cover', label: '🖼️ Cover', type: 'url' },
  {
    key: 'status',
    label: '📊 Status',
    type: 'choice',
    choices: ['Ongoing', 'Completed', 'Hiatus'],
  },
  {
    key: 'type',
    label: '🎬 Type',
    type: 'choice',
    choices: ['TV', 'Movie', 'OVA', 'ONA', 'Special'],
  },
  { key: 'studio', label: '🏢 Studio', type: 'text' },
  {
    key: 'releaseDate',
    label: '📅 Release Date',
    type: 'text',
    hint: 'YYYY-MM-DD',
  },
  {
    key: 'rating',
    label: '⭐ Rating',
    type: 'text',
    hint: '0.0 - 10.0',
  },
  {
    key: 'genre',
    label: '🏷️ Genre',
    type: 'text',
    hint: 'pisah pakai koma, contoh: Action, Adventure',
  },
  { key: 'body', label: '📝 Body (sinopsis)', type: 'body' },
];

export const YUKIONIME_FIELDS: FieldDef[] = [
  { key: 'title', label: '📄 Title', type: 'text' },
  { key: 'titleEnglish', label: '📄 Title (EN)', type: 'text' },
  { key: 'titleNative', label: '📄 Title (JP)', type: 'text' },
  {
    key: 'type',
    label: '🎬 Type',
    type: 'choice',
    choices: ['TV', 'Movie', 'OVA', 'ONA', 'Special'],
  },
  {
    key: 'status',
    label: '📊 Status',
    type: 'choice',
    choices: ['airing', 'finished', 'upcoming', 'cancelled', 'hiatus'],
  },
  { key: 'source', label: '📖 Source', type: 'text' },
  {
    key: 'season',
    label: '🌤️ Season',
    type: 'choice',
    choices: ['winter', 'spring', 'summer', 'fall'],
  },
  { key: 'year', label: '📅 Year', type: 'text' },
  { key: 'episodes', label: '📼 Episodes', type: 'text' },
  { key: 'duration', label: '⏱️ Duration', type: 'text' },
  {
    key: 'rating',
    label: '🔞 Age Rating',
    type: 'choice',
    choices: ['G', 'PG', 'PG-13', 'R', 'R+', 'Rx'],
  },
  { key: 'stats.score', label: '⭐ Score', type: 'text', hint: '0.0 - 10.0' },
  { key: 'image', label: '🖼️ Image', type: 'url' },
  { key: 'body', label: '📝 Body', type: 'body' },
];

export function fieldsFor(target: EditTarget): FieldDef[] {
  return target === 'qimochi' ? QIMOCHI_FIELDS : YUKIONIME_FIELDS;
}

export function findField(
  target: EditTarget,
  key: string
): FieldDef | null {
  return fieldsFor(target).find((f) => f.key === key) ?? null;
}

export function targetLabel(target: EditTarget): string {
  return target === 'qimochi' ? '📄 qimochi' : '📄 yukionime';
}

export function filePathFor(slug: string): string {
  return `src/content/anime/${slug}.md`;
}

/* ============================================================
   STATUS TRANSLATION
   ============================================================ */

export const STATUS_Q2Y: Record<string, string> = {
  Ongoing: 'airing',
  Completed: 'finished',
  Hiatus: 'hiatus',
  Upcoming: 'upcoming',
};

export const STATUS_Y2Q: Record<string, string> = {
  airing: 'Ongoing',
  finished: 'Completed',
  hiatus: 'Hiatus',
  upcoming: 'Upcoming',
};

/* ============================================================
   SYNC MAPPING (field target A → field target B)
   ============================================================ */

export const SYNC_Q2Y: Record<string, string | null> = {
  title: 'title',
  status: 'status',
  type: 'type',
  rating: 'stats.score',
  releaseDate: 'aired.from',
  body: 'body',
};

export const SYNC_Y2Q: Record<string, string | null> = {
  title: 'title',
  status: 'status',
  type: 'type',
  'stats.score': 'rating',
  'aired.from': 'releaseDate',
  body: 'body',
};

export interface TranslatedEdit {
  fieldTo: string;
  valueTo: string;
}

export function translateEdit(
  from: EditTarget,
  fieldFrom: string,
  valueFrom: string
): TranslatedEdit | null {
  const map = from === 'qimochi' ? SYNC_Q2Y : SYNC_Y2Q;
  const fieldTo = map[fieldFrom];
  if (!fieldTo) return null;

  let valueTo = valueFrom;

  // Status translation
  if (fieldFrom === 'status') {
    valueTo =
      from === 'qimochi'
        ? (STATUS_Q2Y[valueFrom] ?? valueFrom)
        : (STATUS_Y2Q[valueFrom] ?? valueFrom);
  }

  return { fieldTo, valueTo };
}

export function oppositeTarget(target: EditTarget): EditTarget {
  return target === 'qimochi' ? 'yukionime' : 'qimochi';
}