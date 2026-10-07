// src/commands/kill.ts
import type { CommandDefinition } from './registry';
import type { Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import { escapeHtml } from '../lib/utils';

interface TableStat {
  name: string;
  label: string;
  count: number;
  exists: boolean;
}

const TABLES: { name: string; label: string }[] = [
  { name: 'temp_anime', label: '📄 Temp anime (/anime)' },
  { name: 'batch_sessions', label: '🎬 Batch sessions (/batch)' },
  { name: 'pending_publish', label: '📤 Pending publish (/publish)' },
  { name: 'pending_post', label: '📮 Pending post (/post)' },
  { name: 'pending_data_v2', label: '📦 Pending data (legacy)' },
  { name: 'pending_dba_metadata', label: '📋 Pending DBA (legacy)' },
  { name: 'pending_franchises', label: '🔗 Pending franchises (legacy)' },
  { name: 'qimochi_sessions', label: '🗄️ Qimochi sessions (/dba)' },
  { name: 'qimochi_char_cache', label: '👥 Char cache' },
  { name: 'qimochi_ep_cache', label: '🎞️ Ep cache' },
  { name: 'qimochi_messages', label: '💬 Message tracking' },
  { name: 'cache', label: '⚡ General cache' },
  { name: 'file_refs', label: '📁 File refs (/decode)' },
];

const KILL_TTL_MS = 5 * 60 * 1000;

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
      )
      .bind(name)
      .first<{ name: string }>();
    return !!row;
  } catch {
    return false;
  }
}

async function countRows(db: D1Database, name: string): Promise<number> {
  try {
    const row = await db
      .prepare(`SELECT COUNT(*) as c FROM ${name}`)
      .first<{ c: number }>();
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

async function collectStats(db: D1Database): Promise<TableStat[]> {
  const stats: TableStat[] = [];

  for (const t of TABLES) {
    const exists = await tableExists(db, t.name);
    if (!exists) {
      stats.push({ ...t, count: 0, exists: false });
      continue;
    }
    const count = await countRows(db, t.name);
    stats.push({ ...t, count, exists: true });
  }

  return stats;
}

async function buildPreview(env: Env): Promise<{
  text: string;
  total: number;
  tablesToKill: string[];
}> {
  const stats = await collectStats(env.DB);

  let total = 0;
  const tablesToKill: string[] = [];
  const lines: string[] = [];

  lines.push('🧨 <b>KILL — Reset Bot</b>');
  lines.push('');
  lines.push('<i>Semua session & cache akan dihapus. <b>voice_actors</b> dipertahankan.</i>');
  lines.push('');

  let hasAny = false;
  for (const s of stats) {
    if (!s.exists) {
      lines.push(`⚪ ${s.label} — <i>tabel tidak ada</i>`);
      continue;
    }
    if (s.count === 0) {
      lines.push(`⚪ ${s.label} — kosong`);
      continue;
    }
    hasAny = true;
    total += s.count;
    tablesToKill.push(s.name);
    lines.push(`🔴 ${s.label} — <b>${s.count}</b> row`);
  }

  lines.push('');
  if (!hasAny) {
    lines.push('✅ <b>Bot sudah bersih.</b> Nggak ada yang perlu dihapus.');
  } else {
    lines.push(`📊 Total: <b>${total}</b> row di <b>${tablesToKill.length}</b> tabel`);
  }

  return { text: lines.join('\n'), total, tablesToKill };
}

async function executeKill(
  env: Env,
  tablesToKill: string[]
): Promise<{ table: string; deleted: number; error?: string }[]> {
  const results: { table: string; deleted: number; error?: string }[] = [];

  for (const name of tablesToKill) {
    try {
      const before = await countRows(env.DB, name);
      await env.DB.prepare(`DELETE FROM ${name}`).run();
      results.push({ table: name, deleted: before });
    } catch (err: any) {
      results.push({
        table: name,
        deleted: 0,
        error: err?.message ?? 'unknown',
      });
    }
  }

  try {
    await env.DB.prepare('VACUUM').run();
  } catch {
    // ignore
  }

  return results;
}

export const killCommand: CommandDefinition = {
  name: 'kill',
  description: '🧨 Reset bot — hapus semua session & cache',
  usage: '/kill',
  adminOnly: true,

  handler: async (ctx, env) => {
    const loading = await ctx.reply('🔍 Scan state...');

    try {
      const { text, total, tablesToKill } = await buildPreview(env);

      if (total === 0) {
        await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
        return;
      }

      const sessionId =
        'kk_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      const now = Date.now();

      const { setCache } = await import('../lib/cache');
      await setCache(
        env.DB,
        `kill:${sessionId}`,
        { userId: ctx.from?.id ?? 0, tables: tablesToKill },
        KILL_TTL_MS
      );
      void now; // keep TS happy kalau dihapus

      const kb = new InlineKeyboard()
        .text('🧨 KILL', `kill:go:${sessionId}`)
        .text('❌ Batal', `kill:cancel:${sessionId}`);

      await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      });
    } catch (err: any) {
      console.error('[Kill] scan error:', err);
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    }
  },
};

export function setupKillCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^kill:go:(kk_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }

    const { getCache, deleteCache } = await import('../lib/cache');
    const cached = await getCache<{ userId: number; tables: string[] }>(
      env.DB,
      `kill:${sessionId}`
    );

    if (!cached) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Kadaluarsa. Ulangi /kill.',
        show_alert: true,
      });
      return;
    }

    if (ctx.from?.id !== cached.userId) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '🧨 Killing...' });

    const loadingMsg = await ctx.reply('🧨 <b>Menghapus...</b>', {
      parse_mode: 'HTML',
    });

    try {
      const results = await executeKill(env, cached.tables);

      await deleteCache(env.DB, `kill:${sessionId}`);

      let totalDeleted = 0;
      const lines: string[] = [];
      lines.push('✅ <b>KILL selesai.</b>');
      lines.push('');

      for (const r of results) {
        if (r.error) {
          lines.push(
            `❌ <code>${escapeHtml(r.table)}</code> — <i>${escapeHtml(r.error.slice(0, 100))}</i>`
          );
        } else {
          totalDeleted += r.deleted;
          lines.push(
            `🗑️ <code>${escapeHtml(r.table)}</code> — ${r.deleted} row`
          );
        }
      }

      lines.push('');
      lines.push(`📊 <b>Total: ${totalDeleted} row dihapus.</b>`);
      lines.push('');
      lines.push(
        `<i>voice_actors aman. Bot kembali ke state bersih.</i>`
      );

      await ctx.api
        .editMessageText(ctx.chat!.id, loadingMsg.message_id, lines.join('\n'), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: undefined,
        })
        .catch(() => {});
    } catch (err: any) {
      console.error('[Kill] execute error:', err);
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loadingMsg.message_id,
          `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
          { parse_mode: 'HTML', reply_markup: undefined }
        )
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^kill:cancel:(kk_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (sessionId) {
      const { deleteCache } = await import('../lib/cache');
      await deleteCache(env.DB, `kill:${sessionId}`);
    }
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageText('❌ <b>KILL dibatalkan.</b>', {
        parse_mode: 'HTML',
        reply_markup: undefined,
      })
      .catch(() => {});
  });
}