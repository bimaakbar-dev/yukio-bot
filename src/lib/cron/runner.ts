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
  type TrackSite,
  type TrackedAnimeRow,
} from './state';
import {
  fetchLatestEpisodeNumber,
  fetchEpisode,
  fetchLatestEpisodeNumberCustom,
  fetchEpisodeCustom,
} from './fetcher';

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

  const oldPath = isNewChunk ? null : chunkPath(slug, currentChunkStart, currentChunkEnd);
  const newPath = chunkPath(slug, newChunkStart, newChunkEnd);

  let existing: EpisodeObject[] = [];
  if (!isNewChunk && oldPath) {
    try {
      const file = await githubGetFile(env, oldPath);
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
): Promise<{ path: string; content: string } | null> {
  const mdPath = `src/content/anime/${slug}.md`;

  try {
    const mdFile = await githubGetFile(env, mdPath);
    if (!mdFile) return null;

    const today = new Date().toISOString().split('T')[0] ?? '2026-01-01';
    let mdContent = mdFile.content;

    const fmMatch = mdContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!fmMatch) return null;

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

    return { path: mdPath, content: mdContent };
  } catch {
    return null;
  }
}

interface ProcessResult {
  pushed: number;
  error: string | null;
}

interface DetectResult {
  latest: number | null;
  usedSite: TrackSite;
}

async function detectLatest(
  env: Env,
  row: TrackedAnimeRow
): Promise<DetectResult> {
  if (row.site === 'custom') {
    const n = await fetchLatestEpisodeNumberCustom(env, row.custom_anime_url);
    return { latest: n, usedSite: 'custom' };
  }

  let latest = await fetchLatestEpisodeNumber(env, row.site, row.source_slug);
  let usedSite: TrackSite = row.site;

  if (latest === null && row.fallback_site) {
    latest = await fetchLatestEpisodeNumber(env, row.fallback_site, row.source_slug);
    if (latest !== null) usedSite = row.fallback_site;
  }

  return { latest, usedSite };
}

async function fetchEpisodeForRow(
  env: Env,
  row: TrackedAnimeRow,
  usedSite: TrackSite,
  epNumber: number
): Promise<EpisodeObject | null> {
  if (usedSite === 'custom') {
    if (!row.custom_episode_pattern) return null;
    return fetchEpisodeCustom(env, row.custom_episode_pattern, epNumber);
  }
  return fetchEpisode(env, usedSite as SiteKey, row.source_slug, epNumber);
}

async function processOneAnime(env: Env, row: TrackedAnimeRow): Promise<ProcessResult> {
  const { slug } = row;

  if (row.site === 'custom' && !row.custom_episode_pattern) {
    return { pushed: 0, error: `Custom site tanpa episode pattern untuk ${slug}` };
  }

  const { latest: latestEp, usedSite } = await detectLatest(env, row);

  if (latestEp === null) {
    return { pushed: 0, error: `Gagal cek latest ep untuk ${slug}` };
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

    let episode = await fetchEpisodeForRow(env, row, usedSite, ep);

    if (
      !episode &&
      usedSite !== 'custom' &&
      row.fallback_site &&
      usedSite !== row.fallback_site
    ) {
      episode = await fetchEpisode(env, row.fallback_site, row.source_slug, ep);
    }

    if (!episode) {
      lastError = `Ep ${ep} tidak bisa di-fetch`;
      break;
    }

    const chunk = await buildNewChunk(env, slug, episode, currentChunkStart, currentChunkEnd);
    if (!chunk) {
      lastError = `Gagal build chunk untuk ep ${ep}`;
      break;
    }

    const chunkFiles: FileToCommit[] = [
      { path: chunk.newPath, content: chunk.newContent },
    ];
    if (chunk.oldPath) {
      chunkFiles.push({ path: chunk.oldPath, content: null });
    }

    const chunkCommit = await githubCommitMultipleFiles(
      env,
      chunkFiles,
      `feat(streams): add ep ${ep} for ${slug}`
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
        `chore: bump updatedAt for ${slug} (ep ${ep})`
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
  const all = await listTrackedAnime(env.DB);

  const inWindow = all.filter(isInScheduleWindow);
  const batch = inWindow.slice(0, MAX_ANIME_PER_RUN);

  const errors: string[] = [];
  let episodesPushed = 0;
  let checked = 0;

  for (const row of batch) {
    checked++;
    try {
      const result = await processOneAnime(env, row);
      episodesPushed += result.pushed;
      if (result.error) errors.push(`[${row.slug}] ${result.error}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown';
      errors.push(`[${row.slug}] ${msg}`);
    }
  }

  await writeCronLog(env.DB, {
    animeChecked: checked,
    episodesFound: episodesPushed,
    episodesPushed,
    errors,
  });

  return { animeChecked: checked, episodesFound: episodesPushed, episodesPushed, errors };
}

export async function runManualCheck(env: Env, slug: string): Promise<CronRunResult> {
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
