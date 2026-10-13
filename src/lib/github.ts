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
  const url = `${API_BASE}/repos/${env.YUKIO_DATA_REPO}/contents/${path}?ref=${env.YUKIO_DATA_BRANCH}`;
  const res = await fetch(url, { headers });

  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`GitHub GET ${path} → HTTP ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = (await res.json()) as { path: string; sha: string; content: string };
  return { path: data.path, sha: data.sha, content: b64Decode(data.content) };
}

export async function githubCommitFile(
  env: Env,
  path: string,
  content: string,
  message: string
): Promise<CommitResult> {
  const headers = await buildHeaders(env);

  let sha: string | undefined;
  try {
    const existing = await githubGetFile(env, path);
    if (existing) sha = existing.sha;
  } catch {}

  const body: Record<string, unknown> = {
    message,
    content: b64Encode(content),
    branch: env.YUKIO_DATA_BRANCH,
  };
  if (sha) body.sha = sha;

  const url = `${API_BASE}/repos/${env.YUKIO_DATA_REPO}/contents/${path}`;
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

export async function githubDeleteFile(
  env: Env,
  path: string,
  message: string
): Promise<CommitResult> {
  const headers = await buildHeaders(env);

  let existing: GithubFile | null = null;
  try {
    existing = await githubGetFile(env, path);
  } catch (err) {
    return { ok: false, error: `Get file before delete: ${(err as Error).message}` };
  }

  if (!existing) return { ok: true };

  const url = `${API_BASE}/repos/${env.YUKIO_DATA_REPO}/contents/${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      sha: existing.sha,
      branch: env.YUKIO_DATA_BRANCH,
    }),
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

export async function githubCommitMultipleFiles(
  env: Env,
  files: FileToCommit[],
  message: string
): Promise<CommitResult> {
  if (files.length === 0) return { ok: false, error: 'No files to commit' };

  let lastSha: string | undefined;
  let lastUrl: string | undefined;

  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (i > 0) await sleep(400);

    const result =
      f.content === null
        ? await githubDeleteFile(env, f.path, message)
        : await githubCommitFile(env, f.path, f.content, message);

    if (!result.ok) {
      return {
        ok: false,
        error: `File ${i + 1}/${files.length} (${f.path}) gagal: ${result.error ?? 'unknown'}`,
      };
    }
    if (result.sha) lastSha = result.sha;
    if (result.commitUrl) lastUrl = result.commitUrl;
  }

  return { ok: true, sha: lastSha, commitUrl: lastUrl };
}

export async function githubListDir(
  env: Env,
  path: string
): Promise<{ name: string; path: string; type: 'file' | 'dir'; sha: string }[]> {
  const headers = await buildHeaders(env);
  const url = `${API_BASE}/repos/${env.YUKIO_DATA_REPO}/contents/${path}?ref=${env.YUKIO_DATA_BRANCH}`;
  const res = await fetch(url, { headers });

  if (res.status === 404) return [];
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`GitHub LIST ${path} → HTTP ${res.status}: ${err.slice(0, 200)}`);
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