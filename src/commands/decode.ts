// src/commands/decode.ts
import type { CommandDefinition } from './registry';
import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Env } from '../types/env';
import type { D1Database } from '@cloudflare/workers-types';
import type { EpisodeObject } from '../types/anime';
import { startOrAppendBatch } from '../lib/batch-session';
import { createLazyInit } from '../lib/lazy-init';
import {
  MAX_INPUT_LEN,
  BATCH_MAX,
  looksLikeHtml,
  isLikelyBase64,
  decodeInput,
  buildEpisodeJson,
  buildEpisodeObject,
  groupByResolution,
  rankResolution,
  parseEpisodeNumber,
  slugifyLabel,
  fetchUrlViaProxy,
  extractSlugHint,
  buildBatchUrls,
  type ResolvedEntry,
} from '../services/decode-core';

const MAX_FILE_CHARS = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MSG_BUDGET = 3800;
const JSON_INLINE_THRESHOLD = 3500;

interface FileRef {
  id: number;
  label: string;
  filename: string | null;
  file_id: string;
  created_at: number;
  last_accessed: number;
}

export const ensureDb = createLazyInit('Decode', async (db) => {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS file_refs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        label         TEXT UNIQUE NOT NULL,
        filename      TEXT,
        file_id       TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL
      )`
    )
    .run();
  await db
    .prepare(
      'CREATE INDEX IF NOT EXISTS idx_file_refs_accessed ON file_refs(last_accessed DESC)'
    )
    .run();
});

async function getFileRef(db: D1Database, label: string): Promise<FileRef | null> {
  await ensureDb(db);
  const row = await db
    .prepare('SELECT * FROM file_refs WHERE label = ?')
    .bind(label)
    .first<FileRef>();
  if (!row) return null;
  db.prepare('UPDATE file_refs SET last_accessed = ? WHERE id = ?')
    .bind(Date.now(), row.id)
    .run()
    .catch(() => {});
  return row;
}

async function saveFileRef(
  db: D1Database,
  label: string,
  filename: string | null,
  fileId: string
): Promise<{ replaced: boolean }> {
  await ensureDb(db);
  const existing = await db
    .prepare('SELECT id FROM file_refs WHERE label = ?')
    .bind(label)
    .first<{ id: number }>();

  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO file_refs (label, filename, file_id, created_at, last_accessed)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(label) DO UPDATE SET
         filename = excluded.filename,
         file_id = excluded.file_id,
         last_accessed = excluded.last_accessed`
    )
    .bind(label, filename, fileId, now, now)
    .run();

  return { replaced: !!existing };
}

async function listFileRefs(db: D1Database, limit = 30): Promise<FileRef[]> {
  await ensureDb(db);
  const res = await db
    .prepare(
      'SELECT id, label, filename, file_id, created_at, last_accessed FROM file_refs ORDER BY last_accessed DESC LIMIT ?'
    )
    .bind(limit)
    .all<FileRef>();
  return res.results ?? [];
}

