// src/lib/dba-common.ts
import type { AniListMedia } from '../types/anime';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function fetchWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number
): Promise<T | null> {
  try {
    return await Promise.race([
      fn(),
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

export function safeFetch<T>(
  fn: () => Promise<T>,
  timeoutMs: number
): Promise<{ data: T | null; error: string | null }> {
  return Promise.race([
    fn().then(
      (data) => ({ data, error: null }),
      (err) => ({
        data: null,
        error: (err as Error)?.message ?? 'unknown',
      })
    ),
    new Promise<{ data: T | null; error: string | null }>((r) =>
      setTimeout(() => r({ data: null, error: `timeout ${timeoutMs}ms` }), timeoutMs)
    ),
  ]);
}

export function fallbackJson(errors: string[]): string {
  return JSON.stringify(
    { error: true, message: 'Semua sumber gagal', errors },
    null,
    2
  );
}

export function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function parseJsonNumberArray(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((n) => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

export function parseJsonMedia(raw: string | null): AniListMedia | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AniListMedia;
  } catch {
    return null;
  }
}
