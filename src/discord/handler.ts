import type { Env } from '../types/env';
import { verifyDiscordSignature } from './verify';
import { handlePing } from './commands/ping';

export interface DiscordInteraction {
  id: string;
  type: number;
  token: string;
  data?: {
    name?: string;
    options?: { name: string; value: string | number }[];
    custom_id?: string;
  };
  member?: { user: { id: string; username: string } };
  user?: { id: string; username: string };
  channel_id?: string;
  guild_id?: string;
}

export async function handleDiscordRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();

  console.log('[Discord] request received');
  console.log('[Discord] has sig:', !!signature, 'has ts:', !!timestamp);

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
    console.warn('[Discord] signature INVALID — return 401');
    return new Response('Invalid signature', { status: 401 });
  }

  console.log('[Discord] signature valid');

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(body) as DiscordInteraction;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  console.log('[Discord] type:', interaction.type);

  // PING — verifikasi endpoint Discord
  if (interaction.type === 1) {
    console.log('[Discord] PING → PONG');
    return json({ type: 1 });
  }

  // Slash command
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