// src/commands/edit/flow.ts
import type { Context } from 'grammy';
import type { Env } from '../../types/env';
import { githubGetFile } from '../../lib/github';
import { escapeHtml } from '../../lib/utils';
import { findField, fieldsFor, filePathFor, targetLabel } from './schema';
import {
  getEditSession,
  parseEdits,
  updateEditSession,
} from './state';
import {
  buildFieldMenuKeyboard,
  buildFieldMenuText,
  buildValuePromptKeyboard,
  buildValuePromptText,
} from './ui';
import { getFrontmatterField, splitContent } from './content';
import type { FieldDef, PendingEditRow } from './types';

export async function showFieldMenu(
  ctx: Context,
  env: Env,
  session: PendingEditRow,
  editMessageId?: number
): Promise<void> {
  const edits = parseEdits(session);
  const text = buildFieldMenuText(session, edits);
  const kb = buildFieldMenuKeyboard(session, edits);

  await updateEditSession(env.DB, session.session_id, {
    state: 'menu',
    active_field: null,
  });

  if (editMessageId) {
    await ctx.api
      .editMessageText(ctx.chat!.id, editMessageId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      })
      .catch(() => {});
    return;
  }

  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

export async function showValuePrompt(
  ctx: Context,
  env: Env,
  session: PendingEditRow,
  field: FieldDef
): Promise<void> {
  const { frontmatter } = splitContent(session.base_content);
  const current = getFrontmatterField(frontmatter, field.key);
  const text = buildValuePromptText(session, field, current);
  const kb = buildValuePromptKeyboard(session, field);

  await updateEditSession(env.DB, session.session_id, {
    state: 'awaiting_value',
    active_field: field.key,
  });

  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

/** Handle text input user saat state=awaiting_slug */
export async function handleSlugInput(
  ctx: Context,
  env: Env,
  session: PendingEditRow,
  slug: string
): Promise<void> {
  const path = filePathFor(slug);

  const loading = await ctx.reply(
    `🔍 Cari <code>${escapeHtml(path)}</code> di ${targetLabel(session.target)}...`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );

  let file: Awaited<ReturnType<typeof githubGetFile>> = null;
  try {
    file = await githubGetFile(env, path, session.target);
  } catch (err: any) {
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Error fetch: <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 200))}</code>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
    return;
  }

  if (!file) {
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ <b>File tidak ditemukan.</b>\n\n` +
          `Path: <code>${escapeHtml(path)}</code>\n` +
          `Repo: ${targetLabel(session.target)}\n\n` +
          `<i>Cek slug atau pastikan file sudah ada di repo.</i>`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      )
      .catch(() => {});
    return;
  }

  await updateEditSession(env.DB, session.session_id, {
    slug,
    base_content: file.content,
    state: 'menu',
    active_field: null,
  });

  await ctx.api
    .deleteMessage(ctx.chat!.id, loading.message_id)
    .catch(() => {});

  const updated = await getEditSession(env.DB, session.session_id);
  if (!updated) {
    await ctx.reply('⏱️ Session kadaluarsa. Ulangi /edit.');
    return;
  }

  await showFieldMenu(ctx, env, updated);
}

/** Handle value input (dari text atau preset) */
export async function applyValueAndReturn(
  ctx: Context,
  env: Env,
  session: PendingEditRow,
  field: FieldDef,
  value: string
): Promise<void> {
  const edits = parseEdits(session);
  edits[field.key] = value;

  await updateEditSession(env.DB, session.session_id, {
    edits_json: JSON.stringify(edits),
    state: 'menu',
    active_field: null,
  });

  const updated = await getEditSession(env.DB, session.session_id);
  if (!updated) return;

  await showFieldMenu(ctx, env, updated);
}

export function listFieldKeys(target: PendingEditRow['target']): string[] {
  return fieldsFor(target).map((f) => f.key);
}

export function resolveField(
  target: PendingEditRow['target'],
  key: string
): FieldDef | null {
  return findField(target, key);
}