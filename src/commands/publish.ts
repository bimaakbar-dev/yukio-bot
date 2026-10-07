// src/commands/publish.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard, type Bot } from 'grammy';
import type { Env } from '../types/env';
import type { AniListMedia } from '../types/anime';
import {
  githubCommitFile,
  githubCommitMultipleFiles,
  githubGetFile,
  type FileToCommit,
  type RepoTarget,
} from '../lib/github';
import {
  escapeHtml,
  stripHtml,
  slugify,
  chunkArray,
  looksIndonesian,
} from '../lib/utils';
import { getCharCache, CHAR_PART_SIZE } from '../lib/dba-characters';
import { getEpCache } from '../lib/dba-episodes';
import {
  getLatestSessionByUser,
  type SessionRow as DbaSessionRow,
} from '../lib/dba-session';
import { buildMetadataYaml } from '../services/qimochi-yaml';
import { chainRelations } from '../services/qimochi-chain-extras';
import { askAI } from '../services/ai';
import { safeFetch } from '../lib/dba-common';
import { filterFranchises } from '../lib/franchises';
import {
  getTempAnime,
  getLatestTempAnimeByUser,
  deleteTempAnime,
  buildAnimeMarkdown,
} from '../lib/temp-anime';
import {
  getBatchSession,
  updateBatchChosenSlug,
  updateBatchSuggestions,
  deleteBatchSession,
  resetBatchSessions,
  findSimilarSlugs,
} from '../lib/batch-session';

const PUBLISH_TTL_MS = 30 * 60 * 1000;
const EP_PART_SIZE = 12;
const RELATION_FETCH_TIMEOUT_MS = 8000;
const AI_REWRITE_TIMEOUT_MS = 12000;

type SectionKey = 'meta' | 'chars' | 'eps' | 'fr' | 'va';

const ALL_SECTIONS: SectionKey[] = ['meta', 'chars', 'eps', 'fr', 'va'];

const SECTION_LABEL: Record<SectionKey, string> = {
  meta: '📄 Metadata + Summary',
  chars: '👥 Characters',
  eps: '🎬 Episodes',
  fr: '🔗 Franchises',
  va: '🎤 Actors',
};

interface PendingPublishRow {
  session_id: string;
  user_id: number;
  files_json: string;
  summary_json: string;
  selected_json: string | null;
  created_at: number;
  expires_at: number;
}

interface SectionInfo {
  count: number;
  files: number;
}

interface PublishSummary {
  yukionime: { metadata: boolean };
  yukioData: {
    characters: SectionInfo;
    episodes: SectionInfo;
    franchises: SectionInfo;
    actors: SectionInfo;
  };
  qimochi: {
    franchises: SectionInfo;
  };
}

function emptySummary(): PublishSummary {
  return {
    yukionime: { metadata: false },
    yukioData: {
      characters: { count: 0, files: 0 },
      episodes: { count: 0, files: 0 },
      franchises: { count: 0, files: 0 },
      actors: { count: 0, files: 0 },
    },
    qimochi: {
      franchises: { count: 0, files: 0 },
    },
  };
}

function sectionFromPath(path: string): SectionKey {
  if (path.startsWith('src/content/anime/')) return 'meta';
  if (path.includes('/characters/')) return 'chars';
  if (path.includes('/episodes/')) return 'eps';
  if (path.endsWith('/franchises.json')) return 'fr';
  if (path.startsWith('data/actors/')) return 'va';
  return 'meta';
}

let pendingPublishDbReady = false;
let pendingPublishDbInitPromise: Promise<void> | null = null;

