// src/lib/cron/runner.ts
import type { Env } from '../../types/env';
import type { EpisodeObject } from '../../types/anime';
import {
  githubCommitMultipleFiles,
  githubCommitFile,
  githubGetFile,
  type FileToCommit,
} from '../github';
import {
  listTrackedAnime,
  getTrackedAnime,
  updateTrackedChunkState,
  markEpisodePublished,
  isEpisodePublished,
  setLastCheckAt,
  writeCronLog,
  isInScheduleWindow,
  type SiteKey,
  type TrackedAnimeRow,
} from './state';
import { fetchLatestEpisodeNumber, fetchEpisode } from './fetcher';

const MAX_ANIME_PER_RUN = 5;

function chunkPath(slug: string, start: number, end: number): string {
  return `data/anime/${slug}/episodes/streams/${start}-${end}.json`;
}

interface ChunkResult {
  newPath: string;
  oldPath: string | null;
  newContent: string;
}

async function buildNewChunk(
  env: Env,
  slug: string,
  newEpisode: EpisodeObject,
  currentChunkStart: number,
  currentChunkEnd: number
): Promise<ChunkResult | null> {
  const currentCount =
    currentChunkStart === 0 ? 0 : currentChunkEnd - currentChunkStart + 1;
  const isNewChunk = currentCount >= 6 || currentChunkStart === 0;

  const newChunkStart = isNewChunk ? newEpisode.number : currentChunkStart;
  const newChunkEnd = newEpisode.number;

  const oldPath = isNewChunk
    ? null
    : chunkPath(slug, currentChunkStart, currentChunkEnd);
  const newPath = chunkPath(slug, newChunkStart, newChunkEnd);

  let existing: EpisodeObject[] = [];
  if (!isNewChunk && oldPath) {
    try {
      const file = await githubGetFile(env, oldPath, 'yukio-data');
      if (file) {
        const parsed = JSON.parse(file.content);
        if (Array.isArray(parsed)) existing = parsed as EpisodeObject[];
      }
    } catch (err) {
      console.warn('[Runner] fetch old stream chunk failed:', err);
      return null;
    }
  }

  const merged = [...existing, newEpisode].sort((a, b) => a.number - b.number);

  return {
    newPath,
    oldPath,
    newContent: JSON.stringify(merged, null, 2) + '\n',
  };
}

async function updateYukioDataMd(
  env: Env,
  slug: string
): Promise<{ path: string; content: string; target: 'yukio-data' } | null> {
  const mdPath = `src/content/anime/${slug}.md`;

  try {
    const mdFile = await githubGetFile(env, mdPath, 'yukio-data');
    if (!mdFile) {
      console.warn(`[Runner] MD tidak ditemukan: ${mdPath}`);
      return null;
    }

    const today = new Date().toISOString().split('T')[0] ?? '2026-01-01';
    let mdContent = mdFile.content;

    const fmMatch = mdContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!fmMatch) {
      console.warn(`[Runner] MD frontmatter invalid: ${mdPath}`);
      return null;
    }

    const [, frontmatter, body] = fmMatch;
    let fm = frontmatter ?? '';
    const bd = body ?? '';

    if (/^updatedAt:\s*.+$/m.test(fm)) {
      fm = fm.replace(/^updatedAt:\s*.+$/m, `updatedAt: "${today}"`);
    } else if (/^addedAt:\s*.+$/m.test(fm)) {
      fm = fm.replace(/^(addedAt:\s*.+)$/m, `$1\nupdatedAt: "${today}"`);
    } else {
      fm = fm.trimEnd() + `\naddedAt: "${today}"\nupdatedAt: "${today}"`;
    }

    mdContent = `---\n${fm}\n---\n${bd.startsWith('\n') ? '' : '\n'}${bd}`;

    console.log(`[Runner] MD updated: ${mdPath} → ${today}`);
    return { path: mdPath, content: mdContent, target: 'yukio-data' };
  } catch (err) {
    console.warn(`[Runner] updateYukioDataMd failed for ${slug}:`, err);
    return null;
  }
}

interface ProcessResult {
  pushed: number;
  error: string | null;
}

