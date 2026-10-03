import type { Env } from '../../types/env';
import type { DiscordInteraction } from '../handler';

const MAX_INPUT_LEN = 6000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LAYERS = 5;
const MAX_CANDIDATES = 800;
const MAX_PARAM_DEPTH = 3;
const DISCORD_MSG_LIMIT = 1900;

const BASE64_PARAM_NAMES = new Set([
  'bsrc', 'src', 'url', 'link', 'u', 'q', 'data',
  'em', 'embed', 'target', 'id', 'file', 'video',
]);

const VIDEO_EXT_RE = /\.(mp4|m3u8|mkv|webm|ts|mov)(\?|#|$)/i;
const VIDEO_HOSTS = [
  'player.', 'streamtape', 'dood', 'filemoon', 'voe', 'mp4upload',
  'mixdrop', 'iixdrop', 'abyss', 'abyssplayer',
  'framezi', 'kturbo',
  'pixeldrain', 'vikingfile', 'buzzheavier', 'mega.nz', 'doply',
];

const WRAPPER_HOSTS = ['animesail.xyz', '154999000.xyz'];

const SERVER_ALIASES: Record<string, string> = {
  abyss: 'abyss', dodo: 'doply', doply: 'doply',
  pixel: 'pixeldrain', pixeldrain: 'pixeldrain',
  viking: 'vikingfile', vikingfile: 'vikingfile',
  mix: 'mixdrop', mixdrop: 'mixdrop',
  buzi: 'buzzheavier', buzzheavier: 'buzzheavier',
  mp4: 'mp4upload', mp4upload: 'mp4upload',
  mega: 'mega', lokal: 'lokal', kamado: 'kamado', pancal: 'pancal',
};

interface RawEntry {
  base64: string;
  label: string | null;
}

interface ResolvedEntry {
  url: string;
  resolution: string | null;
  server: string | null;
}

function normalizeBase64(input: string): string | null {
  let b64 = input.trim().replace(/\s+/g, '');
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const mod = b64.length % 4;
  if (mod === 1) return null;
  if (mod === 2) b64 += '==';
  else if (mod === 3) b64 += '=';
  return b64;
}

function decodeBase64(input: string): string | null {
  const b64 = normalizeBase64(input);
  if (!b64) return null;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function htmlDecode(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&#0?38;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

function isLikelyBase64(s: string): boolean {
  const t = s.trim().replace(/\s+/g, '');
  if (t.length < 12 || t.length > MAX_INPUT_LEN * 2) return false;
  return /^[A-Za-z0-9+/\-_]+=*$/.test(t);
}

function isPrintable(s: string): boolean {
  if (s.length === 0) return false;
  let bad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0xfffd) bad++;
    else if (c < 32 && c !== 9 && c !== 10 && c !== 13) bad++;
  }
  return bad / s.length < 0.05;
}

function looksLikeHtml(s: string): boolean {
  if (s.length < 30) return false;
  return (
    /<!DOCTYPE/i.test(s) || /<html[\s>]/i.test(s) || /<script[\s>]/i.test(s) ||
    /<iframe[\s>]/i.test(s) || /<\/?[a-z][a-z0-9-]*[\s>]/i.test(s)
  );
}

function isVideoUrl(url: string): boolean {
  if (VIDEO_EXT_RE.test(url)) return true;
  const lower = url.toLowerCase();
  return VIDEO_HOSTS.some((h) => lower.includes(h));
}

function isWrapper(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return WRAPPER_HOSTS.some((w) => h === w || h.endsWith('.' + w));
  } catch {
    return false;
  }
}

function parseResolution(label: string | null): string | null {
  if (!label) return null;
  const m = label.match(/\b(\d{3,4})p\b/i);
  return m && m[1] ? `${m[1]}p` : null;
}

function parseServerName(label: string | null): string | null {
  if (!label) return null;
  const cleaned = label.toLowerCase().replace(/\s+\d{3,4}p\s*$/i, '').trim();
  if (!cleaned) return null;
  return SERVER_ALIASES[cleaned] ?? cleaned;
}

function resolutionRank(r: string | null): number {
  if (!r || r === 'Lainnya' || r === 'Unknown') return -1;
  const n = parseInt(r.replace(/p$/i, ''), 10);
  return isNaN(n) ? -1 : n;
}

