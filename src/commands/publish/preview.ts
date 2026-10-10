// src/commands/publish/preview.ts
import { InlineKeyboard } from 'grammy';
import { escapeHtml } from '../../lib/utils';
import {
  SECTION_LABEL,
  type PublishSummary,
  type SectionKey,
} from './types';

export function buildPreviewLines(
  title: string,
  slug: string,
  summary: PublishSummary,
  selected: Set<SectionKey>
): string {
  const lines: string[] = [];
  lines.push(`📋 <b>Preview Publish</b>`);
  lines.push('');
  lines.push(`🎬 <code>${escapeHtml(title)}</code>`);
  lines.push(`🆔 <code>${slug}</code>`);
  lines.push('');
  lines.push('<i>Target: yukio-data</i>');
  lines.push('');

  const hasMeta = summary.yukionime.metadata;
  const d = summary.yukioData;
  const hasChars = d.characters.count > 0;
  const hasEps = d.episodes.count > 0;
  const hasFr = d.franchises.count > 0;
  const hasVa = d.actors.count > 0;

  const totalReady =
    (hasMeta ? 1 : 0) +
    (hasChars ? 1 : 0) +
    (hasEps ? 1 : 0) +
    (hasFr ? 1 : 0) +
    (hasVa ? 1 : 0);

  if (totalReady === 0) {
    lines.push('<i>Tidak ada data siap di-publish.</i>');
    return lines.join('\n');
  }

  const check = (k: SectionKey) => (selected.has(k) ? '✅' : '⬜');

  if (hasMeta) {
    lines.push(`${check('meta')} ${SECTION_LABEL.meta} → <b>yukio-data</b>`);
  }
  if (hasChars) {
    lines.push(
      `${check('chars')} ${SECTION_LABEL.chars} (${d.characters.count}) → <b>yukio-data</b> (${d.characters.files} file)`
    );
  }
  if (hasEps) {
    lines.push(
      `${check('eps')} ${SECTION_LABEL.eps} (${d.episodes.count}) → <b>yukio-data</b> (${d.episodes.files} file)`
    );
  }
  if (hasFr) {
    lines.push(
      `${check('fr')} ${SECTION_LABEL.fr} (${d.franchises.count}) → <b>yukio-data</b>`
    );
  }
  if (hasVa) {
    lines.push(
      `${check('va')} ${SECTION_LABEL.va} (${d.actors.count}) → <b>yukio-data</b> (${d.actors.files} file)`
    );
  }

  lines.push('');
  lines.push(
    `<i>Tap section untuk toggle. Tap 📤 Push untuk commit yang dipilih.</i>`
  );

  return lines.join('\n');
}

export function buildPreviewKeyboard(
  pendingId: string,
  summary: PublishSummary,
  selected: Set<SectionKey>
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const d = summary.yukioData;

  const hasMeta = summary.yukionime.metadata;
  const hasChars = d.characters.count > 0;
  const hasEps = d.episodes.count > 0;
  const hasFr = d.franchises.count > 0;
  const hasVa = d.actors.count > 0;

  const mark = (k: SectionKey) => (selected.has(k) ? '✅' : '⬜');

  if (hasMeta) {
    kb.text(`${mark('meta')} Metadata`, `pp:t:${pendingId}:meta`).row();
  }
  if (hasChars) {
    kb.text(
      `${mark('chars')} Characters (${d.characters.count})`,
      `pp:t:${pendingId}:chars`
    ).row();
  }
  if (hasEps) {
    kb.text(
      `${mark('eps')} Episodes (${d.episodes.count})`,
      `pp:t:${pendingId}:eps`
    ).row();
  }
  if (hasFr) {
    kb.text(`${mark('fr')} Franchises`, `pp:t:${pendingId}:fr`).row();
  }
  if (hasVa) {
    kb.text(
      `${mark('va')} Actors (${d.actors.count})`,
      `pp:t:${pendingId}:va`
    ).row();
  }

  kb.text('📤 Push', `pp:push:${pendingId}`)
    .text('❌ Batal', `pp:cancel:${pendingId}`);

  return kb;
}
