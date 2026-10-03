import type { CommandDefinition } from './registry';
import type { Context, Bot } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { AniListMedia } from '../services/anilist';
import { searchAniList } from '../services/anilist';
import { searchJikan, jikanToAniList } from '../services/jikan';
import { searchKitsu, kitsuToAniList } from '../services/kitsu';
import { searchShikimori, shikimoriToAniList } from '../services/shikimori';
import { getCache, setCache } from '../lib/cache';
import { chatAI } from '../services/ai';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AI_TIMEOUT_MS = 3000;
const SESSION_TTL_MS = 30 * 60 * 1000;

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

/* ═══════════════════════════════════════════════
   DB: TEMP SESSIONS
   ═══════════════════════════════════════════════ */

let dbReady = false;
let dbInitPromise: Promise<void> | null = null;

async function ensureDb(db: D1Database): Promise<void> {
  if (dbReady) return;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS temp_anime (
            session_id   TEXT PRIMARY KEY,
            user_id      INTEGER NOT NULL,
            yaml         TEXT NOT NULL,
            body         TEXT NOT NULL,
            missing      TEXT NOT NULL,
            ai_used      TEXT NOT NULL,
            cover        TEXT,
            source_label TEXT,
            created_at   INTEGER NOT NULL,
            expires_at   INTEGER NOT NULL
          )`
        )
        .run();
      dbReady = true;
    } catch (err) {
      console.error('[Anime] DB init error:', err);
      dbInitPromise = null;
      throw err;
    }
  })();

  return dbInitPromise;
}

async function saveSession(
  db: D1Database,
  userId: number,
  data: {
    yaml: string;
    body: string;
    missing: string[];
    aiUsed: string[];
    cover: string | null;
    sourceLabel: string | null;
  }
): Promise<string> {
  await ensureDb(db);

  const sessionId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO temp_anime
         (session_id, user_id, yaml, body, missing, ai_used, cover, source_label, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionId,
      userId,
      data.yaml,
      data.body,
      JSON.stringify(data.missing),
      JSON.stringify(data.aiUsed),
      data.cover,
      data.sourceLabel,
      now,
      now + SESSION_TTL_MS
    )
    .run();

  return sessionId;
}

interface SessionRow {
  session_id: string;
  user_id: number;
  yaml: string;
  body: string;
  missing: string;
  ai_used: string;
  cover: string | null;
  source_label: string | null;
  created_at: number;
  expires_at: number;
}

async function getSession(
  db: D1Database,
  sessionId: string
): Promise<SessionRow | null> {
  await ensureDb(db);

  const row = await db
    .prepare('SELECT * FROM temp_anime WHERE session_id = ?')
    .bind(sessionId)
    .first<SessionRow>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await db
      .prepare('DELETE FROM temp_anime WHERE session_id = ?')
      .bind(sessionId)
      .run()
      .catch(() => {});
    return null;
  }

  return row;
}

async function deleteSession(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM temp_anime WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.error('[Anime] delete error:', err);
  }
}

/* ═══════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════ */

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
}

function extractJson(text: string): unknown {
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
    `You are a FACTUAL anime database expert. Return STRICT JSON only.\n` +
    `CRITICAL: If you don't know a fact with HIGH CONFIDENCE, return null for that field. NEVER GUESS or HALLUCINATE.\n\n` +
    `Anime title: ${title}\n\n` +
    (known.length > 0
      ? `Known data (DO NOT change these):\n${known.join('\n')}\n\n`
      : '') +
    `Fill in ONLY these missing fields: ${need.join(', ')}\n\n` +
    `Output JSON format:\n` +
    `{\n` +
    `  "studio": "exact animation studio name or null",\n` +
    `  "rating": 7.5,\n` +
    `  "genre": ["Action", "Adventure"],\n` +
    `  "releaseDate": "YYYY-MM-DD",\n` +
    `  "synopsis": "factual Indonesian synopsis, no spoilers"\n` +
    `}\n\n` +
    `STRICT RULES:\n` +
    `- If NOT 100% sure about a field, use null. Hallucination is WORSE than null.\n` +
    `- rating: actual MAL/AniList score (0-10, one decimal)\n` +
    `- studio: only the PRIMARY animation studio (not producer)\n` +
    `- synopsis: factual summary in Indonesian, NOT creative writing\n` +
    `- Output valid JSON only, no markdown, no explanation`;

  console.log(
    `[Anime] AI enrich — need: [${need.join(', ')}], prompt len: ${prompt.length}`
  );

  try {
    const raw = await chatAI(
      env,
      [{ role: 'user', content: prompt }],
      { maxTokens: 900, temperature: 0.1, smart: true }
    );

    console.log(`[Anime] AI raw response len: ${raw?.length ?? 0}`);

    if (!raw || raw.length === 0) {
      console.warn('[Anime] AI returned empty');
      return null;
    }

    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== 'object') {
      console.warn('[Anime] AI parse failed, raw head:', raw.slice(0, 200));
      return null;
    }

    console.log('[Anime] AI parsed:', JSON.stringify(parsed).slice(0, 300));

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
    console.error('[Anime] AI enrich failed:', err);
    return null;
  }
}

