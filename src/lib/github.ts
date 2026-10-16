import type { Env } from '../types/env';
import { getInstallationToken } from './github-app';

const API_BASE = 'https://api.github.com';

export type RepoTarget = 'yukio-data';

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

type RepoOpResult =
  | { ok: true; sha?: string; commitUrl?: string }
  | { ok: false; error: string };

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

async function opToAllTargets(
  env: Env,
  path: string,
  content: string | null,
  message: string,
  targets: RepoRef[]
): Promise<CommitResult> {
  const primary = targets[0]!;
  const primaryResult = content === null
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
      const r = content === null
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
  const backupErrors: { repo: string; error: string }[] = [];
  let lastSha: string | undefined;
  let lastUrl: string | undefined;

  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (i > 0) await sleep(400);

    const result = await opToAllTargets(env, f.path, f.content, message, targets);

    if (!result.ok) {
      return {
        ok: false,
        error: `File ${i + 1}/${files.length} (${f.path}) gagal: ${result.error ?? 'unknown'}`,
        backupErrors: backupErrors.length > 0 ? backupErrors : undefined,
      };
    }

    if (result.sha) lastSha = result.sha;
    if (result.commitUrl) lastUrl = result.commitUrl;
    if (result.backupErrors) backupErrors.push(...result.backupErrors);
  }

  return {
    ok: true,
    sha: lastSha,
    commitUrl: lastUrl,
    backupErrors: backupErrors.length > 0 ? backupErrors : undefined,
  };
}

export function getRepoLabel(env: Env): string {
  const primary = env.YUKIO_DATA_REPO?.split('/')[1] ?? 'data-repo';
  const backup = env.YUKIO_BACKUP_REPO?.trim().split('/')[1] ?? '';
  return backup ? `${primary} + ${backup}` : primary;
}
