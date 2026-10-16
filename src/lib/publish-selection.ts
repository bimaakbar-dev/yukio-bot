import type { Env } from '../types/env';
import { getCache, setCache } from './cache';

const TTL_MS = 30 * 60 * 1000;

export type PublishSection = 'characters' | 'episodes' | 'franchises';

const VALID_SECTIONS: PublishSection[] = ['characters', 'episodes', 'franchises'];

export async function markSectionSelected(
  env: Env,
  sessionId: string,
  key: PublishSection
): Promise<void> {
  const current = await getSelectedSections(env, sessionId);
  if (!current.includes(key)) {
    current.push(key);
    await setCache(env.DB, `sel:${sessionId}`, current, TTL_MS);
  }
}

export async function getSelectedSections(
  env: Env,
  sessionId: string
): Promise<PublishSection[]> {
  const cached = await getCache<PublishSection[]>(env.DB, `sel:${sessionId}`);
  if (!Array.isArray(cached)) return [];
  return cached.filter((k): k is PublishSection =>
    VALID_SECTIONS.includes(k as PublishSection)
  );
}

export async function clearSelectedSections(
  env: Env,
  sessionId: string
): Promise<void> {
  try {
    await env.DB
      .prepare('DELETE FROM cache WHERE key = ?')
      .bind(`sel:${sessionId}`)
      .run();
  } catch {}
}
