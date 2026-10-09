// src/commands/track-delete.ts
import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Env } from '../types/env';
import { escapeHtml } from '../lib/utils';
import {
  deleteTrackedAnime,
  listAllTrackedAnime,
  type SiteKey,
  type TrackedAnimeRow,
} from '../lib/cron/state';

async function fetchBySite(env: Env, site: SiteKey): Promise<TrackedAnimeRow[]> {
  const all = await listAllTrackedAnime(env.DB);
  return all.filter((r) => r.site === site).sort((a, b) => a.slug.localeCompare(b.slug));
}

async function countBySite(env: Env): Promise<Record<SiteKey, number>> {
  const all = await listAllTrackedAnime(env.DB);
  const result: Record<SiteKey, number> = { lexanime: 0, animesub: 0, samehadaku: 0 };
  for (const r of all) {
    if (r.site in result) result[r.site]++;
  }
  return result;
}

export async function showDeleteMenuPublic(ctx: Context, env: Env): Promise<void> {
  const counts = await countBySite(env);
  const total = counts.lexanime + counts.animesub + counts.samehadaku;

  if (total === 0) {
    await ctx
      .editMessageText('📭 Belum ada anime yang di-track.', {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().text('◀️ Kembali', 'tr:h'),
      })
      .catch(() => {});
    return;
  }

  const kb = new InlineKeyboard();
  if (counts.lexanime > 0) kb.text(`🎬 lexanime (${counts.lexanime})`, 'tr:ds:lexanime').row();
  if (counts.animesub > 0) kb.text(`🎬 animesub (${counts.animesub})`, 'tr:ds:animesub').row();
  if (counts.samehadaku > 0) kb.text(`🎬 samehadaku (${counts.samehadaku})`, 'tr:ds:samehadaku').row();
  kb.text('◀️ Kembali', 'tr:h');

  await ctx
    .editMessageText(
      `🗑️ <b>Hapus Anime</b>\n\n` + `Total: <b>${total}</b>\n\n` + `<i>Pilih situs:</i>`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      }
    )
    .catch(() => {});
}

export async function showDeleteSitePublic(
  ctx: Context,
  env: Env,
  site: SiteKey
): Promise<void> {
  const list = await fetchBySite(env, site);

  if (list.length === 0) {
    await ctx
      .editMessageText(`📭 Tidak ada anime dari <b>${site}</b>.`, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().text('◀️ Kembali', 'tr:dm'),
      })
      .catch(() => {});
    return;
  }

  const lines: string[] = [];
  lines.push(`🗑️ <b>Hapus dari ${escapeHtml(site)}</b>`);
  lines.push('');
  lines.push(`📊 Total: <b>${list.length}</b>`);
  lines.push('');
  lines.push('<b>Daftar:</b>');
  for (const r of list.slice(0, 8)) {
    lines.push(`• <code>${escapeHtml(r.slug)}</code>`);
  }
  if (list.length > 8) lines.push(`<i>… dan ${list.length - 8} lainnya</i>`);
  lines.push('');
  lines.push('<i>Pilih action:</i>');

  const kb = new InlineKeyboard()
    .text(`🗑️ Hapus Semua (${list.length})`, `tr:dall:${site}`)
    .row()
    .text('☑️ Pilih Satu-satu', `tr:dsel:${site}`)
    .row()
    .text('◀️ Kembali', 'tr:dm');

  await ctx
    .editMessageText(lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
    })
    .catch(() => {});
}

export async function confirmDeleteAllPublic(
  ctx: Context,
  env: Env,
  site: SiteKey
): Promise<void> {
  const list = await fetchBySite(env, site);

  const lines: string[] = [];
  lines.push('⚠️ <b>Konfirmasi Hapus Semua</b>');
  lines.push('');
  lines.push(
    `Yakin hapus <b>${list.length}</b> anime dari <b>${escapeHtml(site)}</b>?`
  );
  lines.push('');
  for (const r of list.slice(0, 10)) {
    lines.push(`• <code>${escapeHtml(r.slug)}</code>`);
  }
  if (list.length > 10) lines.push(`<i>… dan ${list.length - 10} lainnya</i>`);
  lines.push('');
  lines.push('<b>⚠️ Tidak bisa dibatalkan.</b>');

  await ctx
    .editMessageText(lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .text('✅ Ya, Hapus Semua', `tr:dally:${site}`)
        .text('❌ Batal', `tr:ds:${site}`),
    })
    .catch(() => {});
}

