import type { D1Database } from '@cloudflare/workers-types';

const CHUNK = 100;

export interface VoiceActorInput {
  id: string;
  name: string;
  nameNative?: string;
  image?: string;
  defaultLanguage?: string;
}

export interface VoiceActorRow {
  id: string;
  name: string;
  nameNative: string | null;
  image: string | null;
  defaultLanguage: string | null;
}

export async function saveVoiceActors(
  db: D1Database,
  vas: VoiceActorInput[]
): Promise<{ newCount: number; skippedCount: number }> {
  if (vas.length === 0) return { newCount: 0, skippedCount: 0 };

  const existingSet = new Set<string>();

  for (let i = 0; i < vas.length; i += CHUNK) {
    const slice = vas.slice(i, i + CHUNK);
    const ids = slice.map((v) => v.id);
    const placeholders = ids.map(() => '?').join(',');
    const res = await db
      .prepare(`SELECT id FROM voice_actors WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<{ id: string }>();
    for (const r of res.results ?? []) existingSet.add(r.id);
  }

  const newVAs = vas.filter((v) => !existingSet.has(v.id));
  if (newVAs.length === 0) {
    return { newCount: 0, skippedCount: vas.length };
  }

  const now = Date.now();

  for (let i = 0; i < newVAs.length; i += CHUNK) {
    const slice = newVAs.slice(i, i + CHUNK);
    const stmts = slice.map((v) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO voice_actors
           (id, name, nameNative, image, defaultLanguage, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          v.id,
          v.name,
          v.nameNative ?? null,
          v.image ?? null,
          v.defaultLanguage ?? 'Japanese',
          now
        )
    );
    await db.batch(stmts);
  }

  return {
    newCount: newVAs.length,
    skippedCount: vas.length - newVAs.length,
  };
}

export async function getAllVoiceActors(
  db: D1Database
): Promise<VoiceActorRow[]> {
  const res = await db
    .prepare(
      `SELECT id, name, nameNative, image, defaultLanguage
       FROM voice_actors
       ORDER BY id ASC`
    )
    .all<VoiceActorRow>();
  return res.results ?? [];
}