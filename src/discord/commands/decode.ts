// src/discord/commands/decode.ts
import type { Env } from '../../types/env';
import type { DiscordInteraction } from '../handler';
import {
  MAX_INPUT_LEN,
  looksLikeHtml,
  decodeInput,
  buildEpisodeJson,
  parseEpisodeNumber,
  groupByResolution,
  rankResolution,
  type ResolvedEntry,
} from '../../services/decode-core';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const DISCORD_MSG_LIMIT = 1900;
const JSON_INLINE_THRESHOLD = 1800;

function buildUrlList(items: ResolvedEntry[]): string {
  const lines: string[] = [];
  lines.push(`🎬 **${items.length} URL Video**\n`);

  const byRes = groupByResolution(items);
  const sortedKeys = [...byRes.keys()].sort(
    (a, b) => rankResolution(b) - rankResolution(a)
  );

  let n = 1;
  for (const key of sortedKeys) {
    lines.push(`**${key}**`);
    for (const it of byRes.get(key)!) {
      lines.push(`${n}. ${it.url}`);
      n++;
    }
    lines.push('');
  }
  return lines.join('\n');
}

function splitMessage(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const parts: string[] = [];
  let current = '';
  for (const line of s.split('\n')) {
    if (current.length + line.length + 1 > max && current.length > 0) {
      parts.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

const DISCORD_API = 'https://discord.com/api/v10';

async function editOriginal(
  appId: string,
  token: string,
  body: Record<string, unknown>
): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${appId}/${token}/messages/@original`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(
      '[Discord/Decode] editOriginal failed:',
      res.status,
      err.slice(0, 200)
    );
  }
}

async function sendFollowup(
  appId: string,
  token: string,
  body: Record<string, unknown>
): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${appId}/${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(
      '[Discord/Decode] followup failed:',
      res.status,
      err.slice(0, 200)
    );
  }
}

async function sendFollowupFile(
  appId: string,
  token: string,
  filename: string,
  content: string,
  caption: string
): Promise<void> {
  const boundary = '----WebKit' + crypto.randomUUID().replace(/-/g, '');
  const payload = JSON.stringify({ content: caption });

  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="payload_json"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${payload}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="files[0]"; filename="${filename}"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--\r\n`;

  const url = `${DISCORD_API}/webhooks/${appId}/${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(
      '[Discord/Decode] file upload failed:',
      res.status,
      err.slice(0, 200)
    );
  }
}

export function handleDecode(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext
): Response {
  ctx.waitUntil(processDecode(interaction, env));
  return new Response(JSON.stringify({ type: 5 }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function processDecode(
  interaction: DiscordInteraction,
  env: Env
): Promise<void> {
  const appId = interaction.application_id ?? env.DISCORD_APP_ID;
  const token = interaction.token;

  const fileOpt = interaction.data?.options?.find((o) => o.name === 'file');
  const inputOpt = interaction.data?.options?.find((o) => o.name === 'input');

  let text = '';
  let sourceFilename: string | null = null;

  if (fileOpt) {
    const attachmentId = fileOpt.value as string;
    const attachment = interaction.data?.resolved?.attachments?.[attachmentId];

    if (!attachment) {
      await editOriginal(appId, token, {
        content: '❌ File tidak ditemukan di payload.',
      });
      return;
    }

    if (attachment.size > MAX_FILE_BYTES) {
      await editOriginal(appId, token, {
        content: `❌ File terlalu besar: **${(attachment.size / 1024).toFixed(0)} KB** (max ${
          MAX_FILE_BYTES / 1024 / 1024
        } MB).`,
      });
      return;
    }

    try {
      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
      sourceFilename = attachment.filename;
      console.log(
        `[Discord/Decode] downloaded ${text.length} chars from ${attachment.filename}`
      );
    } catch (err: any) {
      await editOriginal(appId, token, {
        content: `❌ Gagal download file: ${(err?.message ?? 'unknown').slice(0, 200)}`,
      });
      return;
    }
  } else if (inputOpt) {
    text = String(inputOpt.value ?? '').trim();
  }

  if (!text) {
    await editOriginal(appId, token, {
      content:
        '❌ Tidak ada input.\n\n' +
        'Kirim file via option `file`, atau paste Base64/HTML via option `input`.',
    });
    return;
  }

  if (text.length > MAX_INPUT_LEN && !fileOpt) {
    await editOriginal(appId, token, {
      content: `❌ Input terlalu panjang: **${text.length}** char (max ${MAX_INPUT_LEN}). Gunakan option \`file\`.`,
    });
    return;
  }

  const sourceType: 'base64' | 'html' = looksLikeHtml(text) ? 'html' : 'base64';

  try {
    const processed = decodeInput(text, sourceType);

    if (!processed) {
      await editOriginal(appId, token, {
        content: '❌ Tidak ada URL video yang bisa diekstrak.',
      });
      return;
    }

    const { videos, labels } = processed;

    await editOriginal(appId, token, {
      content: `✅ Ditemukan **${videos.length}** URL video. Mengirim hasil...`,
    });

    const urlList = buildUrlList(videos);
    const urlParts = splitMessage(urlList, DISCORD_MSG_LIMIT);

    for (let i = 0; i < urlParts.length; i++) {
      const header =
        urlParts.length > 1
          ? `📄 **Part ${i + 1}/${urlParts.length}**\n\n`
          : '';
      await sendFollowup(appId, token, { content: header + urlParts[i] });
    }

    const episodeNumber = parseEpisodeNumber(sourceFilename, labels);
    const json = buildEpisodeJson(videos, episodeNumber);

    console.log(
      `[Discord/Decode] episode number detected: ${episodeNumber} (json len: ${json.length})`
    );

    const targetPath = `src/data/anime/{slug}/episodes/${episodeNumber}.json`;

    if (json.length <= JSON_INLINE_THRESHOLD) {
      await sendFollowup(appId, token, {
        content:
          `📋 **Episode ${episodeNumber}**\n` +
          `_Save ke \`${targetPath}\`_\n\n` +
          '```json\n' +
          json +
          '\n```',
      });
    } else {
      const filename = `ep-${episodeNumber}.json`;
      const caption =
        `📋 **Episode ${episodeNumber}**\n` +
        `_Rename & save ke \`${targetPath}\`_`;

      await sendFollowupFile(appId, token, filename, json, caption);
    }
  } catch (err: any) {
    console.error('[Discord/Decode] error:', err);
    await editOriginal(appId, token, {
      content: `❌ Gagal: ${(err?.message ?? 'unknown').slice(0, 200)}`,
    });
  }
}