export async function execDeleteAllPublic(
  ctx: Context,
  env: Env,
  site: SiteKey
): Promise<void> {
  const list = await fetchBySite(env, site);

  let deleted = 0;
  for (const r of list) {
    const ok = await deleteTrackedAnime(env.DB, r.slug);
    if (ok) deleted++;
  }

  await ctx
    .editMessageText(
      `✅ <b>Hapus selesai</b>\n\n` +
        `🗑️ Dihapus: <b>${deleted}</b>\n` +
        `Situs: <b>${escapeHtml(site)}</b>`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text('🗑️ Hapus Lagi', 'tr:dm')
          .text('🏠 Menu', 'tr:h'),
      }
    )
    .catch(() => {});
}

export async function showDeleteSelectPublic(
  ctx: Context,
  env: Env,
  site: SiteKey,
  mask: number
): Promise<void> {
  const list = await fetchBySite(env, site);
  const selected = countBits(mask);

  const kb = new InlineKeyboard();
  list.forEach((row, i) => {
    const checked = (mask & (1 << i)) !== 0;
    const mark = checked ? '✅' : '⬜';
    const label = `${mark} ${row.slug}`;
    const short = label.length > 44 ? label.slice(0, 42) + '…' : label;
    kb.text(short, `tr:dt:${site}:${mask}:${i}`).row();
  });

  kb.text(`🗑️ Hapus (${selected})`, `tr:dgo:${site}:${mask}`)
    .text('❌ Batal', `tr:ds:${site}`);

  await ctx
    .editMessageText(
      `☑️ <b>Pilih — ${escapeHtml(site)}</b>\n\n` +
        `Total: <b>${list.length}</b> · Dipilih: <b>${selected}</b>\n\n` +
        `<i>Tap untuk toggle.</i>`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      }
    )
    .catch(() => {});
}

export async function toggleDeleteSelectPublic(
  ctx: Context,
  env: Env,
  site: SiteKey,
  mask: number,
  idx: number
): Promise<void> {
  const list = await fetchBySite(env, site);
  if (idx < 0 || idx >= list.length) {
    await ctx.answerCallbackQuery({ text: '❌' });
    return;
  }
  const newMask = mask ^ (1 << idx);
  await ctx.answerCallbackQuery({ text: '✓' });
  await showDeleteSelectPublic(ctx, env, site, newMask);
}

export async function confirmDeleteSelectedPublic(
  ctx: Context,
  env: Env,
  site: SiteKey,
  mask: number
): Promise<void> {
  if (mask === 0) {
    await ctx.answerCallbackQuery({ text: '❌ Tidak ada dipilih', show_alert: true });
    return;
  }

  const list = await fetchBySite(env, site);
  const selected = list.filter((_, i) => (mask & (1 << i)) !== 0);

  const lines: string[] = [];
  lines.push('⚠️ <b>Konfirmasi Hapus</b>');
  lines.push('');
  lines.push(`Yakin hapus <b>${selected.length}</b> anime?`);
  lines.push('');
  for (const r of selected.slice(0, 15)) {
    lines.push(`• <code>${escapeHtml(r.slug)}</code>`);
  }

  await ctx.answerCallbackQuery({ text: '⚠️' });
  await ctx
    .editMessageText(lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .text('✅ Ya, Hapus', `tr:dgy:${site}:${mask}`)
        .text('❌ Batal', `tr:dsel:${site}`),
    })
    .catch(() => {});
}

export async function execDeleteSelectedPublic(
  ctx: Context,
  env: Env,
  site: SiteKey,
  mask: number
): Promise<void> {
  const list = await fetchBySite(env, site);
  const selected = list.filter((_, i) => (mask & (1 << i)) !== 0);

  if (selected.length === 0) {
    await ctx.answerCallbackQuery({ text: '❌ Tidak ada dipilih' });
    return;
  }

  await ctx.answerCallbackQuery({ text: '🗑️' });

  let deleted = 0;
  for (const r of selected) {
    const ok = await deleteTrackedAnime(env.DB, r.slug);
    if (ok) deleted++;
  }

  await ctx
    .editMessageText(
      `✅ <b>Hapus selesai</b>\n\n` +
        `🗑️ Dihapus: <b>${deleted}</b>\n` +
        `Situs: <b>${escapeHtml(site)}</b>`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text('🗑️ Hapus Lagi', 'tr:dm')
          .text('🏠 Menu', 'tr:h'),
      }
    )
    .catch(() => {});
}

function countBits(n: number): number {
  let c = 0, x = n;
  while (x > 0) {
    c += x & 1;
    x >>>= 1;
  }
  return c;
}