async function ensurePendingPublishDb(db: D1Database): Promise<void> {
  if (pendingPublishDbReady) return;
  if (pendingPublishDbInitPromise) return pendingPublishDbInitPromise;

  pendingPublishDbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS pending_publish (
            session_id    TEXT PRIMARY KEY,
            user_id       INTEGER NOT NULL,
            files_json    TEXT NOT NULL,
            summary_json  TEXT NOT NULL,
            selected_json TEXT,
            created_at    INTEGER NOT NULL,
            expires_at    INTEGER NOT NULL
          )`
        )
        .run();
      try {
        await db
          .prepare(
            'ALTER TABLE pending_publish ADD COLUMN selected_json TEXT'
          )
          .run();
      } catch {}
      pendingPublishDbReady = true;
    } catch (err) {
      console.error('[Publish] pending DB init error:', err);
      pendingPublishDbInitPromise = null;
      throw err;
    }
  })();

  return pendingPublishDbInitPromise;
}

async function savePendingPublish(
  db: D1Database,
  userId: number,
  files: FileToCommit[],
  summary: PublishSummary,
  selected: SectionKey[]
): Promise<string> {
  await ensurePendingPublishDb(db);
  const sessionId = 'pp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 13);
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO pending_publish
        (session_id, user_id, files_json, summary_json, selected_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      userId,
      JSON.stringify(files),
      JSON.stringify(summary),
      JSON.stringify(selected),
      now,
      now + PUBLISH_TTL_MS
    )
    .run();

  return sessionId;
}

async function getPendingPublish(
  db: D1Database,
  sessionId: string
): Promise<PendingPublishRow | null> {
  await ensurePendingPublishDb(db);

  const row = await db
    .prepare('SELECT * FROM pending_publish WHERE session_id = ?')
    .bind(sessionId)
    .first<PendingPublishRow>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM pending_publish WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }

  return row;
}

async function updatePendingSelected(
  db: D1Database,
  sessionId: string,
  selected: SectionKey[]
): Promise<void> {
  await ensurePendingPublishDb(db);
  await db
    .prepare('UPDATE pending_publish SET selected_json = ? WHERE session_id = ?')
    .bind(JSON.stringify(selected), sessionId)
    .run();
}

async function deletePendingPublish(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await ensurePendingPublishDb(db);
    await db
      .prepare('DELETE FROM pending_publish WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[Publish] deletePendingPublish error:', err);
  }
}

async function rewriteSynopsisToId(
  env: Env,
  title: string,
  originalSynopsis: string
): Promise<string | null> {
  if (!originalSynopsis || originalSynopsis.length < 30) return null;

  const prompt =
    `Tulis ulang sinopsis anime berikut menjadi bahasa Indonesia yang natural.\n\n` +
    `Judul: ${title}\n\n` +
    `Sinopsis referensi:\n${originalSynopsis.slice(0, 2000)}\n\n` +
    `ATURAN:\n` +
    `- Tulis sebagai sinopsis baru, BUKAN terjemahan literal\n` +
    `- Bahasa Indonesia natural dan mengalir\n` +
    `- 2-3 paragraf pendek\n` +
    `- Jangan spoiler\n` +
    `- Jangan tambahkan info yang tidak ada di referensi\n` +
    `- Langsung mulai dari tokoh utama atau setting\n\n` +
    `Output hanya sinopsis, tanpa penjelasan tambahan.`;

  const { data } = await safeFetch(
    () =>
      askAI(env, prompt, {
        maxTokens: 700,
        temperature: 0.6,
        smart: true,
      }),
    AI_REWRITE_TIMEOUT_MS
  );

  if (data && data.length > 50) return data.trim();
  return null;
}

async function buildMetadataFile(
  env: Env,
  session: DbaSessionRow,
  slug: string
): Promise<FileToCommit | null> {
  if (!session.metadata) return null;

  let media: AniListMedia;
  try {
    media = JSON.parse(session.metadata) as AniListMedia;
  } catch {
    return null;
  }

  const yaml = buildMetadataYaml({
    media,
    malId: session.mal_id ?? null,
    kitsuId: session.kitsu_id ?? null,
  });

  let body: string;

  if (session.summary && session.summary.trim().length > 50) {
    body = session.summary.trim();
  } else {
    const raw = media.description ?? '';
    if (raw.length < 30) {
      body = '> ⚠️ Sinopsis belum tersedia. Silakan isi manual.';
    } else {
      const clean = stripHtml(raw);
      if (looksIndonesian(clean)) {
        body = clean;
      } else {
        const aiBody = await rewriteSynopsisToId(env, session.title, clean);
        body = aiBody ?? clean;
      }
    }
  }

  return {
    path: `src/content/anime/${slug}.md`,
    content: `${yaml}\n\n${body}\n`,
    target: 'yukionime',
  };
}

async function buildCharacterFiles(
  env: Env,
  sessionId: string,
  slug: string
): Promise<FileToCommit[]> {
  const cache = await getCharCache(env.DB, sessionId);
  if (!cache || cache.chars.length === 0) return [];

  const chunks = chunkArray(cache.chars, CHAR_PART_SIZE);
  const files: FileToCommit[] = [];

  let cursor = 1;
  for (const chunk of chunks) {
    const start = cursor;
    const end = cursor + chunk.length - 1;
    files.push({
      path: `data/anime/${slug}/characters/${start}-${end}.json`,
      content: JSON.stringify(chunk, null, 2) + '\n',
      target: 'yukio-data',
      itemCount: chunk.length,
    });
    cursor = end + 1;
  }

  return files;
}

async function buildEpisodeFiles(
  env: Env,
  sessionId: string,
  slug: string
): Promise<FileToCommit[]> {
  const cache = await getEpCache(env.DB, sessionId);
  if (!cache || cache.episodes.length === 0) return [];

  const sorted = [...cache.episodes].sort((a, b) => a.number - b.number);
  const chunks = chunkArray(sorted, EP_PART_SIZE);
  const files: FileToCommit[] = [];

  for (const chunk of chunks) {
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    if (!first || !last) continue;

    files.push({
      path: `data/anime/${slug}/episodes/${first.number}-${last.number}.json`,
      content: JSON.stringify(chunk, null, 2) + '\n',
      target: 'yukio-data',
      itemCount: chunk.length,
    });
  }

  return files;
}

async function buildFranchiseFiles(
  session: DbaSessionRow,
  slug: string
): Promise<FileToCommit[]> {
  if (!session.mal_id) return [];

  const { data: result } = await safeFetch(
    () =>
      chainRelations({
        malId: session.mal_id,
        kitsuId: session.kitsu_id,
        title: session.title,
      }),
    RELATION_FETCH_TIMEOUT_MS
  );

  if (!result || !result.data || result.data.length === 0) return [];

  const filtered = filterFranchises(result.data);
  if (filtered.length === 0) return [];

  const json = JSON.stringify(filtered, null, 2) + '\n';
  const itemCount = filtered.length;

  return [
    {
      path: `data/anime/${slug}/franchises.json`,
      content: json,
      target: 'yukio-data',
      itemCount,
    },
    {
      path: `src/data/anime/${slug}/franchises.json`,
      content: json,
      target: 'qimochi',
      itemCount,
    },
  ];
}

function buildPreviewLines(
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

  const hasMeta = summary.yukionime.metadata;
  const d = summary.yukioData;
  const hasChars = d.characters.count > 0;
  const hasEps = d.episodes.count > 0;
  const hasFr = d.franchises.count > 0;
  const hasVa = d.actors.count > 0;
  const hasQFr = summary.qimochi.franchises.count > 0;

  const totalReady =
    (hasMeta ? 1 : 0) +
    (hasChars ? 1 : 0) +
    (hasEps ? 1 : 0) +
    (hasFr ? 1 : 0) +
    (hasVa ? 1 : 0) +
    (hasQFr ? 1 : 0);

  if (totalReady === 0) {
    lines.push('<i>Tidak ada data siap di-publish.</i>');
    return lines.join('\n');
  }

  const check = (k: SectionKey) => (selected.has(k) ? '✅' : '⬜');

  if (hasMeta) {
    lines.push(`${check('meta')} ${SECTION_LABEL.meta} → yukionime`);
  }
  if (hasChars) {
    lines.push(
      `${check('chars')} ${SECTION_LABEL.chars} (${d.characters.count}) → yukio-data (${d.characters.files} file)`
    );
  }
  if (hasEps) {
    lines.push(
      `${check('eps')} ${SECTION_LABEL.eps} (${d.episodes.count}) → yukio-data (${d.episodes.files} file)`
    );
  }
  if (hasFr) {
    lines.push(
      `${check('fr')} ${SECTION_LABEL.fr} (${d.franchises.count}) → yukio-data`
    );
  }
  if (hasVa) {
    lines.push(
      `${check('va')} ${SECTION_LABEL.va} (${d.actors.count}) → yukio-data (${d.actors.files} file)`
    );
  }
  if (hasQFr) {
    lines.push(`${check('fr')} ${SECTION_LABEL.fr} → qimochi`);
  }

  lines.push('');
  lines.push(
    `<i>Tap section untuk toggle. Tap 📤 Push untuk commit yang dipilih.</i>`
  );

  return lines.join('\n');
}

function buildPreviewKeyboard(
  pendingId: string,
  summary: PublishSummary,
  selected: Set<SectionKey>
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const d = summary.yukioData;

  const hasMeta = summary.yukionime.metadata;
  const hasChars = d.characters.count > 0;
  const hasEps = d.episodes.count > 0;
  const hasFr = d.franchises.count > 0 || summary.qimochi.franchises.count > 0;
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

async function doPublishAnime(
  ctx: Context,
  env: Env,
  sessionId: string,
  force: boolean
): Promise<void> {
  const session = await getTempAnime(env.DB, sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({
      text: '⏱️ Session kadaluarsa. Ulangi /anime.',
      show_alert: true,
    });
    return;
  }

  const slug = session.slug?.trim();
  if (!slug) {
    await ctx.answerCallbackQuery({
      text: '❌ Slug kosong. Ulangi /anime.',
      show_alert: true,
    });
    return;
  }

  const path = `src/content/anime/${slug}.md`;
  const content = buildAnimeMarkdown(session);

  if (!force) {
    let existing: Awaited<ReturnType<typeof githubGetFile>> = null;
    try {
      existing = await githubGetFile(env, path);
    } catch (err) {
      console.warn('[Publish] getFile failed:', err);
    }

    if (existing) {
      const previewOld = existing.content.slice(0, 300);
      await ctx.answerCallbackQuery({ text: '⚠️ File sudah ada' });

      const kb = new InlineKeyboard()
        .text('✅ Overwrite', `pub:anforce:${sessionId}`)
        .text('❌ Batal', `pub:skip:${sessionId}`);

      await ctx.reply(
        `⚠️ <b>File sudah ada di repo!</b>\n\n` +
          `📁 <code>${escapeHtml(path)}</code>\n` +
          `📏 Lama: <b>${existing.content.length}</b> char\n` +
          `📏 Baru: <b>${content.length}</b> char\n\n` +
          `<b>Preview lama:</b>\n` +
          `<pre>${escapeHtml(previewOld)}</pre>\n\n` +
          `Overwrite?`,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: kb,
        }
      );
      return;
    }
  }

  await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

  const loadingMsg = await ctx.reply(
    `📤 <b>Push ke GitHub...</b>\n\n📁 <code>${escapeHtml(path)}</code>`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );

  const result = await githubCommitFile(
    env,
    path,
    content,
    `feat: add anime ${slug}`
  );

  if (!result.ok) {
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        `❌ <b>Gagal push</b>\n\n<code>${escapeHtml(result.error ?? 'unknown')}</code>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
    return;
  }

  await deleteTempAnime(env.DB, sessionId);

  const commitShort = result.sha?.slice(0, 7) ?? '?';

  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      loadingMsg.message_id,
      `✅ <b>Published!</b>\n\n` +
        `📁 <code>${escapeHtml(path)}</code>\n` +
        `🔗 Commit: <code>${commitShort}</code>\n` +
        `⏳ Deploy: ~2 menit`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    )
    .catch(() => {});
}