async function enrichWithAITimeout(
  env: Env,
  title: string,
  existing: {
    studio?: string | null;
    rating?: number | null;
    genre?: string[] | null;
    releaseDate?: string | null;
  },
  need: string[]
): Promise<Enriched | null> {
  if (need.length === 0) return null;

  console.log('[Anime] AI enrich starting...');

  return Promise.race([
    enrichWithAI(env, title, existing, need),
    new Promise<Enriched | null>((resolve) => {
      setTimeout(() => {
        console.warn(`[Anime] AI timeout after ${AI_TIMEOUT_MS}ms`);
        resolve(null);
      }, AI_TIMEOUT_MS);
    }),
  ]).then((result) => {
    console.log('[Anime] AI enrich result:', result ? 'got data' : 'null');
    return result;
  });
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

  let cover = media.coverImage.extraLarge || media.coverImage.large || '';
  if (!cover || !isValidHttpUrl(cover)) {
    cover = 'https://placehold.co/400x600?text=No+Cover';
    missing.push('cover');
  }

  let status: AnimeStatus = 'Ongoing';
  const mappedStatus = STATUS_MAP[media.status];
  if (mappedStatus) status = mappedStatus;
  else missing.push('status');

  let type: AnimeType = 'TV';
  const mappedType = FORMAT_MAP[media.format];
  if (mappedType) type = mappedType;
  else missing.push('type');

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

  const y = media.startDate?.year ?? media.seasonYear;
  const mo = media.startDate?.month;
  const d = media.startDate?.day;
  let releaseDate: string;

  if (y && mo && d) {
    releaseDate = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  } else if (
    enriched?.releaseDate &&
    /^\d{4}-\d{2}-\d{2}$/.test(enriched.releaseDate)
  ) {
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

  let synopsisRaw = media.description ?? null;
  if (synopsisRaw) synopsisRaw = stripHtml(synopsisRaw);

  let synopsis = synopsisRaw;
  const isTooShort = !synopsis || synopsis.length < 50;

  if (isTooShort && enriched?.synopsis && enriched.synopsis.length > 50) {
    synopsis = enriched.synopsis;
    aiUsed.push('synopsis');
  }

  if (!synopsis || synopsis.length < 30) {
    synopsis =
      '> ⚠️ Sinopsis belum tersedia. Silakan isi manual.\n\n' +
      `${title} adalah anime yang...`;
    missing.push('synopsis (body)');
  }

  return { yaml, body: synopsis, missing, aiUsed };
}

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
   FETCH CHAIN: Kitsu → Jikan → AniList → Shikimori
   ═══════════════════════════════════════════════ */

async function fetchMetadata(query: string): Promise<{
  media: AniListMedia;
  source: string;
} | null> {
  const errors: string[] = [];

  // 1. Kitsu — primary, reliable dari Cloudflare Worker
  const t1 = Date.now();
  try {
    const kitsu = await searchKitsu(query);
    if (kitsu) {
      console.log(`[Anime] Kitsu OK in ${Date.now() - t1}ms`);
      return { media: kitsuToAniList(kitsu), source: 'Kitsu' };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Kitsu: ${msg}`);
    console.warn(`[Anime] Kitsu failed in ${Date.now() - t1}ms:`, msg);
  }

  // 2. Jikan (MAL)
  const t2 = Date.now();
  try {
    const jikan = await searchJikan(query);
    if (jikan) {
      console.log(`[Anime] Jikan OK in ${Date.now() - t2}ms`);
      return { media: jikanToAniList(jikan), source: 'Jikan (MAL)' };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Jikan: ${msg}`);
    console.warn(`[Anime] Jikan failed in ${Date.now() - t2}ms:`, msg);
  }

  // 3. AniList
  const t3 = Date.now();
  try {
    const anilist = await searchAniList(query);
    if (anilist) {
      console.log(`[Anime] AniList OK in ${Date.now() - t3}ms`);
      return { media: anilist, source: 'AniList' };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`AniList: ${msg}`);
    console.warn(`[Anime] AniList failed in ${Date.now() - t3}ms:`, msg);
  }

  // 4. Shikimori
  const t4 = Date.now();
  try {
    const shiki = await searchShikimori(query);
    if (shiki) {
      console.log(`[Anime] Shikimori OK in ${Date.now() - t4}ms`);
      return { media: shikimoriToAniList(shiki), source: 'Shikimori' };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Shikimori: ${msg}`);
    console.warn(`[Anime] Shikimori failed in ${Date.now() - t4}ms:`, msg);
  }

  console.warn('[Anime] All APIs failed:', errors);
  return null;
}

/* ═══════════════════════════════════════════════
   DETECT MISSING
   ═══════════════════════════════════════════════ */

function detectMissing(media: AniListMedia): string[] {
  const need: string[] = [];

  const studio = media.studios?.nodes?.[0]?.name;
  if (!studio || studio === 'Unknown') need.push('studio');

  if (typeof media.averageScore !== 'number' || media.averageScore <= 0) {
    need.push('rating');
  }

  if (!media.genres || media.genres.length === 0) need.push('genre');

  if (!media.startDate?.year && !media.seasonYear) need.push('releaseDate');

  const desc = media.description ?? '';
  const cleanDesc = stripHtml(desc);
  if (!cleanDesc || cleanDesc.length < 50) {
    need.push('synopsis');
  }

  return need;
}

/* ═══════════════════════════════════════════════
   COMMAND
   ═══════════════════════════════════════════════ */

export const animeCommand: CommandDefinition = {
  name: 'anime',
  description: 'Cari metadata anime → tombol convert YAML',
  usage: '/anime jujutsu kaisen',
  adminOnly: true,

  handler: async (ctx, env) => {
    const T0 = Date.now();

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
          '<i>Setelah data siap, klik tombol untuk convert ke YAML.</i>',
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
        console.log(`[Anime] cache hit at ${Date.now() - T0}ms`);
      } else {
        const result = await fetchMetadata(searchQuery);
        if (result) {
          media = result.media;
          sourceLabel = `📡 Sumber: ${result.source}`;
          await setCache(env.DB, cacheKey, media, CACHE_TTL_MS);
        }
        console.log(`[Anime] fetch stage done at ${Date.now() - T0}ms`);
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

      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        buildInfoMessage(media),
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );

      const need = detectMissing(media);

      let enriched: Enriched | null = null;

      if (need.length > 0) {
        const aiLoading = await ctx.reply(
          `🤖 AI melengkapi: <code>${need.join(', ')}</code>...`,
          { parse_mode: 'HTML' }
        );

        enriched = await enrichWithAITimeout(
          env,
          pickTitle(media),
          {
            studio: media.studios?.nodes?.[0]?.name,
            rating: media.averageScore ? media.averageScore / 10 : null,
            genre: media.genres,
            releaseDate: media.startDate?.year
              ? `${media.startDate.year}-01-01`
              : null,
          },
          need
        );

        await ctx.api
          .deleteMessage(ctx.chat!.id, aiLoading.message_id)
          .catch(() => {});

        console.log(`[Anime] AI stage done at ${Date.now() - T0}ms`);
      } else {
        console.log('[Anime] no AI needed — skipping');
      }

      const { yaml, body, missing, aiUsed } = buildResult(media, enriched);

      const sessionId = await saveSession(env.DB, ctx.from!.id, {
        yaml,
        body,
        missing,
        aiUsed,
        cover:
          media.coverImage.extraLarge || media.coverImage.large || null,
        sourceLabel: sourceLabel || null,
      });

      const keyboard = new InlineKeyboard()
        .text('📋 Convert ke YAML', `an:y:${sessionId}`)
        .text('❌ Batal', `an:x:${sessionId}`);

      await ctx.reply(
        '✅ <b>Data siap!</b>\n\n' +
          'Klik tombol di bawah untuk convert ke <b>YAML</b> + sinopsis.',
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard,
        }
      );

      console.log(`[Anime] total: ${Date.now() - T0}ms`);
    } catch (err: any) {
      const elapsed = Date.now() - T0;
      console.error(`[Anime] error after ${elapsed}ms:`, err);

      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ <b>Gagal memuat data</b> (${elapsed}ms)\n\n` +
            `Error: <code>${escapeHtml(err?.message ?? 'unknown')}</code>\n\n` +
            `<i>Coba lagi beberapa menit.</i>`,
          { parse_mode: 'HTML' }
        );
      } catch {
        await ctx.reply(
          `❌ Gagal: ${escapeHtml(err?.message ?? 'unknown')}`
        ).catch(() => {});
      }
    }
  },
};

