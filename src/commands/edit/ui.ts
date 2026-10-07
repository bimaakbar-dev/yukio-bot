// src/commands/edit/ui.ts
import { InlineKeyboard } from 'grammy';
import { escapeHtml } from '../../lib/utils';
import { fieldsFor, targetLabel } from './schema';
import type { FieldDef, PendingEditRow } from './types';

export function buildTargetKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📄 qimochi', 'ed:t:qimochi')
    .text('📄 yukionime', 'ed:t:yukionime')
    .row()
    .text('❌ Batal', 'ed:x:noop');
}

export function buildFieldMenuKeyboard(
  session: PendingEditRow,
  edits: Record<string, string>
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const fields = fieldsFor(session.target);

  for (const f of fields) {
    const mark = edits[f.key] !== undefined ? '✅' : '⬜';
    kb.text(`${mark} ${f.label}`, `ed:f:${session.session_id}:${f.key}`).row();
  }

  kb.text('📤 Post edit', `ed:post:${session.session_id}`)
    .text('🔄 Sync edit', `ed:sync:${session.session_id}`)
    .row()
    .text('❌ Batal', `ed:x:${session.session_id}`);

  return kb;
}

export function buildFieldMenuText(
  session: PendingEditRow,
  edits: Record<string, string>
): string {
  const lines: string[] = [];
  const keys = Object.keys(edits);

  lines.push(`✏️ <b>Edit — ${targetLabel(session.target)}</b>`);
  lines.push('');
  lines.push(`🆔 <code>${escapeHtml(session.slug)}</code>`);
  lines.push(`📁 <code>src/content/anime/${escapeHtml(session.slug)}.md</code>`);
  lines.push('');

  if (keys.length === 0) {
    lines.push('<i>Belum ada perubahan. Klik field untuk mulai edit.</i>');
  } else {
    lines.push(`<b>📝 Perubahan pending (${keys.length}):</b>`);
    const fields = fieldsFor(session.target);
    for (const k of keys) {
      const f = fields.find((x) => x.key === k);
      const label = f?.label ?? k;
      const v = edits[k] ?? '';
      const preview =
        k === 'body'
          ? `${v.slice(0, 60).replace(/\n/g, ' ')}${v.length > 60 ? '…' : ''}`
          : v.slice(0, 60);
      lines.push(`• ${label} → <code>${escapeHtml(preview)}</code>`);
    }
    lines.push('');
    lines.push(
      '<b>📤 Post edit</b> — push ke ' +
        targetLabel(session.target) +
        ' saja'
    );
    lines.push(
      '<b>🔄 Sync edit</b> — push ke ' +
        targetLabel(session.target) +
        ' + ' +
        targetLabel(
          session.target === 'qimochi' ? 'yukionime' : 'qimochi'
        )
    );
  }

  return lines.join('\n');
}

export function buildValuePromptKeyboard(
  session: PendingEditRow,
  field: FieldDef
): InlineKeyboard | undefined {
  if (field.type !== 'choice' || !field.choices) return undefined;

  const kb = new InlineKeyboard();
  field.choices.forEach((c, i) => {
    kb.text(c, `ed:v:${session.session_id}:${i}`);
    if ((i + 1) % 3 === 0) kb.row();
  });
  if (field.choices.length % 3 !== 0) kb.row();
  kb.text('↩️ Balik', `ed:b:${session.session_id}`);
  return kb;
}

export function buildValuePromptText(
  session: PendingEditRow,
  field: FieldDef,
  currentValue: string | null
): string {
  const lines: string[] = [];
  lines.push(`✏️ <b>Edit: ${escapeHtml(field.label)}</b>`);
  lines.push('');
  lines.push(`🆔 <code>${escapeHtml(session.slug)}</code>`);

  if (currentValue !== null && currentValue !== '') {
    const cur =
      currentValue.length > 200
        ? currentValue.slice(0, 200) + '…'
        : currentValue;
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
    lines.push(
      '<i>Kirim isi body baru (sinopsis, multi-baris):</i>'
    );
  } else if (field.hint) {
    lines.push(`<i>Kirim value baru. Format: ${escapeHtml(field.hint)}</i>`);
  } else {
    lines.push('<i>Kirim value baru:</i>');
  }

  return lines.join('\n');
}

export function buildConfirmKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('📤 Post edit', `ed:post:${sessionId}`)
    .text('🔄 Sync edit', `ed:sync:${sessionId}`)
    .row()
    .text('❌ Batal', `ed:x:${sessionId}`);
}