async function doPublishBatchInitial(
  ctx: Context,
  env: Env,
  sessionId: string
): Promise<void> {
  const session = await getBatchSession(env.DB, sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({
      text: '⏱️ Batch kadaluarsa. Ulangi /batch.',
      show_alert: true,
    });
    return;
  }

  if (ctx.from?.id !== session.user_id) {
    await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
    return;
  }

  await ctx.answerCallbackQuery({ text: '🔍 Cari slug...' });

  const slugHint = session.slug_hint ?? '';
  const suggestions = slugHint ? await findSimilarSlugs(env, slugHint) : [];

  await updateBatchSuggestions(
    env.DB,
    sessionId,
    suggestions.map((s) => s.slug)
  );

  const lines: string[] = [];
  lines.push(`📦 <b>Publish Batch</b>`);
  lines.push('');
  lines.push(`🎬 <code>${escapeHtml(slugHint || '(slug hint kosong)')}</code>`);
  lines.push(`📊 <b>${session.min_ep}-${session.max_ep}</b>`);
  if (session.total_urls) lines.push(`🎬 URL: <b>${session.total_urls}</b>`);
  lines.push('');

  const kb = new InlineKeyboard();

  if (suggestions.length > 0) {
    lines.push('🔍 <b>Slug mirip di repo:</b>');
    suggestions.forEach((s, i) => {
      const pct = Math.round(s.score * 100);
      lines.push(`${i + 1}. <code>${escapeHtml(s.slug)}</code> (${pct}%)`);
      const label = s.slug.length > 26 ? s.slug.slice(0, 24) + '…' : s.slug;
      kb.text(`📁 ${label} (${pct}%)`, `pub:bp:${sessionId}:${i}`).row();
    });
    lines.push('');
  } else {
    lines.push('⚠️ Tidak ada slug mirip di repo.');
    lines.push('');
  }

  if (slugHint) {
    kb.text('✨ Pakai slug dari URL', `pub:bp:${sessionId}:url`).row();
  }
  kb.text('✏️ Custom slug', `pub:bp:${sessionId}:custom`).row();
  kb.text('❌ Batal', `pub:bax:${sessionId}`);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

async function doPublishBatchPickSlug(
  ctx: Context,
  env: Env,
  sessionId: string,
  pick: string
): Promise<void> {
  const session = await getBatchSession(env.DB, sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: '⏱️ Batch kadaluarsa' });
    return;
  }

  let slug: string | null = null;

  if (pick === 'url') {
    slug = session.slug_hint;
  } else if (pick === 'custom') {
    await ctx.answerCallbackQuery({ text: '✏️ Kirim slug manual' });
    await ctx.reply(
      `✏️ Kirim slug baru via command:\n\n` +
        `<code>/publish_batch ${sessionId} slug-baru-kamu</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  } else {
    const idx = parseInt(pick, 10);
    let arr: string[] = [];
    try {
      arr = session.suggestions
        ? (JSON.parse(session.suggestions) as string[])
        : [];
    } catch {
      arr = [];
    }
    slug = arr[idx] ?? null;
  }

  if (!slug) {
    await ctx.answerCallbackQuery({ text: '❌ Slug tidak valid' });
    return;
  }

  await updateBatchChosenSlug(env.DB, sessionId, slug);
  await ctx.answerCallbackQuery({ text: `✅ ${slug.slice(0, 30)}` });

  await doPublishBatchPreview(ctx, env, sessionId, slug);
}

async function doPublishBatchPreview(
  ctx: Context,
  env: Env,
  sessionId: string,
  slug: string
): Promise<void> {
  const session = await getBatchSession(env.DB, sessionId);
  if (!session) {
    await ctx.answerCallbackQuery({ text: '⏱️ Batch kadaluarsa' });
    return;
  }

  const path = `src/data/anime/${slug}/episodes/${session.min_ep}-${session.max_ep}.json`;
  const sizeKB = Math.round(session.combined_json.length / 1024);

  let episodes: { number: number }[] = [];
  try {
    episodes = JSON.parse(session.combined_json) as { number: number }[];
  } catch {
    episodes = [];
  }

  const episodeCount = episodes.length;
  const rangeExpected = session.max_ep - session.min_ep + 1;
  const hasGap = episodeCount !== rangeExpected;

  let existing: Awaited<ReturnType<typeof githubGetFile>> = null;
  try {
    existing = await githubGetFile(env, path);
  } catch {}

  const lines: string[] = [];
  lines.push(`📋 <b>Preview Publish</b>`);
  lines.push('');
  lines.push(`📁 <code>${escapeHtml(path)}</code>`);
  lines.push(`📏 ${sizeKB} KB`);
  lines.push(`📊 ${episodeCount} episode (Ep ${session.min_ep}-${session.max_ep})`);
  if (hasGap) {
    lines.push(`⚠️ <i>Ada gap — hanya ${episodeCount} dari ${rangeExpected} episode.</i>`);
  }
  if (session.total_urls) lines.push(`🎬 URL: <b>${session.total_urls}</b>`);
  lines.push('');

  if (existing) {
    lines.push(
      `⚠️ <b>File sudah ada!</b> (${Math.round(existing.content.length / 1024)} KB)`
    );
    lines.push('Akan di-overwrite.');
  } else {
    lines.push('✅ File baru.');
  }

  const kb = new InlineKeyboard()
    .text('📤 Push ke GitHub', `pub:bpush:${sessionId}`)
    .text('❌ Batal', `pub:bax:${sessionId}`);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  });
}

async function doPublishBatchPush(
  ctx: Context,
  env: Env,
  sessionId: string
): Promise<void> {
  const session = await getBatchSession(env.DB, sessionId);
  if (!session || !session.chosen_slug) {
    await ctx.answerCallbackQuery({
      text: '⏱️ Batch kadaluarsa atau slug belum dipilih',
      show_alert: true,
    });
    return;
  }

  const slug = session.chosen_slug;
  const path = `src/data/anime/${slug}/episodes/${session.min_ep}-${session.max_ep}.json`;

  await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

  const loading = await ctx.reply(
    `📤 <b>Push ke GitHub...</b>\n\n📁 <code>${escapeHtml(path)}</code>`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );

  const commitMsg = `feat: add episodes ${session.min_ep}-${session.max_ep} for ${slug}`;
  const result = await githubCommitFile(env, path, session.combined_json, commitMsg);

  if (!result.ok) {
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ <b>Gagal push</b>\n\n<code>${escapeHtml(result.error ?? 'unknown')}</code>`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
    return;
  }

  await deleteBatchSession(env.DB, sessionId);

  const commitShort = result.sha?.slice(0, 7) ?? '?';
  const siteUrl = `https://qimochi.pages.dev/anime/${slug}/`;

  await ctx.api
    .editMessageText(
      ctx.chat!.id,
      loading.message_id,
      `✅ <b>Published!</b>\n\n` +
        `📁 <code>${escapeHtml(path)}</code>\n` +
        `🔗 Commit: <code>${commitShort}</code>\n` +
        `⏳ Deploy: ~2 menit\n\n` +
        (result.commitUrl ? `<a href="${result.commitUrl}">Lihat commit</a>\n` : '') +
        `🌐 <a href="${siteUrl}">${escapeHtml(siteUrl)}</a>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    )
    .catch(() => {});
}

async function doPublishNew(ctx: Context, env: Env): Promise<void> {
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

    const metaFile = await buildMetadataFile(env, session, slug);
    if (metaFile) {
      files.push(metaFile);
      summary.yukionime.metadata = true;
    }

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

export const publishAnimeCommand: CommandDefinition = {
  name: 'publish_anime',
  description: 'Push metadata anime ke qimochi',
  usage: '/publish_anime [slug]',
  adminOnly: true,

  handler: async (ctx, env) => {
    const argSlug = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const userId = ctx.from?.id;
    if (!userId) return;

    const row = await getLatestTempAnimeByUser(env.DB, userId);

    if (!row) {
      await ctx.reply(
        '📭 Tidak ada session /anime yang aktif.\n\n' +
          'Kirim <code>/anime &lt;judul&gt;</code> lalu klik 📋 Convert ke YAML dulu.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const slug = argSlug || row.slug;
    if (!slug) {
      await ctx.reply(
        '❌ Session tidak punya slug. Kirim slug manual:\n' +
          '<code>/publish_anime my-slug-here</code>',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const path = `src/content/anime/${slug}.md`;
    const content = buildAnimeMarkdown({ ...row, slug });

    const loading = await ctx.reply(
      `📤 <b>Push ke GitHub...</b>\n\n📁 <code>${escapeHtml(path)}</code>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );

    const result = await githubCommitFile(
      env,
      path,
      content,
      `feat: add anime ${slug}`
    );

    if (!result.ok) {
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ <b>Gagal push</b>\n\n<code>${escapeHtml(result.error ?? 'unknown')}</code>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
      return;
    }

    await deleteTempAnime(env.DB, row.session_id);

    const commitShort = result.sha?.slice(0, 7) ?? '?';
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `✅ <b>Published!</b>\n\n` +
          `📁 <code>${escapeHtml(path)}</code>\n` +
          `🔗 Commit: <code>${commitShort}</code>\n` +
          `⏳ Deploy ~2 menit`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      )
      .catch(() => {});
  },
};