async function processOneAnime(
  env: Env,
  row: TrackedAnimeRow
): Promise<ProcessResult> {
  const { slug, site, source_slug, fallback_site } = row;

  let latestEp = await fetchLatestEpisodeNumber(env, site, source_slug);
  let usedSite: SiteKey = site;

  if (latestEp === null && fallback_site) {
    latestEp = await fetchLatestEpisodeNumber(env, fallback_site, source_slug);
    if (latestEp !== null) usedSite = fallback_site;
  }

  if (latestEp === null) {
    return { pushed: 0, error: `Semua site gagal cek latest ep untuk ${slug}` };
  }

  if (latestEp <= row.last_ep) {
    await setLastCheckAt(env.DB, slug);
    return { pushed: 0, error: null };
  }

  let pushed = 0;
  let lastError: string | null = null;

  const fresh = await getTrackedAnime(env.DB, slug);
  if (!fresh) return { pushed: 0, error: `Tracked anime hilang: ${slug}` };

  let currentChunkStart = fresh.chunk_start;
  let currentChunkEnd = fresh.chunk_end;

  for (let ep = fresh.last_ep + 1; ep <= latestEp; ep++) {
    const already = await isEpisodePublished(env.DB, slug, ep);
    if (already) continue;

    let episode = await fetchEpisode(env, usedSite, source_slug, ep);
    if (!episode && usedSite !== (fallback_site ?? site)) {
      episode = await fetchEpisode(env, fallback_site as SiteKey, source_slug, ep);
      if (episode) usedSite = fallback_site as SiteKey;
    }

    if (!episode) {
      lastError = `Ep ${ep} tidak bisa di-fetch dari semua site`;
      break;
    }

    const chunk = await buildNewChunk(
      env,
      slug,
      episode,
      currentChunkStart,
      currentChunkEnd
    );

    if (!chunk) {
      lastError = `Gagal build chunk untuk ep ${ep}`;
      break;
    }

    const chunkFiles: FileToCommit[] = [
      { path: chunk.newPath, content: chunk.newContent, target: 'yukio-data' },
    ];
    if (chunk.oldPath) {
      chunkFiles.push({
        path: chunk.oldPath,
        content: null,
        target: 'yukio-data',
      });
    }

    const chunkCommit = await githubCommitMultipleFiles(
      env,
      chunkFiles,
      `feat(streams): add ep ${ep} for ${slug}`,
      'yukio-data'
    );

    if (!chunkCommit.ok) {
      lastError = `Commit streams gagal untuk ep ${ep}: ${chunkCommit.error ?? 'unknown'}`;
      break;
    }

    const mdFile = await updateYukioDataMd(env, slug);
    if (mdFile) {
      const mdCommit = await githubCommitFile(
        env,
        mdFile.path,
        mdFile.content,
        `chore: bump updatedAt for ${slug} (ep ${ep})`,
        'yukio-data'
      );
      if (!mdCommit.ok) {
        console.warn(`[Runner] MD commit gagal untuk ep ${ep}: ${mdCommit.error}`);
      }
    }

    const { chunkStart, chunkEnd } = await updateTrackedChunkState(env.DB, slug, ep);
    await markEpisodePublished(env.DB, slug, ep, usedSite, chunkCommit.sha ?? null);

    currentChunkStart = chunkStart;
    currentChunkEnd = chunkEnd;
    pushed++;
  }

  if (!lastError) await setLastCheckAt(env.DB, slug);
  return { pushed, error: lastError };
}

export interface CronRunResult {
  animeChecked: number;
  episodesFound: number;
  episodesPushed: number;
  errors: string[];
}

export async function runCron(env: Env): Promise<CronRunResult> {
  const t0 = Date.now();
  const all = await listTrackedAnime(env.DB);

  const inWindow = all.filter(isInScheduleWindow);
  const batch = inWindow.slice(0, MAX_ANIME_PER_RUN);

  console.log(
    `[Cron] ${all.length} tracked, ${inWindow.length} in window, ${batch.length} in batch`
  );

  const errors: string[] = [];
  let episodesPushed = 0;
  let episodesFound = 0;
  let checked = 0;

  for (const row of batch) {
    checked++;
    try {
      const result = await processOneAnime(env, row);
      episodesPushed += result.pushed;
      episodesFound += result.pushed;
      if (result.error) errors.push(`[${row.slug}] ${result.error}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown';
      console.error(`[Cron] ${row.slug} error:`, msg);
      errors.push(`[${row.slug}] ${msg}`);
    }
  }

  const elapsed = Date.now() - t0;
  console.log(
    `[Cron] done in ${elapsed}ms — checked ${checked}, pushed ${episodesPushed}`
  );

  await writeCronLog(env.DB, {
    animeChecked: checked,
    episodesFound,
    episodesPushed,
    errors,
  });

  return { animeChecked: checked, episodesFound, episodesPushed, errors };
}

export async function runManualCheck(
  env: Env,
  slug: string
): Promise<CronRunResult> {
  const row = await getTrackedAnime(env.DB, slug);
  if (!row) {
    return {
      animeChecked: 0,
      episodesFound: 0,
      episodesPushed: 0,
      errors: [`Tracked anime tidak ditemukan: ${slug}`],
    };
  }

  if (row.status !== 'active') {
    return {
      animeChecked: 1,
      episodesFound: 0,
      episodesPushed: 0,
      errors: [`Anime dalam status ${row.status}`],
    };
  }

  const result = await processOneAnime(env, row);

  return {
    animeChecked: 1,
    episodesFound: result.pushed,
    episodesPushed: result.pushed,
    errors: result.error ? [result.error] : [],
  };
}
