import type { Env } from '../types/env';
import { getInstallationToken } from './github-app';

const API_BASE = 'https://api.github.com';

export type RepoTarget = 'yukio-data';

const BLOB_BATCH_SIZE = 20;

export interface FileToCommit {
  path: string;
  content: string | null;
  itemCount?: number;
}

export interface CommitResult {
  ok: boolean;
  sha?: string;
  commitUrl?: string;
  error?: string;
  backupErrors?: { repo: string; error: string }[];
}

export interface GithubFile {
  path: string;
  sha: string;
  content: string;
}

interface RepoRef {
  repo: string;
  branch: string;
  isPrimary: boolean;
}

function getTargets(env: Env): RepoRef[] {
  const primaryRepo = env.YUKIO_DATA_REPO?.trim();
  const primaryBranch = env.YUKIO_DATA_BRANCH?.trim();
  if (!primaryRepo || !primaryBranch) {
    throw new Error('YUKIO_DATA_REPO / YUKIO_DATA_BRANCH tidak di-set');
  }

  const targets: RepoRef[] = [
    { repo: primaryRepo, branch: primaryBranch, isPrimary: true },
  ];

  const backupRepo = env.YUKIO_BACKUP_REPO?.trim();
  const backupBranch = env.YUKIO_BACKUP_BRANCH?.trim();
  if (backupRepo && backupBranch && backupRepo !== primaryRepo) {
    targets.push({ repo: backupRepo, branch: backupBranch, isPrimary: false });
  }

  return targets;
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
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function b64Decode(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function githubGetFile(
  env: Env,
  path: string
): Promise<GithubFile | null> {
  const headers = await buildHeaders(env);
  const repo = env.YUKIO_DATA_REPO;
  const branch = env.YUKIO_DATA_BRANCH;
  const url = `${API_BASE}/repos/${repo}/contents/${path}?ref=${branch}`;
  const res = await fetch(url, { headers });

  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(
      `GitHub GET ${repo}/${path} → HTTP ${res.status}: ${err.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as {
    path: string;
    sha: string;
    content: string;
  };
  return { path: data.path, sha: data.sha, content: b64Decode(data.content) };
}

export async function githubListDir(
  env: Env,
  path: string
): Promise<{ name: string; path: string; type: 'file' | 'dir'; sha: string }[]> {
  const headers = await buildHeaders(env);
  const repo = env.YUKIO_DATA_REPO;
  const branch = env.YUKIO_DATA_BRANCH;
  const url = `${API_BASE}/repos/${repo}/contents/${path}?ref=${branch}`;
  const res = await fetch(url, { headers });

  if (res.status === 404) return [];
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(
      `GitHub LIST ${repo}/${path} → HTTP ${res.status}: ${err.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as
    | { name: string; path: string; type: string; sha: string }[]
    | { name: string; path: string; type: string; sha: string };
  if (!Array.isArray(data)) return [];
  return data.map((d) => ({
    name: d.name,
    path: d.path,
    type: d.type as 'file' | 'dir',
    sha: d.sha,
  }));
}

type RepoOpResult =
  | { ok: true; sha?: string; commitUrl?: string }
  | { ok: false; error: string };

async function getFileShaInRepo(
  env: Env,
  repo: string,
  branch: string,
  path: string
): Promise<string | undefined> {
  try {
    const headers = await buildHeaders(env);
    const url = `${API_BASE}/repos/${repo}/contents/${path}?ref=${branch}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { sha: string };
    return data.sha;
  } catch {
    return undefined;
  }
}

async function commitToRepo(
  env: Env,
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string
): Promise<RepoOpResult> {
  const headers = await buildHeaders(env);
  const sha = await getFileShaInRepo(env, repo, branch, path);

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
    commit?: { sha: string; html_url: string };
  };
  return { ok: true, sha: data.commit?.sha, commitUrl: data.commit?.html_url };
}

async function deleteFromRepo(
  env: Env,
  repo: string,
  branch: string,
  path: string,
  message: string
): Promise<RepoOpResult> {
  const headers = await buildHeaders(env);
  const sha = await getFileShaInRepo(env, repo, branch, path);
  if (!sha) return { ok: true };

  const url = `${API_BASE}/repos/${repo}/contents/${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha, branch }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${err.slice(0, 300)}` };
  }

  const data = (await res.json()) as {
    commit?: { sha: string; html_url: string };
  };
  return { ok: true, sha: data.commit?.sha, commitUrl: data.commit?.html_url };
}

interface TreeEntry {
  path: string;
  mode: '100644';
  type: 'blob';
  sha: string | null;
}

interface CommitInfo {
  commitSha: string;
  treeSha: string;
}

async function getBranchHead(
  env: Env,
  repo: string,
  branch: string
): Promise<CommitInfo | null> {
  try {
    const headers = await buildHeaders(env);
    const url = `${API_BASE}/repos/${repo}/commits/${branch}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      sha?: string;
      commit?: { tree?: { sha?: string } };
    };
    const commitSha = data.sha;
    const treeSha = data.commit?.tree?.sha;
    if (!commitSha || !treeSha) return null;
    return { commitSha, treeSha };
  } catch {
    return null;
  }
}

async function createBlob(
  env: Env,
  repo: string,
  content: string
): Promise<string | null> {
  try {
    const headers = await buildHeaders(env);
    const url = `${API_BASE}/repos/${repo}/git/blobs`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, encoding: 'utf-8' }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { sha?: string };
    return data.sha ?? null;
  } catch {
    return null;
  }
}

async function createTree(
  env: Env,
  repo: string,
  baseTreeSha: string,
  entries: TreeEntry[]
): Promise<string | null> {
  try {
    const headers = await buildHeaders(env);
    const url = `${API_BASE}/repos/${repo}/git/trees`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_tree: baseTreeSha, tree: entries }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { sha?: string };
    return data.sha ?? null;
  } catch {
    return null;
  }
}

/**
 * Buat commit dengan tree + parent.
 */
async function createCommit(
  env: Env,
  repo: string,
  message: string,
  treeSha: string,
  parentSha: string
): Promise<string | null> {
  try {
    const headers = await buildHeaders(env);
    const url = `${API_BASE}/repos/${repo}/git/commits`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        tree: treeSha,
        parents: [parentSha],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { sha?: string };
    return data.sha ?? null;
  } catch {
    return null;
  }
}

async function updateRef(
  env: Env,
  repo: string,
  branch: string,
  commitSha: string
): Promise<boolean> {
  try {
    const headers = await buildHeaders(env);
    const url = `${API_BASE}/repos/${repo}/git/refs/heads/${branch}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: commitSha, force: false }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function treeCommitToRepo(
  env: Env,
  repo: string,
  branch: string,
  files: FileToCommit[],
  message: string
): Promise<RepoOpResult> {
  if (files.length === 0) return { ok: false, error: 'No files' };

  const upserts = files.filter((f) => f.content !== null);
  const deletes = files.filter((f) => f.content === null);

  const blobsByPath = new Map<string, string>();
  const batches = chunkArray(upserts, BLOB_BATCH_SIZE);

  for (const batch of batches) {
    const results = await Promise.all(
      batch.map(async (f) => ({
        path: f.path,
        sha: await createBlob(env, repo, f.content!),
      }))
    );
    for (const r of results) {
      if (!r.sha) {
        return { ok: false, error: `Blob create gagal untuk ${r.path}` };
      }
      blobsByPath.set(r.path, r.sha);
    }
    if (batches.length > 1) await sleep(100);
  }
  
  const entries: TreeEntry[] = [];

  for (const [path, sha] of blobsByPath) {
    entries.push({ path, mode: '100644', type: 'blob', sha });
  }
  for (const d of deletes) {
    entries.push({ path: d.path, mode: '100644', type: 'blob', sha: null });
  }

  const head = await getBranchHead(env, repo, branch);
  if (!head) return { ok: false, error: 'Gagal ambil branch head' };

  const newTreeSha = await createTree(env, repo, head.treeSha, entries);
  if (!newTreeSha) return { ok: false, error: 'Gagal buat tree' };

  const newCommitSha = await createCommit(
    env,
    repo,
    message,
    newTreeSha,
    head.commitSha
  );
  if (!newCommitSha) return { ok: false, error: 'Gagal buat commit' };

  const refOk = await updateRef(env, repo, branch, newCommitSha);
  if (!refOk) return { ok: false, error: 'Gagal update ref' };

  return {
    ok: true,
    sha: newCommitSha,
    commitUrl: `https://github.com/${repo}/commit/${newCommitSha}`,
  };
}

async function opToAllTargets(
  env: Env,
  path: string,
  content: string | null,
  message: string,
  targets: RepoRef[]
): Promise<CommitResult> {
  const primary = targets[0]!;
  const primaryResult =
    content === null
      ? await deleteFromRepo(env, primary.repo, primary.branch, path, message)
      : await commitToRepo(env, primary.repo, primary.branch, path, content, message);

  if (!primaryResult.ok) {
    return {
      ok: false,
      error: `[${primary.repo}] ${primaryResult.error}`,
    };
  }

  const backupErrors: { repo: string; error: string }[] = [];
  for (let i = 1; i < targets.length; i++) {
    const t = targets[i]!;
    await sleep(150);
    try {
      const r =
        content === null
          ? await deleteFromRepo(env, t.repo, t.branch, path, message)
          : await commitToRepo(env, t.repo, t.branch, path, content, message);
      if (!r.ok) backupErrors.push({ repo: t.repo, error: r.error });
    } catch (err) {
      backupErrors.push({
        repo: t.repo,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  return {
    ok: true,
    sha: primaryResult.sha,
    commitUrl: primaryResult.commitUrl,
    backupErrors: backupErrors.length > 0 ? backupErrors : undefined,
  };
}

export async function githubCommitFile(
  env: Env,
  path: string,
  content: string,
  message: string
): Promise<CommitResult> {
  const targets = getTargets(env);
  return opToAllTargets(env, path, content, message, targets);
}

export async function githubDeleteFile(
  env: Env,
  path: string,
  message: string
): Promise<CommitResult> {
  const targets = getTargets(env);
  return opToAllTargets(env, path, null, message, targets);
}

export async function githubCommitMultipleFiles(
  env: Env,
  files: FileToCommit[],
  message: string
): Promise<CommitResult> {
  if (files.length === 0) return { ok: false, error: 'No files to commit' };

  const targets = getTargets(env);
  const primary = targets[0]!;

  const primaryResult = await treeCommitToRepo(
    env,
    primary.repo,
    primary.branch,
    files,
    message
  );

  if (!primaryResult.ok) {
    return {
      ok: false,
      error: `[${primary.repo}] ${primaryResult.error}`,
    };
  }

  const backupErrors: { repo: string; error: string }[] = [];

  for (let i = 1; i < targets.length; i++) {
    const t = targets[i]!;
    try {
      const r = await treeCommitToRepo(
        env,
        t.repo,
        t.branch,
        files,
        message
      );
      if (!r.ok) backupErrors.push({ repo: t.repo, error: r.error });
    } catch (err) {
      backupErrors.push({
        repo: t.repo,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  return {
    ok: true,
    sha: primaryResult.sha,
    commitUrl: primaryResult.commitUrl,
    backupErrors: backupErrors.length > 0 ? backupErrors : undefined,
  };
}

export function getRepoLabel(env: Env): string {
  const primary = env.YUKIO_DATA_REPO?.split('/')[1] ?? 'data-repo';
  const backup = env.YUKIO_BACKUP_REPO?.trim().split('/')[1] ?? '';
  return backup ? `${primary} + ${backup}` : primary;
}
