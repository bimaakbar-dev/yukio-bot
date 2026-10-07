// src/types/anime.ts
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

  duration?: number | null;
  rating?: string | null;
  endDate?: {
    year: number | null;
    month: number | null;
    day: number | null;
  } | null;
  banner?: string | null;
  trailer?: string | null;
  franchise?: string | null;
  myanimelistId?: number | null;
  source?: string | null;
}

export interface EpisodeObject {
  number: number;
  streams: {
    quality: string;
    servers: { name: string; url: string }[];
  }[];
}