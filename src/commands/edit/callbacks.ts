// src/commands/edit/callbacks.ts
import { type Bot } from 'grammy';
import type { Env } from '../../types/env';
import type { AniListMedia } from '../../types/anime';
import {
  githubCommitFile,
  githubCommitMultipleFiles,
  type FileToCommit,
} from '../../lib/github';
import { escapeHtml, slugify } from '../../lib/utils';
import { getLatestSessionByUser } from '../../lib/dba-session';
import {
  applyEdits,
  getFrontmatterField,
  splitContent,
} from './content';
import {
  createEditSession,
  deleteEditSession,
  getEditSession,
  parseEdits,
  updateEditSession,
} from './state';
import {
  translateEdit,
  oppositeTarget,
  targetLabel,
  filePathFor,
} from './schema';
import {
  handleSlugInput,
  applyValueAndReturn,
  showValuePrompt,
  showFieldMenu,
  resolveField,
} from './flow';
import { buildTargetKeyboard, buildConfirmKeyboard } from './ui';
import type { EditTarget, PendingEditRow } from './types';

async function pushEditedContent(
  env: Env,
  target: EditTarget,
  slug: string,
  newContent: string
): Promise<{ ok: boolean; sha?: string; commitUrl?: string; error?: string }> {
  const path = filePathFor(slug);
  return githubCommitFile(
    env,
    path,
    newContent,
    `chore(edit): update ${slug}`,
    target
  );
}

async function buildSyncedContent(
  session: PendingEditRow,
  edits: Record<string, string>
): Promise<{ content: string; count: number } | null> {
  const to = oppositeTarget(session.target);
  const path = filePathFor(session.slug);

  let oppositeFile: Awaited<ReturnType<typeof import('../../lib/github').githubGetFile>> = null;
  try {
    const { githubGetFile } = await import('../../lib/github');
    oppositeFile = await githubGetFile(env_get(), path, to);
  } catch {
    return null;
  }

  return null;
}

// helper supaya TS senang — nggak dipakai di production path
function env_get(): never {
  throw new Error('unused');
}

