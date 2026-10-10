// src/lib/cms-cache.ts
import type { Env } from '../types/env';
import { getCache, setCache } from './cache';
import { getInstallationToken } from './github-app';

const TREE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_KEY = 'cms:index';

interface TreeNode {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
}

interface TreeResponse {
  tree: TreeNode[];
  truncated: boolean;
}

export interface AnimeFolderInfo {
  characters: boolean;
  episodes: boolean;
  episodeStreams: boolean;
  franchises: boolean;
}

export interface CmsIndex {
  animeSlugs: string[];
  animeFolders: Record<string, AnimeFolderInfo>;
  actorLetters: string[];
  syncedAt: number;
}

async function fetchTree(env: Env): Promise<TreeResponse> {
  const token = await getInstallationToken(env);
  const [owner, repo] = env.YUKIO_DATA_REPO.split('/');
  const branch = env.YUKIO_DATA_BRANCH;

  if (!owner || !repo) {
    throw new Error(`YUKIO_DATA_REPO invalid: ${env.YUKIO_DATA_REPO}`);
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'yukio-bot/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`GitHub TREE HTTP ${res.status}: ${err.slice(0, 200)}`);
  }

  const json = (await res.json()) as TreeResponse;
  if (json.truncated) {
    console.warn('[CmsCache] tree truncated! Beberapa file mungkin hilang.');
  }
  return json;
}

function buildIndex(tree: TreeNode[]): CmsIndex {
  const animeSlugs: string[] = [];
  const animeFolders: Record<string, AnimeFolderInfo> = {};
  const actorLetters: string[] = [];

  for (const node of tree) {
    const mdMatch = node.path.match(/^src\/content\/anime\/(.+)\.md$/);
    if (mdMatch && node.type === 'blob' && mdMatch[1]) {
      animeSlugs.push(mdMatch[1]);
      continue;
    }

    const dataMatch = node.path.match(/^data\/anime\/([^/]+)\/(.+)/);
    if (dataMatch && dataMatch[1] && dataMatch[2]) {
      const slug = dataMatch[1];
      const sub = dataMatch[2];

      if (!animeFolders[slug]) {
        animeFolders[slug] = {
          characters: false,
          episodes: false,
          episodeStreams: false,
          franchises: false,
        };
      }

      if (sub.startsWith('characters/')) animeFolders[slug].characters = true;
      else if (sub === 'franchises.json') animeFolders[slug].franchises = true;
      else if (sub.startsWith('episodes/streams/'))
        animeFolders[slug].episodeStreams = true;
      else if (sub.startsWith('episodes/')) animeFolders[slug].episodes = true;
      continue;
    }

    const actorMatch = node.path.match(/^data\/actors\/([a-z_])\.json$/);
    if (actorMatch && actorMatch[1]) {
      actorLetters.push(actorMatch[1]);
    }
  }

  animeSlugs.sort();

  return {
    animeSlugs,
    animeFolders,
    actorLetters: actorLetters.sort(),
    syncedAt: Date.now(),
  };
}

export async function getCmsIndex(
  env: Env,
  force = false
): Promise<{ index: CmsIndex; fromCache: boolean }> {
  if (!force) {
    const cached = await getCache<CmsIndex>(env.DB, CACHE_KEY);
    if (cached) return { index: cached, fromCache: true };
  }

  const tree = await fetchTree(env);
  const index = buildIndex(tree.tree);
  await setCache(env.DB, CACHE_KEY, index, TREE_TTL_MS);
  return { index, fromCache: false };
}
