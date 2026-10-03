import type { Env } from '../types/env';
import { verifyDiscordSignature } from './verify';
import { handlePing } from './commands/ping';

export interface DiscordInteraction {
  id: string;
  type: number;
  token: string;
  app_permissions?: string;
  data?: {
    name?: string;
    options?: { name: string; value: string | number }[];
    custom_id?: string;
  };
  member?: { user: { id: string; username: string } };
  user?: { id: string; username: string };
  channel_id?: string;
  guild_id?: string;
  message?: {
    id: string;
    content: string;
  };
}

export async function handleDiscordRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();

  if (!signature || !timestamp) {
    return new Response('Missing signature', { status: 401 });
  }

  const valid = await verifyDiscordSignature(
    env.DISCORD_PUBLIC_KEY,
    signature,
    timestamp,
    body
  );

  if (!valid) {
    return new Response('Invalid signature', { status: 401 });
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(body) as DiscordInteraction;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (interaction.type === 1) {
    return json({ type: 1 });
  }

  if (interaction.type === 2) {
    const name = interaction.data?.name;

    console.log(`[Discord] command: /${name}`);

    switch (name) {
      case 'ping':
        return handlePing(interaction, env);
      default:
        return json({
          type: 4,
          data: {
            content: `❌ Command \`/${name}\` belum diimplementasi.`,
          },
        });
    }
  }

  return json({ type: 1 });
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}