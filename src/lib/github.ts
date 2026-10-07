// src/lib/github.ts
import type { Env } from '../types/env';
import { getInstallationToken } from './github-app';

const API_BASE = 'https://api.github.com';

export type RepoTarget = 'qimochi' | 'yukionime' | 'yukio-data';

export interface RepoConfig {
  repo: string;
  branch: string;
}

export function resolveRepo(
  env: Env,
  target: RepoTarget = 'qimochi'
): RepoConfig {
  switch (target) {
    case 'yukionime':
      return { repo: env.YUKIONIME_REPO, branch: env.YUKIONIME_BRANCH };
    case 'yukio-data':
      return { repo: env.YUKIO_DATA_REPO, branch: env.YUKIO_DATA_BRANCH };
    case 'qimochi':
    default:
      return { repo: env.GITHUB_REPO, branch: env.GITHUB_BRANCH };
  }
}

interface GithubFileResponse {
  sha: string;
  content: string;
  encoding: string;
  path: string;
}

interface GithubListItem {
  name: string;
  path: string;
  sha: string;
  type: 'file' | 'dir';
}

interface GitRefResponse {
  object: { sha: string; type: string; url: string };
  ref: string;
  url: string;
}

interface GitCommitResponse {
  sha: string;
  tree: { sha: string; url: string };
  message: string;
  parents: { sha: string; url: string }[];
  url: string;
}

interface GitBlobResponse {
  sha: string;
  url: string;
}

interface GitTreeResponse {
  sha: string;
  url: string;
  truncated: boolean;
}

export interface FileToCommit {
  path: string;
  content: string;
  target?: RepoTarget;
  itemCount?: number;
}

export interface CommitResult {
  ok: boolean;
  sha?: string;
  commitUrl?: string;
  error?: string;
}

export interface MultiCommitResult extends CommitResult {
  filesCount?: number;
}

export interface GithubFile {
  path: string;
  sha: string;
  content: string;
}

async function buildHeaders(env: Env): Promise<Record<string, string>> {
  const token = await getInstallationToken(env);
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'yukio-bot/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function b64Encode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

function b64Decode(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

export async function githubGetFile(
  env: Env,
  path: string,
  target: RepoTarget = 'qimochi'
): Promise<GithubFile | null> {
  const { repo, branch } = resolveRepo(env, target);
  const headers = await buildHeaders(env);

  const url = `${API_BASE}/repos/${repo}/contents/${path}?ref=${branch}`;
  const res = await fetch(url, { headers });

  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(
      `GitHub GET ${repo}/${path} → HTTP ${res.status}: ${err.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as GithubFileResponse;
  return {
    path: data.path,
    sha: data.sha,
    content: b64Decode(data.content),
  };
}

export async function githubCommitFile(
  env: Env,
  path: string,
  content: string,
  message: string,
  target: RepoTarget = 'qimochi'
): Promise<CommitResult> {
  const { repo, branch } = resolveRepo(env, target);
  const headers = await buildHeaders(env);

  let sha: string | undefined;
  try {
    const existing = await githubGetFile(env, path, target);
    if (existing) sha = existing.sha;
  } catch {}

  const body: Record<string, unknown> = {
    message,
    content: b64Encode(content),
    branch,
  };
  if (sha) body.sha = sha;

  const url = `${API_BASE}/repos/${repo}/contents/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${err.slice(0, 300)}` };
  }

  const data = (await res.json()) as {
    content?: { sha: string };
    commit?: { sha: string; html_url: string };
  };

  return {
    ok: true,
    sha: data.commit?.sha,
    commitUrl: data.commit?.html_url,
  };
}

export async function githubCommitMultipleFiles(
  env: Env,
  files: FileToCommit[],
  message: string,
  target: RepoTarget = 'qimochi'
): Promise<MultiCommitResult> {
  if (files.length === 0) {
    return { ok: false, error: 'No files to commit' };
  }

  const { repo, branch } = resolveRepo(env, target);
  const headers = await buildHeaders(env);
  const base = `${API_BASE}/repos/${repo}`;

  try {
    const refRes = await fetch(`${base}/git/ref/heads/${branch}`, { headers });
    if (!refRes.ok) {
      return { ok: false, error: `Get ref failed: HTTP ${refRes.status}` };
    }
    const refData = (await refRes.json()) as GitRefResponse;
    const parentCommitSha = refData.object.sha;

    const commitRes = await fetch(`${base}/git/commits/${parentCommitSha}`, {
      headers,
    });
    if (!commitRes.ok) {
      return { ok: false, error: `Get commit failed: HTTP ${commitRes.status}` };
    }
    const commitData = (await commitRes.json()) as GitCommitResponse;
    const baseTreeSha = commitData.tree.sha;

    const blobResults = await Promise.all(
      files.map(async (f) => {
        const res = await fetch(`${base}/git/blobs`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: b64Encode(f.content),
            encoding: 'base64',
          }),
        });
        if (!res.ok) {
          throw new Error(`Blob ${f.path} failed: HTTP ${res.status}`);
        }
        const data = (await res.json()) as GitBlobResponse;
        return { path: f.path, sha: data.sha };
      })
    );

    const treeRes = await fetch(`${base}/git/trees`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: blobResults.map((b) => ({
          path: b.path,
          mode: '100644',
          type: 'blob',
          sha: b.sha,
        })),
      }),
    });
    if (!treeRes.ok) {
      return { ok: false, error: `Create tree failed: HTTP ${treeRes.status}` };
    }
    const treeData = (await treeRes.json()) as GitTreeResponse;

    const newCommitRes = await fetch(`${base}/git/commits`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        tree: treeData.sha,
        parents: [parentCommitSha],
      }),
    });
    if (!newCommitRes.ok) {
      return {
        ok: false,
        error: `Create commit failed: HTTP ${newCommitRes.status}`,
      };
    }
    const newCommitData = (await newCommitRes.json()) as GitCommitResponse;

    const updateRes = await fetch(`${base}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommitData.sha, force: false }),
    });
    if (!updateRes.ok) {
      return { ok: false, error: `Update ref failed: HTTP ${updateRes.status}` };
    }

    return {
      ok: true,
      sha: newCommitData.sha,
      commitUrl: `https://github.com/${repo}/commit/${newCommitData.sha}`,
      filesCount: files.length,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? 'unknown' };
  }
}

export async function githubListDir(
  env: Env,
  path: string,
  target: RepoTarget = 'qimochi'
): Promise<GithubListItem[]> {
  const { repo, branch } = resolveRepo(env, target);
  const headers = await buildHeaders(env);

  const url = `${API_BASE}/repos/${repo}/contents/${path}?ref=${branch}`;
  const res = await fetch(url, { headers });

  if (res.status === 404) return [];
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(
      `GitHub LIST ${repo}/${path} → HTTP ${res.status}: ${err.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as GithubListItem[];
  return Array.isArray(data) ? data : [];
}
