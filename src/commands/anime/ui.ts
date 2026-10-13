import { InlineKeyboard } from 'grammy';
import { escapeHtml } from '../../lib/utils';
import type { SessionRow } from '../../lib/dba-session';

export function buildKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('📋 Metadata', `an:m:${sessionId}`)
    .text('👥 Characters', `an:c:${sessionId}`)
    .row()
    .text('🎬 Episodes', `an:e:${sessionId}`)
    .text('🔗 Franchises', `an:f:${sessionId}`)
    .row()
    .text('🎤 Voice Actors', `an:v:${sessionId}`)
    .text('📝 Summary', `an:s:${sessionId}`)
    .row()
    .text('📤 Publish ke yukio-data', `an:pub:${sessionId}`)
    .row()
    .text('❌ Batal', `an:x:${sessionId}`);
}

export function buildPreviewText(session: SessionRow): string {
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

export function buildPublishKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Push ke yukio-data', `an:push:${sessionId}`)
    .text('❌ Batal', `an:x:${sessionId}`);
}