export function setupEditCallbacks(bot: Bot, env: Env): void {
  /* ── Pilih target ─────────────────────────────── */
  bot.callbackQuery(/^ed:t:(qimochi|yukionime)$/, async (ctx) => {
    const target = (ctx.match[1] ?? '') as EditTarget;
    if (!target) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) return;

    const sessionId = await createEditSession(env.DB, userId, target);

    await ctx.answerCallbackQuery({ text: targetLabel(target) });

    await ctx
      .editMessageText(
        `✏️ <b>Edit ${targetLabel(target)}</b>\n\n` +
          `Kirim <b>slug</b> anime yang mau diedit.\n\n` +
          `<i>Contoh: <code>jujutsu-kaisen</code></i>\n\n` +
          `🆔 <code>${sessionId}</code>`,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: undefined,
        }
      )
      .catch(() => {});
  });

  /* ── Pilih field ──────────────────────────────── */
  bot.callbackQuery(/^ed:f:(ed_[a-z0-9]+):([a-zA-Z._]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const fieldKey = ctx.match[2] ?? '';

    const session = await getEditSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Kadaluarsa. Ulangi /edit.',
        show_alert: true,
      });
      return;
    }
    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }
    if (!session.slug) {
      await ctx.answerCallbackQuery({
        text: '❌ Slug belum di-set.',
        show_alert: true,
      });
      return;
    }

    const field = resolveField(session.target, fieldKey);
    if (!field) {
      await ctx.answerCallbackQuery({ text: '❌ Field tidak dikenal' });
      return;
    }

    await ctx.answerCallbackQuery({ text: field.label });
    await showValuePrompt(ctx, env, session, field);
  });

  /* ── Pilih value preset (choice) ──────────────── */
  bot.callbackQuery(/^ed:v:(ed_[a-z0-9]+):(\d+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const idx = parseInt(ctx.match[2] ?? '-1', 10);

    const session = await getEditSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Kadaluarsa. Ulangi /edit.',
        show_alert: true,
      });
      return;
    }
    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }
    if (!session.active_field) {
      await ctx.answerCallbackQuery({ text: '❌ Tidak ada field aktif' });
      return;
    }

    const field = resolveField(session.target, session.active_field);
    if (!field || !field.choices || idx < 0 || idx >= field.choices.length) {
      await ctx.answerCallbackQuery({ text: '❌ Value tidak valid' });
      return;
    }

    const value = field.choices[idx]!;
    await ctx.answerCallbackQuery({ text: `✅ ${value}` });

    await applyValueAndReturn(ctx, env, session, field, value);
  });

  /* ── Balik ke menu ────────────────────────────── */
  bot.callbackQuery(/^ed:b:(ed_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const session = await getEditSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Kadaluarsa',
        show_alert: true,
      });
      return;
    }
    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '↩️' });
    await showFieldMenu(ctx, env, session);
  });

  /* ── Post edit (1 repo) ───────────────────────── */
  bot.callbackQuery(/^ed:post:(ed_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const session = await getEditSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Kadaluarsa',
        show_alert: true,
      });
      return;
    }
    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔' });
      return;
    }

    const edits = parseEdits(session);
    if (Object.keys(edits).length === 0) {
      await ctx.answerCallbackQuery({
        text: '❌ Belum ada perubahan',
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

    const newContent = applyEdits(session.base_content, edits);

    const loading = await ctx.reply(
      `📤 <b>Push ke ${targetLabel(session.target)}...</b>\n\n📁 <code>${escapeHtml(filePathFor(session.slug))}</code>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );

    const result = await pushEditedContent(
      env,
      session.target,
      session.slug,
      newContent
    );

    if (!result.ok) {
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ <b>Gagal push</b>\n\n<code>${escapeHtml((result.error ?? 'unknown').slice(0, 300))}</code>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
      return;
    }

    await deleteEditSession(env.DB, sessionId);

    const short = result.sha?.slice(0, 7) ?? '?';
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `✅ <b>Posted!</b>\n\n` +
          `🆔 <code>${escapeHtml(session.slug)}</code>\n` +
          `📦 ${Object.keys(edits).length} field diubah\n` +
          `🔗 Commit: <code>${short}</code>\n` +
          `⏳ Deploy ~2 menit`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      )
      .catch(() => {});
  });

  /* ── Sync edit (2 repo) ───────────────────────── */
  bot.callbackQuery(/^ed:sync:(ed_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const session = await getEditSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Kadaluarsa',
        show_alert: true,
      });
      return;
    }
    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔' });
      return;
    }

    const edits = parseEdits(session);
    if (Object.keys(edits).length === 0) {
      await ctx.answerCallbackQuery({
        text: '❌ Belum ada perubahan',
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: '🔄 Syncing...' });

    const loading = await ctx.reply('🔄 <b>Sync ke 2 repo...</b>', {
      parse_mode: 'HTML',
    });

    const to = oppositeTarget(session.target);
    const path = filePathFor(session.slug);

    // 1. Push target (source)
    const sourceContent = applyEdits(session.base_content, edits);
    const sourceResult = await pushEditedContent(
      env,
      session.target,
      session.slug,
      sourceContent
    );

    if (!sourceResult.ok) {
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ <b>Gagal push ke ${targetLabel(session.target)}</b>\n\n<code>${escapeHtml((sourceResult.error ?? 'unknown').slice(0, 200))}</code>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
      return;
    }

    // 2. Fetch file target lain
    const { githubGetFile } = await import('../../lib/github');
    let oppositeFile: Awaited<ReturnType<typeof githubGetFile>> = null;
    try {
      oppositeFile = await githubGetFile(env, path, to);
    } catch (err) {
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `⚠️ <b>Partial:</b> push ${targetLabel(session.target)} ✅, tapi fetch ${targetLabel(to)} gagal.\n\n` +
            `<code>${escapeHtml((String(err).slice(0, 200)))}</code>\n\n` +
            `<i>File ${targetLabel(to)} tidak diubah.</i>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
      return;
    }

    if (!oppositeFile) {
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `⚠️ <b>Partial:</b> push ${targetLabel(session.target)} ✅\n\n` +
            `Tapi file <code>${escapeHtml(path)}</code> tidak ada di ${targetLabel(to)} — skip sync.`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
      await deleteEditSession(env.DB, sessionId);
      return;
    }

    // 3. Translate edits & apply ke opposite
    const translated: Record<string, string> = {};
    const translatedInfo: string[] = [];

    for (const [fieldFrom, valueFrom] of Object.entries(edits)) {
      const t = translateEdit(session.target, fieldFrom, valueFrom);
      if (!t) continue;
      translated[t.fieldTo] = t.valueTo;
      translatedInfo.push(`${fieldFrom} → ${t.fieldTo}`);
    }

    if (Object.keys(translated).length === 0) {
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `✅ <b>Posted ke ${targetLabel(session.target)}</b>\n\n` +
            `⚠️ Tidak ada field yang bisa di-sync ke ${targetLabel(to)} (mapping nggak ada).`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
      await deleteEditSession(env.DB, sessionId);
      return;
    }

    const oppositeContent = applyEdits(
      oppositeFile.content,
      translated
    );

    const oppositeResult = await pushEditedContent(
      env,
      to,
      session.slug,
      oppositeContent
    );

    await deleteEditSession(env.DB, sessionId);

    const shortS = sourceResult.sha?.slice(0, 7) ?? '?';
    const shortO = oppositeResult.sha?.slice(0, 7) ?? '?';

    const lines: string[] = [];
    lines.push(`✅ <b>Synced!</b>`);
    lines.push('');
    lines.push(`🆔 <code>${escapeHtml(session.slug)}</code>`);
    lines.push('');
    lines.push(
      `✅ ${targetLabel(session.target)} — <code>${shortS}</code> (${Object.keys(edits).length} field)`
    );

    if (oppositeResult.ok) {
      lines.push(
        `✅ ${targetLabel(to)} — <code>${shortO}</code> (${Object.keys(translated).length} field)`
      );
    } else {
      lines.push(
        `❌ ${targetLabel(to)} — <i>${escapeHtml((oppositeResult.error ?? 'unknown').slice(0, 100))}</i>`
      );
    }

    lines.push('');
    lines.push('<b>Mapping:</b>');
    for (const m of translatedInfo) lines.push(`• <code>${escapeHtml(m)}</code>`);
    lines.push('');
    lines.push(`⏳ Deploy ~2 menit`);

    await ctx.api
      .editMessageText(ctx.chat!.id, loading.message_id, lines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      })
      .catch(() => {});
  });

  /* ── Batal ────────────────────────────────────── */
  bot.callbackQuery(/^ed:x:(ed_[a-z0-9]+|noop)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (sessionId && sessionId !== 'noop') {
      await deleteEditSession(env.DB, sessionId);
    }
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageText('❌ <b>Edit dibatalkan.</b>', {
        parse_mode: 'HTML',
        reply_markup: undefined,
      })
      .catch(() => {});
  });
}