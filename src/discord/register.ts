import type { Env } from '../types/env';

const COMMANDS = [
  {
    name: 'ping',
    description: 'Health check — cek bot masih hidup',
    dm_permission: true,
  },
  {
    name: 'anime',
    description: 'Cari metadata anime',
    dm_permission: true,
    options: [
      {
        name: 'search',
        description: 'Judul anime atau URL MyAnimeList',
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: 'decode',
    description: 'Decode file HTML atau Base64 jadi URL',
    dm_permission: true,
    options: [
      {
        name: 'file',
        description: 'File .html / .txt (max 8 MB)',
        type: 11,
        required: false,
      },
      {
        name: 'input',
        description: 'Atau paste Base64/HTML langsung',
        type: 3,
        required: false,
      },
    ],
  },
];

export async function registerDiscordCommands(env: Env): Promise<Response> {
  const url = `https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}/commands`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(COMMANDS),
  });

  const data = await res.json().catch(() => ({ error: 'invalid json' }));

  return new Response(
    JSON.stringify({ ok: res.ok, status: res.status, data }, null, 2),
    { headers: { 'Content-Type': 'application/json' } }
  );
}