function extractUrlsFromDecoded(s: string): string[] {
  const found = new Set<string>();
  const cleaned = htmlDecode(s);
  const trimmed = cleaned.trim();
  if (/^https?:\/\/[^\s]+$/i.test(trimmed)) {
    found.add(trimmed);
    return [...found];
  }

  for (const m of cleaned.matchAll(/<iframe\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)) {
    const u = htmlDecode(m[1] ?? '');
    if (/^https?:\/\//i.test(u)) found.add(u);
  }
  if (found.size === 0) {
    for (const m of cleaned.matchAll(/src\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
      const u = htmlDecode(m[1] ?? '');
      if (u) found.add(u);
    }
  }
  if (found.size === 0) {
    for (const m of cleaned.matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
      const u = htmlDecode(m[1] ?? '');
      if (u) found.add(u);
    }
  }
  if (found.size === 0) {
    for (const m of cleaned.matchAll(/https?:\/\/[^\s"'<>()\\]+/g)) {
      const u = htmlDecode(m[0]);
      if (u) found.add(u);
    }
  }
  return [...found];
}

function expandUrlParams(url: string, depth = 0): string[] {
  const out = new Set<string>([url]);
  if (depth > MAX_PARAM_DEPTH) return [...out];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [...out];
  }

  for (const [key, value] of parsed.searchParams.entries()) {
    if (!value || value.length < 12) continue;
    if (!BASE64_PARAM_NAMES.has(key.toLowerCase())) continue;

    if (/^https?:\/\//i.test(value)) {
      for (const sub of expandUrlParams(value, depth + 1)) out.add(sub);
      continue;
    }
    if (/^https?%3A/i.test(value)) {
      try {
        const dec = decodeURIComponent(value);
        if (/^https?:\/\//i.test(dec)) {
          for (const sub of expandUrlParams(dec, depth + 1)) out.add(sub);
        }
      } catch {}
    }
    if (isLikelyBase64(value)) {
      const decoded = decodeBase64(value);
      if (decoded && isPrintable(decoded)) {
        const trimmed = decoded.trim();
        if (/^https?:\/\//i.test(trimmed)) {
          for (const sub of expandUrlParams(trimmed, depth + 1)) out.add(sub);
        }
      }
    }
  }
  return [...out];
}

interface DecodeResult {
  output: string;
  layers: number;
  urls: string[];
}

function multiLayerDecode(input: string): DecodeResult | null {
  if (!isLikelyBase64(input)) return null;
  let current = input.trim();
  let layers = 0;
  for (let i = 0; i < MAX_LAYERS; i++) {
    const decoded = decodeBase64(current);
    if (decoded === null || decoded === current) break;
    if (!isPrintable(decoded)) break;
    current = decoded;
    layers++;
    const urls = extractUrlsFromDecoded(current);
    if (urls.length > 0) break;
    if (!isLikelyBase64(current)) break;
  }
  if (layers === 0) return null;
  return { output: current, layers, urls: extractUrlsFromDecoded(current) };
}

function extractEntries(html: string): RawEntry[] {
  const entries: RawEntry[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(
    /<option\b[^>]*?\bdata-[a-z0-9-]+\s*=\s*["']([A-Za-z0-9+/=\-_]{20,})["'][^>]*?>([^<]*)<\/option>/gi
  )) {
    const b64 = m[1];
    const label = (m[2] ?? '').trim();
    if (!b64 || seen.has(b64)) continue;
    seen.add(b64);
    entries.push({ base64: b64, label: label || null });
  }

  for (const m of html.matchAll(/atob\s*\(\s*["']([A-Za-z0-9+/=\-_]{16,})["']\s*\)/gi)) {
    const b64 = m[1];
    if (!b64 || seen.has(b64)) continue;
    seen.add(b64);
    entries.push({ base64: b64, label: null });
  }

  for (const m of html.matchAll(/[A-Za-z0-9+/\-_]{24,}={0,2}/g)) {
    if (entries.length >= MAX_CANDIDATES) break;
    const b64 = m[0];
    if (!b64 || seen.has(b64)) continue;
    seen.add(b64);
    entries.push({ base64: b64, label: null });
  }

  return entries;
}

function collectResolvedVideos(entries: RawEntry[]): ResolvedEntry[] {
  const resolved = new Map<string, { resolution: string | null; server: string | null }>();
  const unresolved = new Map<string, { resolution: string | null; server: string | null }>();

  function resolve(url: string, resolution: string | null, server: string | null, depth: number, seen: Set<string>): void {
    if (depth > 4 || seen.has(url)) return;
    seen.add(url);
    const children = expandUrlParams(url).filter((u) => u !== url);
    if (isWrapper(url)) {
      if (children.length === 0) {
        if (!resolved.has(url) && !unresolved.has(url)) unresolved.set(url, { resolution, server });
      } else {
        for (const c of children) resolve(c, resolution, server, depth + 1, seen);
      }
      return;
    }
    if (!resolved.has(url)) resolved.set(url, { resolution, server });
    for (const c of children) resolve(c, resolution, server, depth + 1, seen);
  }

  for (const e of entries) {
    const dec = multiLayerDecode(e.base64);
    if (!dec || dec.urls.length === 0) continue;
    const resolution = parseResolution(e.label);
    const server = parseServerName(e.label);
    for (const url of dec.urls) resolve(url, resolution, server, 0, new Set());
  }

  const final: ResolvedEntry[] = [];
  for (const [url, info] of resolved) {
    if (isVideoUrl(url)) final.push({ url, resolution: info.resolution, server: info.server });
  }
  if (final.length === 0) {
    for (const [url, info] of unresolved) final.push({ url, resolution: info.resolution, server: info.server });
  }
  final.sort((a, b) => {
    const ra = resolutionRank(a.resolution);
    const rb = resolutionRank(b.resolution);
    if (ra !== rb) return rb - ra;
    return a.url.length - b.url.length;
  });
  return final;
}

function buildYaml(items: ResolvedEntry[]): string {
  const byQuality = new Map<string, { name: string; url: string }[]>();
  for (const item of items) {
    const q = item.resolution ?? 'Unknown';
    if (!byQuality.has(q)) byQuality.set(q, []);
    byQuality.get(q)!.push({ name: item.server ?? 'unknown', url: item.url });
  }
  const qualities = [...byQuality.keys()].sort((a, b) => resolutionRank(b) - resolutionRank(a));

  const lines: string[] = [];
  lines.push('episodes:');
  lines.push('  - number: 1');
  lines.push('    streams:');
  for (const q of qualities) {
    lines.push(`      - quality: "${q}"`);
    lines.push('        servers:');
    for (const s of byQuality.get(q)!) {
      lines.push(`          - name: "${s.name}"`);
      lines.push(`            url: "${s.url}"`);
    }
  }
  return lines.join('\n');
}

function buildUrlList(items: ResolvedEntry[]): string {
  const lines: string[] = [];
  lines.push(`🎬 **${items.length} URL Video**\n`);

  const byRes = new Map<string, ResolvedEntry[]>();
  for (const it of items) {
    const key = it.resolution ?? 'Lainnya';
    if (!byRes.has(key)) byRes.set(key, []);
    byRes.get(key)!.push(it);
  }
  const sortedKeys = [...byRes.keys()].sort((a, b) => resolutionRank(b) - resolutionRank(a));

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
    console.error('[Discord/Decode] editOriginal failed:', res.status, err.slice(0, 200));
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
    console.error('[Discord/Decode] followup failed:', res.status, err.slice(0, 200));
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
    `Content-Type: text/plain\r\n\r\n` +
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
    console.error('[Discord/Decode] file upload failed:', res.status, err.slice(0, 200));
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

  if (fileOpt) {
    const attachmentId = fileOpt.value as string;
    const attachment =
      interaction.data?.resolved?.attachments?.[attachmentId];

    if (!attachment) {
      await editOriginal(appId, token, {
        content: '❌ File tidak ditemukan di payload.',
      });
      return;
    }

    if (attachment.size > MAX_FILE_BYTES) {
      await editOriginal(appId, token, {
        content: `❌ File terlalu besar: **${(attachment.size / 1024).toFixed(0)} KB** (max ${MAX_FILE_BYTES / 1024 / 1024} MB).`,
      });
      return;
    }

    try {
      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
      console.log(`[Discord/Decode] downloaded ${text.length} chars`);
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
    const entries = sourceType === 'html'
      ? extractEntries(text)
      : [{ base64: text, label: null }];

    if (entries.length === 0) {
      await editOriginal(appId, token, {
        content: '❌ Tidak ada Base64 yang ditemukan di input.',
      });
      return;
    }

    const videos = collectResolvedVideos(entries);

    if (videos.length === 0) {
      await editOriginal(appId, token, {
        content: `❌ Tidak ada URL video.\n\nDari **${entries.length}** kandidat Base64, tidak ada URL video valid.`,
      });
      return;
    }

    await editOriginal(appId, token, {
      content: `✅ Ditemukan **${videos.length}** URL video. Mengirim hasil...`,
    });

    const urlList = buildUrlList(videos);
    const urlParts = splitMessage(urlList, DISCORD_MSG_LIMIT);

    for (let i = 0; i < urlParts.length; i++) {
      const header = urlParts.length > 1 ? `📄 **Part ${i + 1}/${urlParts.length}**\n\n` : '';
      await sendFollowup(appId, token, { content: header + urlParts[i] });
    }

    const yaml = buildYaml(videos);
    if (yaml.length <= 1700) {
      await sendFollowup(appId, token, {
        content: `📋 **YAML**\n\n\`\`\`yaml\n${yaml}\n\`\`\``,
      });
    } else {
      await sendFollowupFile(appId, token, 'streams.yaml', yaml, '📋 **YAML Streams**');
    }
  } catch (err: any) {
    console.error('[Discord/Decode] error:', err);
    await editOriginal(appId, token, {
      content: `❌ Gagal: ${(err?.message ?? 'unknown').slice(0, 200)}`,
    });
  }
}