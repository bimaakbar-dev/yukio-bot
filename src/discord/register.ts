import type { Env } from '../types/env';

const COMMANDS = [
  {
    name: 'ping',
    description: 'Health check — cek bot masih hidup',
  },
  {
    name: 'anime',
    description: 'Cari metadata anime',
    options: [
      {
        name: 'query',
        description: 'Judul anime atau URL MyAnimeList',
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: 'decode',
    description: 'Decode Base64 atau HTML jadi URL',
    options: [
      {
        name: 'input',
        description: 'Base64 atau HTML',
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: 'ai',
    description: 'Chat dengan AI',
    options: [
      {
        name: 'prompt',
        description: 'Prompt untuk AI',
        type: 3,
        required: true,
      },
    ],
  },
];

export async function registerDiscordCommands(env: Env): Promise<Response> {
  const url = `https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}/commands`;

  console.log('[Discord] registering commands...');

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(COMMANDS),
  });

  const data = await res.json().catch(() => ({ error: 'invalid json' }));

  console.log(`[Discord] register status: ${res.status}`);

  return new Response(
    JSON.stringify({ ok: res.ok, status: res.status, data }, null, 2),
    { headers: { 'Content-Type': 'application/json' } }
  );
}