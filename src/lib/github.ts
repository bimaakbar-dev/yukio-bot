// src/lib/github.ts
import type { Env } from '../types/env';

const API_BASE = 'https://api.github.com';

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

function buildHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.YUKIO_TOKEN}`,
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

export interface GithubFile {
  path: string;
  sha: string;
  content: string;
}

export async function githubGetFile(
  env: Env,
  path: string
): Promise<GithubFile | null> {
  const url = `${API_BASE}/repos/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: buildHeaders(env) });

  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(
      `GitHub GET ${path} → HTTP ${res.status}: ${err.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as GithubFileResponse;
  return {
    path: data.path,
    sha: data.sha,
    content: b64Decode(data.content),
  };
}

export interface CommitResult {
  ok: boolean;
  sha?: string;
  commitUrl?: string;
  error?: string;
}

export async function githubCommitFile(
  env: Env,
  path: string,
  content: string,
  message: string
): Promise<CommitResult> {
  const url = `${API_BASE}/repos/${env.GITHUB_REPO}/contents/${path}`;

  let sha: string | undefined;
  try {
    const existing = await githubGetFile(env, path);
    if (existing) sha = existing.sha;
  } catch {
    // treat as new file
  }

  const body: Record<string, unknown> = {
    message,
    content: b64Encode(content),
    branch: env.GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...buildHeaders(env), 'Content-Type': 'application/json' },
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

export async function githubListDir(
  env: Env,
  path: string
): Promise<GithubListItem[]> {
  const url = `${API_BASE}/repos/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: buildHeaders(env) });

  if (res.status === 404) return [];
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(
      `GitHub LIST ${path} → HTTP ${res.status}: ${err.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as GithubListItem[];
  return Array.isArray(data) ? data : [];
}