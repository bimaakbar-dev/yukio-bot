// src/commands/publish/core.ts
import type { Context } from 'grammy';
import type { Env } from '../../types/env';
import type { CommandDefinition } from '../registry';
import type { FileToCommit } from '../../lib/github';
import { escapeHtml, slugify } from '../../lib/utils';
import { getLatestSessionByUser } from '../../lib/dba-session';
import {
  buildMetadataFile,
  buildQimochiMarkdownFromDba,
  buildCharacterFiles,
  buildEpisodeFiles,
  buildFranchiseFiles,
  buildActorFiles,
} from './builders';
import { buildPreviewLines, buildPreviewKeyboard } from './preview';
import { savePendingPublish } from './state';
import {
  ALL_SECTIONS,
  emptySummary,
  sectionFromPath,
  type SectionKey,
} from './types';

export async function doPublishNew(ctx: Context, env: Env): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const loading = await ctx.reply('🔍 Scan session...');

  try {
    const session = await getLatestSessionByUser(env.DB, userId);

    if (!session) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        '📭 Tidak ada session /dba aktif.\n\n' +
          'Kirim <code>/dba &lt;judul&gt;</code> dulu.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const slug = slugify(session.title);
    const files: FileToCommit[] = [];
    const summary = emptySummary();

    /* ── Metadata → yukionime + qimochi ──────── */
    const metaFile = await buildMetadataFile(env, session, slug);
    if (metaFile) {
      files.push(metaFile);
      summary.yukionime.metadata = true;
    }

    // Auto-mirror markdown tipis ke qimochi
    const qimochiMd = buildQimochiMarkdownFromDba(session, slug);
    if (qimochiMd) {
      files.push(qimochiMd);
    }

    /* ── Characters ──────────────────────────── */
    try {
      const charFiles = await buildCharacterFiles(env, session.session_id, slug);
      if (charFiles.length > 0) {
        files.push(...charFiles);
        let total = 0;
        for (const cf of charFiles) total += cf.itemCount ?? 0;
        summary.yukioData.characters = { count: total, files: charFiles.length };
      }
    } catch (err) {
      console.warn('[Publish] buildCharacterFiles error:', err);
    }

    /* ── Episodes ────────────────────────────── */
    try {
      const epFiles = await buildEpisodeFiles(env, session.session_id, slug);
      if (epFiles.length > 0) {
        files.push(...epFiles);
        let total = 0;
        for (const ef of epFiles) total += ef.itemCount ?? 0;
        summary.yukioData.episodes = { count: total, files: epFiles.length };
      }
    } catch (err) {
      console.warn('[Publish] buildEpisodeFiles error:', err);
    }

    /* ── Franchises ──────────────────────────── */
    try {
      const frFiles = await buildFranchiseFiles(session, slug);
      if (frFiles.length > 0) {
        files.push(...frFiles);

        const yukioFr = frFiles.find((f) => f.target === 'yukio-data');
        if (yukioFr) {
          summary.yukioData.franchises = {
            count: yukioFr.itemCount ?? 0,
            files: 1,
          };
        }
        const qFr = frFiles.find((f) => f.target === 'qimochi');
        if (qFr) {
          summary.qimochi.franchises = {
            count: qFr.itemCount ?? 0,
            files: 1,
          };
        }
      }
    } catch (err) {
      console.warn('[Publish] buildFranchiseFiles error:', err);
    }

    /* ── Actors ──────────────────────────────── */
    try {
      const vaFiles = await buildActorFiles(env);
      if (vaFiles.length > 0) {
        files.push(...vaFiles);
        let total = 0;
        for (const vf of vaFiles) total += vf.itemCount ?? 0;
        summary.yukioData.actors = { count: total, files: vaFiles.length };
      }
    } catch (err) {
      console.warn('[Publish] buildActorFiles error:', err);
    }

    /* ── Empty check ─────────────────────────── */
    if (files.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `⚠️ <b>Tidak ada data siap di-publish.</b>\n\n` +
          `Buka <code>/dba</code> → klik <b>📋 Metadata</b>, <b>👥 Characters</b>, atau <b>🎬 Episodes</b> dulu.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    /* ── Preview ─────────────────────────────── */
    const availableSections = new Set<SectionKey>();
    for (const f of files) {
      availableSections.add(sectionFromPath(f.path));
    }

    const selected = new Set<SectionKey>(
      ALL_SECTIONS.filter((s) => availableSections.has(s))
    );

    const pendingId = await savePendingPublish(
      env.DB,
      userId,
      files,
      summary,
      [...selected]
    );

    const previewText = buildPreviewLines(
      session.title,
      slug,
      summary,
      selected
    );
    const kb = buildPreviewKeyboard(pendingId, summary, selected);

    await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, previewText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
    });
  } catch (err: any) {
    console.error('[Publish] scan error:', err);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
}

export const publishCommand: CommandDefinition = {
  name: 'publish',
  description: 'Push semua data ke yukionime + yukio-data',
  usage: '/publish',
  adminOnly: true,

  handler: async (ctx, env) => {
    await doPublishNew(ctx, env);
  },
};
