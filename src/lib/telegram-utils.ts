// src/lib/telegram-utils.ts
import type { Context, Api } from 'grammy';
import type { D1Database } from '@cloudflare/workers-types';
import { escapeHtml } from './utils';

export const MSG_LIMIT = 3500;
export const BATCH_OVERHEAD = 300;
export const AUTO_DELETE_DELAY_MS = 3000;

export function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];

  const parts: string[] = [];
  let current = '';

  for (const line of text.split('\n')) {
    if (line.length > max) {
      if (current) {
        parts.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += max) {
        const chunk = line.slice(i, i + max);
        if (i + max >= line.length) {
          current = chunk;
        } else {
          parts.push(chunk);
        }
      }
      continue;
    }

    const prospective = current ? `${current}\n${line}` : line;
    if (prospective.length > max && current.length > 0) {
      parts.push(current);
      current = line;
    } else {
      current = prospective;
    }
  }

  if (current) parts.push(current);
  return parts;
}

let trackDbReady = false;
let trackDbInitPromise: Promise<void> | null = null;

export async function ensureTrackDb(db: D1Database): Promise<void> {
  if (trackDbReady) return;
  if (trackDbInitPromise) return trackDbInitPromise;

  trackDbInitPromise = (async () => {
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS qimochi_messages (
            session_id  TEXT NOT NULL,
            message_id  INTEGER NOT NULL,
            created_at  INTEGER NOT NULL,
            PRIMARY KEY (session_id, message_id)
          )`
        )
        .run();
      trackDbReady = true;
    } catch (err) {
      console.error('[Track] DB init error:', err);
      trackDbInitPromise = null;
      throw err;
    }
  })();

  return trackDbInitPromise;
}

export type Tracker = (msgId: number) => Promise<void>;

export async function trackMessage(
  db: D1Database,
  sessionId: string,
  messageId: number
): Promise<void> {
  try {
    await ensureTrackDb(db);
    await db
      .prepare(
        `INSERT OR IGNORE INTO qimochi_messages
         (session_id, message_id, created_at)
         VALUES (?, ?, ?)`
      )
      .bind(sessionId, messageId, Date.now())
      .run();
  } catch (err) {
    console.warn('[Track] track error:', err);
  }
}

export async function getTrackedMessages(
  db: D1Database,
  sessionId: string
): Promise<number[]> {
  await ensureTrackDb(db);
  const res = await db
    .prepare(
      `SELECT message_id FROM qimochi_messages
       WHERE session_id = ? ORDER BY created_at ASC`
    )
    .bind(sessionId)
    .all<{ message_id: number }>();
  return (res.results ?? []).map((r) => r.message_id);
}

export async function deleteTrackedMessages(
  db: D1Database,
  sessionId: string
): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM qimochi_messages WHERE session_id = ?')
      .bind(sessionId)
      .run();
  } catch (err) {
    console.warn('[Track] delete error:', err);
  }
}

export async function clearTrackedSession(
  api: Api,
  db: D1Database,
  chatId: number,
  sessionId: string
): Promise<number> {
  const ids = await getTrackedMessages(db, sessionId);
  let deleted = 0;

  for (const msgId of ids) {
    try {
      await api.deleteMessage(chatId, msgId);
      deleted++;
    } catch (err: any) {
      const desc = err?.description ?? err?.message ?? String(err);
      console.warn(`[Track] delete msg ${msgId} failed: ${desc}`);
    }
  }

  await deleteTrackedMessages(db, sessionId);
  console.log(`[Track] cleared ${sessionId}: ${deleted}/${ids.length} deleted`);
  return deleted;
}

export async function sendTextSection(
  ctx: Context,
  label: string,
  content: string,
  tracker?: Tracker
): Promise<void> {
  const parts = splitText(content, MSG_LIMIT);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    const header =
      parts.length > 1
        ? `📋 <b>${escapeHtml(label)}</b> [${i + 1}/${parts.length}]\n\n`
        : `📋 <b>${escapeHtml(label)}</b>\n\n`;

    const msg = await ctx.reply(`${header}<pre>${escapeHtml(part)}</pre>`, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });

    if (tracker) await tracker(msg.message_id);

    if (i < parts.length - 1) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

export async function sendJsonSection<T>(
  ctx: Context,
  label: string,
  items: T[],
  tracker?: Tracker
): Promise<void> {
  if (items.length === 0) {
    await sendTextSection(ctx, label, '[]', tracker);
    return;
  }

  const fullJson = JSON.stringify(items, null, 2);

  if (fullJson.length <= MSG_LIMIT) {
    await sendTextSection(ctx, label, fullJson, tracker);
    return;
  }

  const budget = MSG_LIMIT - BATCH_OVERHEAD;
  const avgBytes = fullJson.length / items.length;
  const perBatch = Math.max(1, Math.floor(budget / avgBytes));
  const totalBatches = Math.ceil(items.length / perBatch);

  console.log(
    `[Send] JSON split "${label}": ${items.length} items, ~${Math.round(avgBytes)}B/item, ${perBatch}/batch, ${totalBatches} batches`
  );

  for (let i = 0; i < totalBatches; i++) {
    const start = i * perBatch;
    const end = Math.min(start + perBatch, items.length);
    const batch = items.slice(start, end);
    const batchJson = JSON.stringify(batch, null, 2);

    const header =
      `📋 <b>${escapeHtml(label)}</b> [${i + 1}/${totalBatches}]\n` +
      `<i>Item ${start + 1}-${end} dari ${items.length}</i>\n\n`;

    const msg = await ctx.reply(`${header}<pre>${escapeHtml(batchJson)}</pre>`, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });

    if (tracker) await tracker(msg.message_id);

    if (i < totalBatches - 1) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

export async function sendAutoDelete(
  ctx: Context,
  text: string,
  delayMs = AUTO_DELETE_DELAY_MS
): Promise<void> {
  try {
    const msg = await ctx.reply(text, { parse_mode: 'HTML' });
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    (async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        await ctx.api.deleteMessage(chatId, msg.message_id);
      } catch {}
    })();
  } catch (err) {
    console.warn('[Send] autoDelete failed:', err);
  }
}

export async function sendDocumentViaApi(
  botToken: string,
  chatId: number,
  filename: string,
  content: string,
  caption: string
): Promise<void> {
  const boundary =
    '----YukioSend' + Math.random().toString(36).slice(2, 12);

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
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `sendDocument HTTP ${res.status}: ${errText.slice(0, 200)}`
    );
  }
}