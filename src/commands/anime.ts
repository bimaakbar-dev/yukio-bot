import type { CommandDefinition } from './registry';
import { searchAniList, type AniListMedia } from '../services/anilist';
import { searchJikan, jikanToAniList } from '../services/jikan';
import { searchKitsu, kitsuToAniList } from '../services/kitsu';
import { getCache, setCache } from '../lib/cache';
import { chatAI } from '../services/ai';
import type { Env } from '../types/env';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type AnimeStatus = 'Ongoing' | 'Completed' | 'Hiatus';
type AnimeType = 'TV' | 'Movie' | 'OVA' | 'ONA' | 'Special';

const FORMAT_MAP: Record<string, AnimeType> = {
  TV: 'TV',
  TV_SHORT: 'TV',
  MOVIE: 'Movie',
  SPECIAL: 'Special',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'Special',
};

const STATUS_MAP: Record<string, AnimeStatus> = {
  FINISHED: 'Completed',
  RELEASING: 'Ongoing',
  NOT_YET_RELEASED: 'Ongoing',
  CANCELLED: 'Hiatus',
  HIATUS: 'Hiatus',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pickTitle(media: AniListMedia): string {
  return (
    media.title.romaji ||
    media.title.english ||
    media.title.native ||
    'Unknown'
  );
}

function yamlString(s: string): string {
  const cleaned = s.replace(/\n/g, ' ').trim();
  const needsQuote = /[:#&*!|>'"%@`{}\[\],]/.test(cleaned);
  if (!needsQuote) return cleaned;
  return `"${cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ═══════════════════════════════════════════════
   AI ENRICHMENT
   ═══════════════════════════════════════════════ */

interface Enriched {
  studio?: string | null;
  rating?: number | null;
  synopsis?: string | null;
  genre?: string[] | null;
  releaseDate?: string | null;
  type?: string | null;
  status?: string | null;
}

function extractJson(text: string): unknown {
  // AI kadang bungkus dengan ```json ... ``` atau penjelasan
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function enrichWithAI(
  env: Env,
  title: string,
  existing: {
    studio?: string | null;
    rating?: number | null;
    genre?: string[] | null;
    releaseDate?: string | null;
    synopsis?: string | null;
  },
  need: string[]
): Promise<Enriched | null> {
  if (need.length === 0) return null;

  const known: string[] = [];
  if (existing.studio) known.push(`studio: ${existing.studio}`);
  if (existing.rating) known.push(`rating: ${existing.rating}`);
  if (existing.genre?.length) known.push(`genre: ${existing.genre.join(', ')}`);
  if (existing.releaseDate) known.push(`releaseDate: ${existing.releaseDate}`);

  const prompt =
    `You are an anime database expert. Return STRICT JSON only, no markdown, no explanation.\n\n` +
    `Anime title: ${title}\n\n` +
    (known.length > 0
      ? `Known data (DO NOT change these):\n${known.join('\n')}\n\n`
      : '') +
    `Fill in ONLY these missing fields: ${need.join(', ')}\n\n` +
    `Output format (JSON):\n` +
    `{\n` +
    `  "studio": "Studio name or null",\n` +
    `  "rating": 8.5,\n` +
    `  "genre": ["Action", "Adventure"],\n` +
    `  "releaseDate": "YYYY-MM-DD",\n` +
    `  "synopsis": "2-3 paragraph synopsis in Indonesian, no spoilers"\n` +
    `}\n\n` +
    `Rules:\n` +
    `- Only include requested fields\n` +
    `- rating: number 0-10 with 1 decimal\n` +
    `- synopsis: 100-250 words, Indonesian, no spoiler\n` +
    `- If unsure, use null\n` +
    `- Output valid JSON only`;

  try {
    const raw = await chatAI(
      env,
      [{ role: 'user', content: prompt }],
      { maxTokens: 900, temperature: 0.2 }
    );
    if (!raw) return null;

    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const obj = parsed as Record<string, unknown>;
    const out: Enriched = {};

    if (typeof obj.studio === 'string') out.studio = obj.studio;
    if (typeof obj.rating === 'number') out.rating = obj.rating;
    if (Array.isArray(obj.genre)) {
      out.genre = obj.genre.filter((g): g is string => typeof g === 'string');
    }
    if (typeof obj.releaseDate === 'string') out.releaseDate = obj.releaseDate;
    if (typeof obj.synopsis === 'string') out.synopsis = obj.synopsis;

    return out;
  } catch (err) {
    console.warn('[Anime] AI enrich failed:', err);
    return null;
  }
}

/* ═══════════════════════════════════════════════
   BUILD YAML + BODY
   ═══════════════════════════════════════════════ */

interface BuildResult {
  yaml: string;
  body: string;
  missing: string[];
  aiUsed: string[];
}

function buildResult(
  media: AniListMedia,
  enriched: Enriched | null
): BuildResult {
  const missing: string[] = [];
  const aiUsed: string[] = [];

  const title = pickTitle(media);
  if (!title || title === 'Unknown') missing.push('title');

  // Cover
  let cover = media.coverImage.extraLarge || media.coverImage.large || '';
  if (!cover || !isValidHttpUrl(cover)) {
    cover = 'https://placehold.co/400x600?text=No+Cover';
    missing.push('cover');
  }

  // Status
  let status: AnimeStatus = 'Ongoing';
  const mappedStatus = STATUS_MAP[media.status];
  if (mappedStatus) status = mappedStatus;
  else missing.push('status');

  // Type
  let type: AnimeType = 'TV';
  const mappedType = FORMAT_MAP[media.format];
  if (mappedType) type = mappedType;
  else missing.push('type');

  // Genre
  let genres = (media.genres ?? []).filter((g) => g && g.trim());
  if (genres.length === 0 && enriched?.genre?.length) {
    genres = enriched.genre;
    aiUsed.push('genre');
  }
  if (genres.length === 0) {
    genres = ['Unknown'];
    missing.push('genre');
  }
  const genreYaml = `[${genres.map((g) => yamlString(g)).join(', ')}]`;

  // Studio
  let studio = media.studios?.nodes?.[0]?.name ?? '';
  if (!studio || studio === 'Unknown') {
    if (enriched?.studio) {
      studio = enriched.studio;
      aiUsed.push('studio');
    } else {
      studio = 'Unknown';
      missing.push('studio');
    }
  }

  // Release date
  const y = media.startDate?.year ?? media.seasonYear;
  const mo = media.startDate?.month;
  const d = media.startDate?.day;
  let releaseDate: string;

  if (y && mo && d) {
    releaseDate = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  } else if (enriched?.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(enriched.releaseDate)) {
    releaseDate = enriched.releaseDate;
    aiUsed.push('releaseDate');
  } else if (y) {
    releaseDate = `${y}-01-01`;
    missing.push('releaseDate (default 01-01)');
  } else {
    releaseDate = new Date().toISOString().split('T')[0] ?? '2020-01-01';
    missing.push('releaseDate');
  }

  const addedAt = new Date().toISOString().split('T')[0] ?? '2026-01-01';

  // Rating
  let rating: string;
  if (typeof media.averageScore === 'number' && media.averageScore > 0) {
    rating = (media.averageScore / 10).toFixed(1);
  } else if (typeof enriched?.rating === 'number' && enriched.rating > 0) {
    rating = enriched.rating.toFixed(1);
    aiUsed.push('rating');
  } else {
    rating = '0.0';
    missing.push('rating');
  }

  // YAML
  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: ${yamlString(title)}`);
  lines.push(`cover: ${cover}`);
  lines.push(`status: ${status}`);
  lines.push(`type: ${type}`);
  lines.push(`genre: ${genreYaml}`);
  lines.push(`studio: ${yamlString(studio)}`);
  lines.push(`releaseDate: ${releaseDate}`);
  lines.push(`addedAt: ${addedAt}`);
  lines.push(`rating: ${rating}`);
  lines.push('episodes: []');
  lines.push('---');
  const yaml = lines.join('\n');

  // Body: synopsis
  let synopsisRaw = media.description ?? null;
  if (synopsisRaw) synopsisRaw = stripHtml(synopsisRaw);

  let synopsis = synopsisRaw;
  if (!synopsis || synopsis.length < 50) {
    if (enriched?.synopsis && enriched.synopsis.length > 50) {
      synopsis = enriched.synopsis;
      aiUsed.push('synopsis');
    }
  }

  if (!synopsis || synopsis.length < 30) {
    synopsis =
      '> ⚠️ Sinopsis belum tersedia. Silakan isi manual.\n\n' +
      `${title} adalah anime yang...`;
    missing.push('synopsis (body)');
  }

  return { yaml, body: synopsis, missing, aiUsed };
}

/* ═══════════════════════════════════════════════
   INFO CARD
   ═══════════════════════════════════════════════ */

function buildInfoMessage(media: AniListMedia): string {
  const title = pickTitle(media);
  const year = media.startDate?.year ?? media.seasonYear ?? '-';
  const studio = media.studios?.nodes?.[0]?.name ?? 'Unknown';
  const genres = (media.genres ?? []).slice(0, 3).join(', ') || '-';
  const rating = media.averageScore
    ? (media.averageScore / 10).toFixed(1)
    : '-';
  const status = STATUS_MAP[media.status] ?? media.status;
  const type = FORMAT_MAP[media.format] ?? media.format;

  return (
    `<b>${escapeHtml(title)}</b>\n\n` +
    `📅 Tahun: ${year}\n` +
    `🎬 Tipe: ${type}\n` +
    `📌 Status: ${status}\n` +
    `📼 Episode: ${media.episodes ?? '-'}\n` +
    `🏢 Studio: ${escapeHtml(studio)}\n` +
    `🏷️ Genre: ${escapeHtml(genres)}\n` +
    `⭐ Rating: ${rating}`
  );
}

/* ═══════════════════════════════════════════════
   MAL URL
   ═══════════════════════════════════════════════ */

function isMALUrl(s: string): boolean {
  return /^https?:\/\/(www\.)?myanimelist\.net\/anime\/\d+/i.test(s.trim());
}

function extractTitleFromMALUrl(url: string): string | null {
  const m = url.match(/myanimelist\.net\/anime\/\d+\/([^\/\?#]+)/i);
  if (!m) return null;
  const slug = m[1];
  if (!slug) return null;
  return decodeURIComponent(slug).replace(/_/g, ' ').trim() || null;
}

/* ═══════════════════════════════════════════════
   FETCH CHAIN
   ═══════════════════════════════════════════════ */

async function fetchMetadata(query: string): Promise<{
  media: AniListMedia;
  source: string;
} | null> {
  const errors: string[] = [];

  // 1. AniList
  try {
    const media = await searchAniList(query);
    if (media) return { media, source: 'AniList' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`AniList: ${msg}`);
    console.warn('[Anime] AniList failed:', msg);
  }

  // 2. Jikan
  try {
    const jikan = await searchJikan(query);
    if (jikan) {
      return { media: jikanToAniList(jikan), source: 'Jikan (MAL)' };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Jikan: ${msg}`);
    console.warn('[Anime] Jikan failed:', msg);
  }

  // 3. Kitsu
  try {
    const kitsu = await searchKitsu(query);
    if (kitsu) {
      return { media: kitsuToAniList(kitsu), source: 'Kitsu' };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Kitsu: ${msg}`);
    console.warn('[Anime] Kitsu failed:', msg);
  }

  if (errors.length > 0) {
    console.warn('[Anime] All APIs failed:', errors);
  }
  return null;
}

/* ═══════════════════════════════════════════════
   DETECT MISSING FIELDS UNTUK AI
   ═══════════════════════════════════════════════ */

function detectMissing(media: AniListMedia): string[] {
  const need: string[] = [];

  const studio = media.studios?.nodes?.[0]?.name;
  if (!studio || studio === 'Unknown') need.push('studio');

  if (
    typeof media.averageScore !== 'number' ||
    media.averageScore <= 0
  ) {
    need.push('rating');
  }

  if (!media.genres || media.genres.length === 0) need.push('genre');

  if (!media.startDate?.year && !media.seasonYear) need.push('releaseDate');

  const desc = media.description ?? '';
  if (!desc || stripHtml(desc).length < 50) need.push('synopsis');

  return need;
}

/* ═══════════════════════════════════════════════
   COMMAND
   ═══════════════════════════════════════════════ */

export const animeCommand: CommandDefinition = {
  name: 'anime',
  description: 'Cari metadata anime → YAML + sinopsis',
  usage: '/anime jujutsu kaisen',
  adminOnly: true,

  handler: async (ctx, env) => {
    const argQuery = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const repliedText = ctx.message?.reply_to_message?.text ?? '';
    const query = argQuery || repliedText;

    if (!query) {
      await ctx.reply(
        '<b>🔍 Cari Metadata Anime</b>\n\n' +
          '<b>Contoh:</b>\n' +
          '<code>/anime jujutsu kaisen</code>\n\n' +
          '<b>Atau URL MAL:</b>\n' +
          '<code>/anime https://myanimelist.net/anime/40748</code>\n\n' +
          '<i>Output: YAML frontmatter + sinopsis markdown.\n' +
          'Field kosong akan diisi AI otomatis.</i>',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    const loading = await ctx.reply('🔍 Mencari...');

    try {
      let media: AniListMedia | null = null;
      let sourceLabel = '';
      let searchQuery = query;

      if (isMALUrl(query)) {
        const t = extractTitleFromMALUrl(query);
        if (t) searchQuery = t;
      }

      const cacheKey = `anime:${searchQuery.toLowerCase().trim()}`;
      media = await getCache<AniListMedia>(env.DB, cacheKey);

      if (media) {
        sourceLabel = '⚡ Dari cache';
      } else {
        const result = await fetchMetadata(searchQuery);
        if (result) {
          media = result.media;
          sourceLabel = `📡 Sumber: ${result.source}`;
          await setCache(env.DB, cacheKey, media, CACHE_TTL_MS);
        }
      }

      if (!media) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ Anime "<b>${escapeHtml(searchQuery)}</b>" tidak ditemukan.\n\n` +
            `<i>Kemungkinan:</i>\n` +
            `• Judul tidak ada di database\n` +
            `• Semua API sedang down / rate limit\n\n` +
            `<i>Coba lagi beberapa menit.</i>`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // ─── Info card ───
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        buildInfoMessage(media),
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );

      // ─── Deteksi field kosong ───
      const need = detectMissing(media);

      let enriched: Enriched | null = null;
      if (need.length > 0) {
        const aiLoading = await ctx.reply(
          `🤖 AI melengkapi: <code>${need.join(', ')}</code>...`,
          { parse_mode: 'HTML' }
        );

        enriched = await enrichWithAI(
          env,
          pickTitle(media),
          {
            studio: media.studios?.nodes?.[0]?.name,
            rating: media.averageScore ? media.averageScore / 10 : null,
            genre: media.genres,
            releaseDate: media.startDate?.year
              ? `${media.startDate.year}-01-01`
              : null,
            synopsis: media.description,
          },
          need
        );

        await ctx.api
          .deleteMessage(ctx.chat!.id, aiLoading.message_id)
          .catch(() => {});
      }

      // ─── Build result ───
      const { yaml, body, missing, aiUsed } = buildResult(media, enriched);

      // ─── Warning ───
      const warnLines: string[] = [];
      if (missing.length > 0) {
        warnLines.push('⚠️ <b>Perlu edit manual:</b>');
        for (const f of missing) {
          warnLines.push(`• <code>${escapeHtml(f)}</code>`);
        }
        warnLines.push('');
      }
      if (aiUsed.length > 0) {
        warnLines.push('🤖 <b>Diisi AI (verifikasi ulang):</b>');
        for (const f of aiUsed) {
          warnLines.push(`• <code>${escapeHtml(f)}</code>`);
        }
      }
      if (warnLines.length > 0) {
        await ctx.reply(warnLines.join('\n'), {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
      }

      // ─── YAML ───
      await ctx.reply(
        `📋 <b>YAML Frontmatter</b>\n\n<pre>${escapeHtml(yaml)}</pre>`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );

      // ─── Body / Synopsis ───
      const bodyMax = 3500;
      const bodyPreview =
        body.length > bodyMax ? body.slice(0, bodyMax) + '\n\n… [truncated]' : body;

      await ctx.reply(
        `📝 <b>Body (Sinopsis)</b>\n\n<pre>${escapeHtml(bodyPreview)}</pre>`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );

      // ─── Cover ───
      const cover = media.coverImage.extraLarge || media.coverImage.large;
      if (cover && isValidHttpUrl(cover)) {
        try {
          await ctx.replyWithPhoto(cover);
        } catch (err) {
          console.warn('[Anime] Failed to send cover:', err);
        }
      }

      if (sourceLabel) {
        await ctx.reply(sourceLabel);
      }
    } catch (err: any) {
      console.error('[Anime] error:', err);
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ Error: ${escapeHtml(err?.message ?? 'unknown')}`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    }
  },
};