async function deleteFileRef(db: D1Database, label: string): Promise<boolean> {
  await ensureDb(db);
  const res = await db
    .prepare('DELETE FROM file_refs WHERE label = ?')
    .bind(label)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildUrlList(items: ResolvedEntry[], label?: string): string {
  const lines: string[] = [];
  lines.push('🎬 <b>URL Video</b>');
  if (label) lines.push(`🏷️ <code>${escapeHtml(label)}</code>`);
  lines.push(`📊 Total: <b>${items.length}</b>`);
  lines.push('');

  const byRes = groupByResolution(items);
  const sortedKeys = [...byRes.keys()].sort(
    (a, b) => rankResolution(b) - rankResolution(a)
  );

  let n = 1;
  for (const key of sortedKeys) {
    lines.push(`━━━ ${escapeHtml(key)} ━━━`);
    for (const it of byRes.get(key)!) {
      lines.push(`${n}. <code>${escapeHtml(it.url)}</code>`);
      n++;
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function splitMessage(text: string, budget = MSG_BUDGET): string[] {
  if (text.length <= budget) return [text];
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const prospective = current ? current + '\n' + line : line;
    if (prospective.length > budget && current.length > 0) {
      parts.push(current);
      current = line;
    } else {
      current = prospective;
    }
  }
  if (current) parts.push(current);
  return parts;
}

async function sendDocumentViaApi(
  botToken: string,
  chatId: number,
  filename: string,
  content: string,
  caption: string
): Promise<void> {
  const boundary = '----YukioDecode' + Math.random().toString(36).slice(2, 12);

  const encoder = new TextEncoder();
  const CRLF = '\r\n';
  const chunks: Uint8Array[] = [];

  const pushStr = (s: string) => {
    chunks.push(encoder.encode(s));
  };

  pushStr(`--${boundary}${CRLF}`);
  pushStr(`Content-Disposition: form-data; name="chat_id"${CRLF}${CRLF}`);
  pushStr(`${chatId}${CRLF}`);

  pushStr(`--${boundary}${CRLF}`);
  pushStr(`Content-Disposition: form-data; name="caption"${CRLF}${CRLF}`);
  pushStr(`${caption}${CRLF}`);

  pushStr(`--${boundary}${CRLF}`);
  pushStr(`Content-Disposition: form-data; name="parse_mode"${CRLF}${CRLF}`);
  pushStr(`HTML${CRLF}`);

  pushStr(`--${boundary}${CRLF}`);
  pushStr(
    `Content-Disposition: form-data; name="document"; filename="${filename}"${CRLF}`
  );
  pushStr(`Content-Type: application/json; charset=utf-8${CRLF}${CRLF}`);
  chunks.push(encoder.encode(content));
  pushStr(`${CRLF}`);

  pushStr(`--${boundary}--${CRLF}`);

  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendDocument`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`sendDocument HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
}

async function sendResult(
  ctx: Context,
  env: Env,
  items: ResolvedEntry[],
  label: string | undefined,
  sourceLabels: (string | null)[],
  sourceFilename: string | null
): Promise<void> {
  const urlList = buildUrlList(items, label);
  for (const part of splitMessage(urlList)) {
    await ctx.reply(part, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }

  const episodeNumber = parseEpisodeNumber(sourceFilename, sourceLabels);
  const json = buildEpisodeJson(items, episodeNumber);

  console.log(
    `[Decode] episode number detected: ${episodeNumber} (json len: ${json.length})`
  );

  const targetPath = `src/data/anime/{slug}/episodes/${episodeNumber}.json`;

  if (json.length <= JSON_INLINE_THRESHOLD) {
    await ctx.reply(
      `📋 <b>Episode ${episodeNumber}</b>\n` +
        `<i>Save ke <code>${escapeHtml(targetPath)}</code></i>\n\n` +
        `<pre>${escapeHtml(json)}</pre>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  const filename = `ep-${episodeNumber}.json`;
  const caption =
    `📋 <b>Episode ${episodeNumber}</b>\n` +
    `<i>Rename & save ke <code>${escapeHtml(targetPath)}</code></i>`;

  try {
    await sendDocumentViaApi(
      env.TELEGRAM_BOT_TOKEN,
      ctx.chat!.id,
      filename,
      json,
      caption
    );
  } catch (err) {
    console.warn('[Decode] sendDocument failed, fallback inline:', err);
    await ctx.reply(
      `📋 <b>Episode ${episodeNumber}</b>\n\n<pre>${escapeHtml(json)}</pre>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
  }
}

async function downloadByFileId(
  ctx: Context,
  env: Env,
  fileId: string,
  showLoading: boolean
): Promise<string | null> {
  let loadingId: number | null = null;
  if (showLoading) {
    const m = await ctx.reply('📥 Ambil dari Telegram...');
    loadingId = m.message_id;
  }

  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) throw new Error('no file_path');

    const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    let text = await res.text();
    if (text.length > MAX_FILE_CHARS) text = text.slice(0, MAX_FILE_CHARS);

    if (loadingId) {
      await ctx.api.deleteMessage(ctx.chat!.id, loadingId).catch(() => {});
    }
    return text;
  } catch (err: any) {
    const msg = err?.message ?? 'unknown';
    console.error('[Decode] download failed:', msg);
    if (loadingId) {
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loadingId,
          `❌ Gagal ambil file dari Telegram: <code>${escapeHtml(msg)}</code>\n\n` +
            `<i>File mungkin sudah dihapus. Upload ulang ya.</i>`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    } else {
      await ctx.reply(`❌ Gagal ambil file: <code>${escapeHtml(msg)}</code>`, {
        parse_mode: 'HTML',
      });
    }
    return null;
  }
}

async function downloadDocText(
  ctx: Context,
  env: Env
): Promise<{ text: string; fileId: string; filename: string } | null> {
  const doc = ctx.message?.document ?? ctx.message?.reply_to_message?.document;
  if (!doc) return null;

  const size = doc.file_size ?? 0;
  if (size > MAX_FILE_BYTES) {
    await ctx.reply(
      `❌ File terlalu besar: <b>${(size / 1024).toFixed(0)} KB</b> (max ${
        MAX_FILE_BYTES / 1024 / 1024
      } MB).\n\n<i>Potong dulu HTML-nya.</i>`,
      { parse_mode: 'HTML' }
    );
    return null;
  }

  const name = doc.file_name ?? '';
  const mime = doc.mime_type ?? '';
  const ok =
    /\.(html?|txt|json|js|css)$/i.test(name) ||
    /^text\/|json|javascript/i.test(mime);
  if (!ok) {
    await ctx.reply(
      `❌ Tipe tidak didukung: <code>${escapeHtml(name || mime)}</code>`,
      { parse_mode: 'HTML' }
    );
    return null;
  }

  const loading = await ctx.reply('📥 Download file...');
  try {
    const file = await ctx.api.getFile(doc.file_id);
    if (!file.file_path) throw new Error('no file_path');

    const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    let text = await res.text();
    if (text.length > MAX_FILE_CHARS) text = text.slice(0, MAX_FILE_CHARS);
    await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
    return { text, fileId: doc.file_id, filename: name || 'unnamed' };
  } catch (err: any) {
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Error download: ${escapeHtml(err?.message ?? 'unknown')}`
      )
      .catch(() => {});
    return null;
  }
}

export async function handleDocumentAuto(ctx: Context, env: Env): Promise<void> {
  const result = await downloadDocText(ctx, env);
  if (!result) return;

  const { text, fileId, filename } = result;
  const sourceType: 'base64' | 'html' = looksLikeHtml(text) ? 'html' : 'base64';

  const loading = await ctx.reply('🌐 Proses...');
  try {
    const processed = decodeInput(text, sourceType);
    if (!processed) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        '❌ Tidak ada URL video yang bisa diekstrak.'
      );
      return;
    }

    const { videos, labels } = processed;
    const label = slugifyLabel(filename);
    const { replaced } = await saveFileRef(env.DB, label, filename, fileId);

    await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});

    await ctx.reply(
      replaced
        ? `♻️ Update: <code>${escapeHtml(label)}</code>`
        : `💾 Tersimpan: <code>${escapeHtml(label)}</code>`,
      { parse_mode: 'HTML' }
    );

    await sendResult(ctx, env, videos, label, labels, filename);

    await ctx.reply(`💡 Akses lagi: <code>/decode ${escapeHtml(label)}</code>`, {
      parse_mode: 'HTML',
    });
  } catch (err: any) {
    console.error('[Decode] auto error:', err);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Error: ${escapeHtml(err?.message ?? 'unknown')}`
      )
      .catch(() => {});
  }
}

async function handleUrlAuto(ctx: Context, env: Env, url: string): Promise<void> {
  const loading = await ctx.reply(`🌐 Fetch URL:\n<code>${escapeHtml(url)}</code>`, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });

  try {
    const { body: html, debug } = await fetchUrlViaProxy(env, url);

    if (!html) {
      const debugLines = [
        '❌ Gagal fetch URL.',
        '',
        '<b>🔍 Debug Info:</b>',
        `proxyUrl: <code>${escapeHtml(debug.proxyUrl)}</code>`,
        `HTTP status: <code>${debug.httpStatus}</code>`,
        `Content-Type: <code>${escapeHtml(debug.contentType || '-')}</code>`,
        `Body length: <code>${debug.rawLength}</code>`,
        `JSON parse: <code>${debug.parseOk ? 'ok' : 'fail'}</code>`,
        debug.error ? `Error: <code>${escapeHtml(debug.error)}</code>` : '',
        '',
        '<b>Raw preview (200 char pertama):</b>',
        `<pre>${escapeHtml(debug.rawPreview || '(kosong)')}</pre>`,
      ].filter(Boolean);

      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        debugLines.join('\n'),
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    const sourceType: 'base64' | 'html' = looksLikeHtml(html) ? 'html' : 'base64';
    const processed = decodeInput(html, sourceType);

    if (!processed) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Tidak ada URL video yang bisa diekstrak.\n\n<i>Panjang HTML: ${html.length} char</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});

    const urlSlug = slugifyLabel(url.split('/').filter(Boolean).pop() ?? 'url');

    await sendResult(ctx, env, processed.videos, urlSlug, processed.labels, urlSlug);
  } catch (err: any) {
    console.error('[Decode] url error:', err);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Error: ${escapeHtml(err?.message ?? 'unknown')}`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  }
}

async function handleBatch(ctx: Context, env: Env): Promise<void> {
  const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';

  if (!arg) {
    await ctx.reply(
      '<b>📦 Batch Decode</b>\n\n' +
        '<b>Usage:</b>\n' +
        '<code>/batch &lt;url&gt; &lt;start&gt;-&lt;end&gt;</code>\n\n' +
        '<b>Contoh 1 (base URL):</b>\n' +
        '<code>/batch https://lexanime.web.id/tonton/yozakura-san-chi-no-daisakusen-season-2/ 1-6</code>\n\n' +
        '<b>Contoh 2 (pakai placeholder):</b>\n' +
        '<code>/batch https://lexanime.web.id/tonton/yozakura-san-chi-no-daisakusen-season-2/episode-{n}-sub-indo 1-6</code>\n\n' +
        '<b>Contoh 3 (URL episode existing):</b>\n' +
        '<code>/batch https://lexanime.web.id/tonton/yozakura-san-chi-no-daisakusen-season-2/episode-6-sub-indo 7-12</code>\n\n' +
        `<i>Max ${BATCH_MAX} episode per batch. Bisa ditambah pakai ➕ Tambah Batch.</i>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  const m = arg.match(/^(\S+)\s+(\d+)\s*-\s*(\d+)\s*$/);
  if (!m) {
    await ctx.reply(
      '❌ Format salah.\n\n' +
        'Usage: <code>/batch &lt;url&gt; &lt;start&gt;-&lt;end&gt;</code>\n' +
        'Contoh: <code>/batch https://lexanime.web.id/tonton/yozakura-san-chi-no-daisakusen-season-2/ 1-6</code>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const input = m[1] ?? '';
  const start = parseInt(m[2] ?? '0', 10);
  const end = parseInt(m[3] ?? '0', 10);

  if (start < 1 || end < start) {
    await ctx.reply('❌ Range tidak valid. Contoh: <code>1-6</code>', {
      parse_mode: 'HTML',
    });
    return;
  }

  const total = end - start + 1;
  if (total > BATCH_MAX) {
    await ctx.reply(
      `❌ Max ${BATCH_MAX} episode per batch (kamu minta ${total}).\n\n` +
        `<i>Kirim 2x, contoh:</i>\n` +
        `<code>/batch ${input} ${start}-${start + BATCH_MAX - 1}</code>\n` +
        `<code>/batch ${input} ${start + BATCH_MAX}-${end}</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const urls = buildBatchUrls(input, start, end);

  const loading = await ctx.reply(
    `📦 <b>Batch ${total} episode</b> (${start}-${end})\n\n⏳ Memulai...`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
  );

  const results: EpisodeObject[] = [];
  const errors: { number: number; error: string }[] = [];

  for (let i = 0; i < urls.length; i++) {
    const n = start + i;
    const url = urls[i]!;

    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `📦 <b>Batch ${total} episode</b> (${start}-${end})\n\n` +
          `⏳ [${i + 1}/${total}] Episode ${n}...\n` +
          `<code>${escapeHtml(url)}</code>`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
    } catch {}

    const { body, debug } = await fetchUrlViaProxy(env, url);
    if (!body) {
      errors.push({ number: n, error: debug.error ?? 'fetch failed' });
      continue;
    }

    const sourceType: 'base64' | 'html' = looksLikeHtml(body) ? 'html' : 'base64';
    const processed = decodeInput(body, sourceType);
    if (!processed) {
      errors.push({ number: n, error: `no video URLs (${body.length} char)` });
      continue;
    }

    results.push(buildEpisodeObject(processed.videos, n));
  }

  results.sort((a, b) => a.number - b.number);

  await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});

  if (results.length === 0) {
    await ctx.reply(
      `❌ Tidak ada episode yang berhasil di-fetch.\n\n` +
        (errors.length > 0
          ? `<b>Error:</b>\n` +
            errors
              .slice(0, 5)
              .map((e) => `• Ep ${e.number}: <code>${escapeHtml(e.error)}</code>`)
              .join('\n')
          : ''),
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (!ctx.from?.id) return;

  const slugHint = extractSlugHint(input);

  try {
    const result = await startOrAppendBatch(env.DB, ctx.from.id, {
      slugHint,
      newEpisodes: results,
      errors: errors.map((e) => `Ep ${e.number}: ${e.error}`),
    });

    const kb = new InlineKeyboard()
      .text('➕ Tambah Batch', `pub:baadd:${result.sessionId}`)
      .text('📤 Publish', `pub:ba:${result.sessionId}`)
      .row()
      .text('❌ Batal', `pub:bax:${result.sessionId}`);

    const lines: string[] = [];
    lines.push(`✅ <b>Batch ${start}-${end} selesai</b>`);
    lines.push('');

    if (slugHint) lines.push(`🎬 <code>${escapeHtml(slugHint)}</code>`);

    if (result.mode === 'reset_and_created') {
      lines.push(`⚠️ <i>Session lama di-reset (slug berbeda).</i>`);
    }

    lines.push(
      `📦 Episode terkumpul: <b>${result.totalEpisodes}</b> (Ep ${result.minEp}-${result.maxEp})`
    );
    lines.push(`🎬 Total URL: <b>${result.totalUrls}</b>`);

    if (result.skipped.length > 0) {
      lines.push('');
      lines.push(`⏭️ Skip (sudah ada): Ep ${result.skipped.join(', ')}`);
      if (result.added.length > 0) {
        lines.push(`➕ Baru: Ep ${result.added.join(', ')}`);
      }
    }

    if (errors.length > 0) {
      lines.push('');
      lines.push(`⚠️ Gagal: ${errors.length} episode`);
      for (const e of errors.slice(0, 3)) {
        lines.push(`   • Ep ${e.number}: ${escapeHtml(e.error.slice(0, 40))}`);
      }
      if (errors.length > 3) {
        lines.push(`   <i>...dan ${errors.length - 3} lainnya</i>`);
      }
    }

    lines.push('');
    lines.push(`🆔 <code>${result.sessionId}</code>`);

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
    });
  } catch (err: any) {
    console.error('[Batch] save session error:', err);
    await ctx.reply(
      `❌ Gagal simpan session: <code>${escapeHtml(err?.message ?? 'unknown')}</code>`,
      { parse_mode: 'HTML' }
    );
  }
}

// =================================================================
// COMMANDS
// =================================================================

export const decodeCommand: CommandDefinition = {
  name: 'decode',
  description: 'Decode HTML/Base64 atau buka tersimpan',
  usage: '/decode <base64|html|label>',
  adminOnly: true,

  handler: async (ctx, env) => {
    const doc = ctx.message?.document ?? ctx.message?.reply_to_message?.document;
    if (doc) {
      await handleDocumentAuto(ctx, env);
      return;
    }

    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const replied = ctx.message?.reply_to_message?.text ?? '';
    const input = arg || replied;

    if (!input) {
      await ctx.reply(
        '<b>🔓 Decode</b>\n\n' +
          '<b>Kirim file</b> <code>.html</code> / <code>.txt</code> → auto proses + simpan\n' +
          '<b>One-shot:</b> <code>/decode &lt;base64&gt;</code>\n' +
          '<b>Buka tersimpan:</b> <code>/decode &lt;label&gt;</code>\n' +
          '<b>Batch:</b> <code>/batch &lt;url&gt; &lt;start&gt;-&lt;end&gt;</code>\n' +
          '<b>List:</b> <code>/list</code>\n' +
          '<b>Hapus:</b> <code>/delete &lt;label&gt;</code>',
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    if (!looksLikeHtml(input) && !isLikelyBase64(input) && input.length < 60) {
      const ref = await getFileRef(env.DB, input);
      if (ref) {
        const text = await downloadByFileId(ctx, env, ref.file_id, true);
        if (!text) return;

        const sourceType: 'base64' | 'html' = looksLikeHtml(text) ? 'html' : 'base64';
        const loading = await ctx.reply('🌐 Proses...');
        try {
          const processed = decodeInput(text, sourceType);
          if (!processed) {
            await ctx.api.editMessageText(
              ctx.chat!.id,
              loading.message_id,
              '❌ Tidak ada URL video yang bisa diekstrak.'
            );
            return;
          }
          await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
          await sendResult(
            ctx,
            env,
            processed.videos,
            ref.label,
            processed.labels,
            ref.filename
          );
        } catch (err: any) {
          await ctx.api
            .editMessageText(
              ctx.chat!.id,
              loading.message_id,
              `❌ Error: ${escapeHtml(err?.message ?? 'unknown')}`
            )
            .catch(() => {});
        }
        return;
      }
    }

    if (/^https?:\/\//i.test(input)) {
      await handleUrlAuto(ctx, env, input);
      return;
    }

    if (input.length > MAX_INPUT_LEN) {
      await ctx.reply(
        `❌ Terlalu panjang: ${input.length} char. Kirim sebagai file.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const sourceType: 'base64' | 'html' = looksLikeHtml(input) ? 'html' : 'base64';
    const loading = await ctx.reply('🔓 Proses...');
    try {
      const processed = decodeInput(input, sourceType);
      if (!processed) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          loading.message_id,
          '❌ Tidak ada URL video yang bisa diekstrak.'
        );
        return;
      }
      await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => {});
      await sendResult(ctx, env, processed.videos, undefined, processed.labels, null);
    } catch (err: any) {
      console.error('[Decode] error:', err);
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ Error: ${escapeHtml(err?.message ?? 'unknown')}`
        )
        .catch(() => {});
    }
  },
};

export const batchCommand: CommandDefinition = {
  name: 'batch',
  description: 'Decode batch episode (range)',
  usage: '/batch <url> <start>-<end>',
  adminOnly: true,
  handler: handleBatch,
};

export const listCommand: CommandDefinition = {
  name: 'list',
  description: 'Lihat file referensi tersimpan',
  usage: '/list',
  adminOnly: true,

  handler: async (ctx, env) => {
    const rows = await listFileRefs(env.DB, 30);
    if (rows.length === 0) {
      await ctx.reply(
        '📭 Belum ada file tersimpan.\n\n<i>Kirim file .html/.txt ke bot untuk mulai.</i>',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const lines: string[] = [];
    lines.push(`📚 <b>File Tersimpan (${rows.length})</b>\n`);
    for (const r of rows) {
      const days = Math.floor((Date.now() - r.last_accessed) / 86400000);
      const age =
        days === 0
          ? 'hari ini'
          : days === 1
            ? '1 hari lalu'
            : `${days} hari lalu`;
      const fname = r.filename ? ` — <i>${escapeHtml(r.filename)}</i>` : '';
      lines.push(`• <code>${escapeHtml(r.label)}</code>${fname} — <i>${age}</i>`);
    }
    lines.push('');
    lines.push('<i>Buka ulang: <code>/decode &lt;label&gt;</code></i>');

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  },
};

export const deleteCommand: CommandDefinition = {
  name: 'delete',
  description: 'Hapus referensi file',
  usage: '/delete <label>',
  adminOnly: true,

  handler: async (ctx, env) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (!arg) {
      await ctx.reply('Usage: <code>/delete &lt;label&gt;</code>', {
        parse_mode: 'HTML',
      });
      return;
    }

    const ok = await deleteFileRef(env.DB, arg);
    if (ok) {
      await ctx.reply(
        `✅ <code>${escapeHtml(arg)}</code> dihapus dari DB.\n\n<i>File HTML di Telegram tetap ada.</i>`,
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.reply(`❌ Tidak ada: <code>${escapeHtml(arg)}</code>`, {
        parse_mode: 'HTML',
      });
    }
  },
};