export const publishBatchCommand: CommandDefinition = {
  name: 'publish_batch',
  description: 'Push batch episode ke repo web',
  usage: '/publish_batch [session_id] [slug]',
  adminOnly: true,

  handler: async (ctx, env) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const parts = arg.split(/\s+/).filter(Boolean);

    if (parts.length === 2 && parts[0] && parts[1]) {
      const sessionId = parts[0];
      const customSlug = parts[1];
      const session = await getBatchSession(env.DB, sessionId);
      if (!session) {
        await ctx.reply('❌ Session batch tidak ditemukan / kadaluarsa.');
        return;
      }
      if (session.user_id !== ctx.from?.id) {
        await ctx.reply('⛔ Bukan sesi Anda.');
        return;
      }

      await updateBatchChosenSlug(env.DB, sessionId, customSlug);
      await doPublishBatchPreview(ctx, env, sessionId, customSlug);
      return;
    }

    await ctx.reply(
      '<b>📦 Publish Batch</b>\n\n' +
        '<b>Auto:</b> dari tombol di akhir <code>/batch</code>\n\n' +
        '<b>Manual:</b>\n' +
        '<code>/publish_batch &lt;session_id&gt; &lt;slug&gt;</code>\n\n' +
        '<i>Session ID ada di pesan batch selesai.</i>',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
  },
};

