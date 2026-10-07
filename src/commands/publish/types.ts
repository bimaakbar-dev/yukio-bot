// src/commands/publish/types.ts

export type SectionKey = 'meta' | 'chars' | 'eps' | 'fr' | 'va';

export const ALL_SECTIONS: SectionKey[] = ['meta', 'chars', 'eps', 'fr', 'va'];

export const SECTION_LABEL: Record<SectionKey, string> = {
  meta: '📄 Metadata + Summary',
  chars: '👥 Characters',
  eps: '🎬 Episodes',
  fr: '🔗 Franchises',
  va: '🎤 Actors',
};

export const PUBLISH_TTL_MS = 30 * 60 * 1000;
export const EP_PART_SIZE = 12;
export const RELATION_FETCH_TIMEOUT_MS = 8000;
export const AI_REWRITE_TIMEOUT_MS = 12000;

export interface SectionInfo {
  count: number;
  files: number;
}

export interface PublishSummary {
  yukionime: { metadata: boolean };
  yukioData: {
    characters: SectionInfo;
    episodes: SectionInfo;
    franchises: SectionInfo;
    actors: SectionInfo;
  };
  qimochi: {
    franchises: SectionInfo;
  };
}

export interface PendingPublishRow {
  session_id: string;
  user_id: number;
  files_json: string;
  summary_json: string;
  selected_json: string | null;
  created_at: number;
  expires_at: number;
}

export function emptySummary(): PublishSummary {
  return {
    yukionime: { metadata: false },
    yukioData: {
      characters: { count: 0, files: 0 },
      episodes: { count: 0, files: 0 },
      franchises: { count: 0, files: 0 },
      actors: { count: 0, files: 0 },
    },
    qimochi: {
      franchises: { count: 0, files: 0 },
    },
  };
}

export function sectionFromPath(path: string): SectionKey {
  if (path.startsWith('src/content/anime/')) return 'meta';
  if (path.includes('/characters/')) return 'chars';
  if (path.includes('/episodes/')) return 'eps';
  if (path.endsWith('/franchises.json')) return 'fr';
  if (path.startsWith('data/actors/')) return 'va';
  return 'meta';
}