/* ═══════════════════════════════════════════════
   CALLBACK HANDLERS
   ═══════════════════════════════════════════════ */

export function setupAnimeCallbacks(bot: Bot, env: Env): void {
  bot.callbackQuery(/^an:y:([a-f0-9]+)$/, async (ctx) => {
    const [, sessionId] = ctx.match as RegExpMatchArray;
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌ Session tidak valid' });
      return;
    }

    const session = await getSession(env.DB, sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: '⏱️ Session kadaluarsa. Ulangi /anime.',
        show_alert: true,
      });
      await ctx
        .editMessageReplyMarkup({ reply_markup: undefined })
        .catch(() => {});
      return;
    }

    if (ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '📋 Convert...' });

    await ctx
      .editMessageReplyMarkup({ reply_markup: undefined })
      .catch(() => {});

    const missing: string[] = JSON.parse(session.missing);
    const aiUsed: string[] = JSON.parse(session.ai_used);

    const warnLines: string[] = [];
    if (missing.length > 0) {
      warnLines.push('⚠️ <b>Perlu edit manual:</b>');
      for (const f of missing)
        warnLines.push(`• <code>${escapeHtml(f)}</code>`);
      warnLines.push('');
    }
    if (aiUsed.length > 0) {
      warnLines.push('🤖 <b>Diisi AI (VERIFIKASI ulang):</b>');
      for (const f of aiUsed)
        warnLines.push(`• <code>${escapeHtml(f)}</code>`);
    }
    if (warnLines.length > 0) {
      await ctx.reply(warnLines.join('\n'), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    }

    await ctx.reply(
      `📋 <b>YAML Frontmatter</b>\n\n<pre>${escapeHtml(session.yaml)}</pre>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );

    const bodyMax = 3500;
    const bodyPreview =
      session.body.length > bodyMax
        ? session.body.slice(0, bodyMax) + '\n\n… [truncated]'
        : session.body;

    await ctx.reply(
      `📝 <b>Body (Sinopsis)</b>\n\n<pre>${escapeHtml(bodyPreview)}</pre>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );

    if (session.cover && isValidHttpUrl(session.cover)) {
      try {
        await ctx.replyWithPhoto(session.cover);
      } catch (err) {
        console.warn('[Anime] Failed to send cover:', err);
      }
    }

    if (session.source_label) {
      await ctx.reply(session.source_label);
    }

    await deleteSession(env.DB, sessionId);
  });

  bot.callbackQuery(/^an:x:([a-f0-9]+)$/, async (ctx) => {
    const [, sessionId] = ctx.match as RegExpMatchArray;
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: '❌ Session tidak valid' });
      return;
    }

    const session = await getSession(env.DB, sessionId);
    if (session && ctx.from?.id !== session.user_id) {
      await ctx.answerCallbackQuery({ text: '⛔ Bukan sesi Anda' });
      return;
    }

    if (sessionId) await deleteSession(env.DB, sessionId);

    await ctx
      .editMessageText('❌ <b>Dibatalkan.</b>', {
        parse_mode: 'HTML',
        reply_markup: undefined,
      })
      .catch(() => {});

    await ctx.answerCallbackQuery({ text: '🗑️ Dibatalkan' });
  });
}