export const batchResetCommand: CommandDefinition = {
  name: 'batch_reset',
  description: 'Hapus semua session batch aktif',
  adminOnly: true,

  handler: async (ctx, env) => {
    if (!ctx.from?.id) return;
    const count = await resetBatchSessions(env.DB, ctx.from.id);
    if (count === 0) {
      await ctx.reply('📭 Tidak ada session batch aktif.');
      return;
    }
    await ctx.reply(`✅ <b>${count}</b> session batch dihapus.`, {
      parse_mode: 'HTML',
    });
  },
};

export const publishCommand: CommandDefinition = {
  name: 'publish',
  description: 'Push semua data ke yukionime + yukio-data',
  usage: '/publish',
  adminOnly: true,

  handler: async (ctx, env) => {
    await doPublishNew(ctx, env);
  },
};

export function setupPublishCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^pub:an:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishAnime(ctx, env, sessionId, false);
  });

  bot.callbackQuery(/^pub:anforce:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishAnime(ctx, env, sessionId, true);
  });

  bot.callbackQuery(/^pub:skip:([a-f0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (sessionId) await deleteTempAnime(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageReplyMarkup({ reply_markup: undefined })
      .catch(() => {});
    await ctx
      .reply('❌ <b>Dibatalkan.</b>', { parse_mode: 'HTML' })
      .catch(() => {});
  });

  bot.callbackQuery(/^pub:ba:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishBatchInitial(ctx, env, sessionId);
  });

  bot.callbackQuery(/^pub:bp:(b_[a-z0-9]+):(.+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    const pick = ctx.match[2] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishBatchPickSlug(ctx, env, sessionId, pick);
  });

  bot.callbackQuery(/^pub:bpush:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }
    await doPublishBatchPush(ctx, env, sessionId);
  });

  bot.callbackQuery(/^pub:bax:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (sessionId) await deleteBatchSession(env.DB, sessionId);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageReplyMarkup({ reply_markup: undefined })
      .catch(() => {});
    await ctx
      .reply('❌ <b>Batch dibatalkan.</b>', { parse_mode: 'HTML' })
      .catch(() => {});
  });

  bot.callbackQuery(/^pub:baadd:(b_[a-z0-9]+)$/, async (ctx) => {
    const sessionId = ctx.match[1] ?? '';
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌' });
      return;
    }

    const session = await getBatchSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: '⏱️ Batch kadaluarsa' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '➕ Kirim /batch lagi' });

    await ctx.reply(
      `➕ <b>Tambah Batch</b>\n\n` +
        `Session aktif:\n` +
        `<code>${sessionId}</code>\n\n` +
        `📊 Sekarang: <b>${session.min_ep}-${session.max_ep}</b>\n` +
        (session.slug_hint
          ? `🎬 <code>${escapeHtml(session.slug_hint)}</code>\n`
          : '') +
        `\nKirim <code>/batch &lt;url&gt; &lt;range&gt;</code> lagi.\n` +
        `Episode yang sudah ada akan otomatis di-skip.`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
  });

  bot.callbackQuery(
    /^pp:t:(pp_[a-z0-9]+):(meta|chars|eps|fr|va)$/,
    async (ctx) => {
      try {
        const pendingId = ctx.match[1] ?? '';
        const section = (ctx.match[2] ?? '') as SectionKey;

        if (!pendingId || !ALL_SECTIONS.includes(section)) {
          await ctx.answerCallbackQuery({ text: '❌' });
          return;
        }

        const pending = await getPendingPublish(env.DB, pendingId);
        if (!pending) {
          await ctx.answerCallbackQuery({
            text: '⏱️ Kadaluarsa. Ulangi /publish.',
            show_alert: true,
          });
          return;
        }

        if (ctx.from?.id !== pending.user_id) {
          await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
          return;
        }

        let selected: SectionKey[] = [];
        try {
          if (pending.selected_json) {
            selected = JSON.parse(pending.selected_json) as SectionKey[];
          }
        } catch {
          selected = [];
        }

        const set = new Set(selected);
        if (set.has(section)) {
          set.delete(section);
        } else {
          set.add(section);
        }

        const newSelected = ALL_SECTIONS.filter((s) => set.has(s));
        await updatePendingSelected(env.DB, pendingId, newSelected);

        let summary: PublishSummary;
        try {
          summary = JSON.parse(pending.summary_json) as PublishSummary;
        } catch {
          summary = emptySummary();
        }

        const session = await getLatestSessionByUser(env.DB, pending.user_id);
        const title = session?.title ?? 'unknown';
        const slug = session ? slugify(session.title) : 'unknown';

        const previewText = buildPreviewLines(title, slug, summary, set);
        const kb = buildPreviewKeyboard(pendingId, summary, set);

        await ctx.answerCallbackQuery({
          text: set.has(section) ? `✅ ${section} on` : `⬜ ${section} off`,
        });

        await ctx
          .editMessageText(previewText, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: kb,
          })
          .catch(() => {});
      } catch (err: any) {
        console.error('[Publish] toggle error:', err);
        await ctx
          .answerCallbackQuery({ text: '❌ Gagal toggle' })
          .catch(() => {});
      }
    }
  );

  bot.callbackQuery(/^pp:push:(pp_[a-z0-9]+)$/, async (ctx) => {
    try {
      const pendingId = ctx.match[1] ?? '';
      if (!pendingId) {
        await ctx.answerCallbackQuery({ text: '❌' });
        return;
      }

      const pending = await getPendingPublish(env.DB, pendingId);
      if (!pending) {
        await ctx.answerCallbackQuery({
          text: '⏱️ Kadaluarsa. Ulangi /publish.',
          show_alert: true,
        });
        return;
      }

      if (ctx.from?.id !== pending.user_id) {
        await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
        return;
      }

      let selected: SectionKey[] = [];
      try {
        if (pending.selected_json) {
          selected = JSON.parse(pending.selected_json) as SectionKey[];
        }
      } catch {
        selected = [];
      }

      if (selected.length === 0) {
        await ctx.answerCallbackQuery({
          text: '❌ Tidak ada section dipilih.',
          show_alert: true,
        });
        return;
      }

      await ctx.answerCallbackQuery({ text: '📤 Pushing...' });

      let allFiles: FileToCommit[] = [];
      try {
        allFiles = JSON.parse(pending.files_json) as FileToCommit[];
      } catch {
        allFiles = [];
      }

      const selectedSet = new Set(selected);
      const files = allFiles.filter((f) =>
        selectedSet.has(sectionFromPath(f.path))
      );

      if (files.length === 0) {
        await ctx.reply('❌ Tidak ada file untuk di-push.').catch(() => {});
        return;
      }

      const slug =
        files
          .map(
            (f) =>
              f.path.match(/^data\/anime\/([^/]+)\//)?.[1] ??
              f.path.match(/^src\/content\/anime\/(.+)\.md$/)?.[1]
          )
          .find((s): s is string => !!s) ?? 'unknown';

      const message = `feat: publish data for ${slug}`;

      const groups = new Map<RepoTarget, FileToCommit[]>();
      for (const f of files) {
        const target = f.target ?? 'qimochi';
        if (!groups.has(target)) groups.set(target, []);
        groups.get(target)!.push(f);
      }

      const results: {
        target: RepoTarget;
        ok: boolean;
        sha?: string;
        count: number;
        error?: string;
      }[] = [];

      for (const [target, groupFiles] of groups) {
        let r: {
          ok: boolean;
          sha?: string;
          commitUrl?: string;
          error?: string;
        };

        if (groupFiles.length === 1) {
          const f = groupFiles[0]!;
          r = await githubCommitFile(env, f.path, f.content, message, target);
        } else {
          r = await githubCommitMultipleFiles(env, groupFiles, message, target);
        }

        results.push({
          target,
          ok: r.ok,
          sha: r.sha,
          count: groupFiles.length,
          error: r.error,
        });
      }

      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;

      if (okCount === 0) {
        const errLines: string[] = ['❌ <b>Gagal push semua</b>', ''];
        for (const r of results) {
          errLines.push(
            `• <b>${r.target}</b>: <code>${escapeHtml((r.error ?? 'unknown').slice(0, 200))}</code>`
          );
        }
        await ctx
          .editMessageText(errLines.join('\n'), {
            parse_mode: 'HTML',
            reply_markup: undefined,
          })
          .catch(() => {});
        return;
      }

      if (failCount === 0) {
        await deletePendingPublish(env.DB, pendingId);
      }

      const lines: string[] = [];
      lines.push(
        failCount === 0
          ? `✅ <b>Published!</b>`
          : `⚠️ <b>Publish sebagian</b> (${okCount}/${results.length})`
      );
      lines.push('');

      for (const r of results) {
        const status = r.ok ? '✅' : '❌';
        const short = r.sha?.slice(0, 7) ?? '?';
        lines.push(
          `${status} <b>${r.target}</b> — ${r.count} file` +
            (r.ok
              ? ` · <code>${short}</code>`
              : ` · <i>${escapeHtml((r.error ?? 'unknown').slice(0, 100))}</i>`)
        );
      }

      if (failCount === 0) {
        lines.push('');
        lines.push(`⏳ Deploy ~2 menit`);
      } else {
        lines.push('');
        lines.push(
          `<i>Yang sukses tidak di-rollback. Ulangi /publish untuk retry yang gagal.</i>`
        );
      }

      await ctx
        .editMessageText(lines.join('\n'), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: undefined,
        })
        .catch(() => {});
    } catch (err: any) {
      console.error('[Publish] push error:', err);
      await ctx
        .reply(
          `❌ <b>Error:</b> <code>${escapeHtml((err?.message ?? 'unknown').slice(0, 300))}</code>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^pp:cancel:(pp_[a-z0-9]+)$/, async (ctx) => {
    const pendingId = ctx.match[1] ?? '';
    if (pendingId) await deletePendingPublish(env.DB, pendingId);
    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
    await ctx
      .editMessageText('❌ <b>Dibatalkan.</b>', {
        parse_mode: 'HTML',
        reply_markup: undefined,
      })
      .catch(() => {});
  });
}