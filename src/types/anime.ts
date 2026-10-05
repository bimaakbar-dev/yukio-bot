// src/types/anime.ts
/**
 * Unified anime data interface.
 * Semua service (Kitsu, Shikimori) convert ke tipe ini.
 *
 * Field `extended` (opsional) diisi mapper kalau tersedia.
 */
export interface AniListMedia {
  id: number;
  title: {
    romaji: string;
    english: string | null;
    native: string | null;
  };
  coverImage: {
    extraLarge: string;
    large: string;
  };
  description: string | null;
  format: string;
  status: string;
  seasonYear: number | null;
  episodes: number | null;
  genres: string[];
  averageScore: number | null;
  studios: {
    nodes: { name: string }[];
  };
  startDate: {
    year: number | null;
    month: number | null;
    day: number | null;
  };

  /* === Extended (opsional) === */
  /** Durasi per episode dalam menit */
  duration?: number | null;
  /** Rating umur: G | PG | PG-13 | R | R+ | Rx */
  rating?: string | null;
  /** Tanggal selesai tayang */
  endDate?: {
    year: number | null;
    month: number | null;
    day: number | null;
  } | null;
  /** URL banner (landscape) */
  banner?: string | null;
  /** URL trailer (YouTube) */
  trailer?: string | null;
  /** Slug franchise (dari Shikimori) */
  franchise?: string | null;
  /** MAL ID (dari Shikimori id) */
  myanimelistId?: number | null;
  /** Source material: original/manga/light_novel/dll */
  source?: string | null;
}