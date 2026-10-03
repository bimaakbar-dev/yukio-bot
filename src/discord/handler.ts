import type { Env } from '../types/env';
import { verifyDiscordSignature } from './verify';
import { handlePing } from './commands/ping';
import { handleAnime, handleAnimeButton } from './commands/anime';

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
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();

  console.log('[Discord] request received');

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
    console.warn('[Discord] signature INVALID');
    return new Response('Invalid signature', { status: 401 });
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(body) as DiscordInteraction;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  console.log('[Discord] type:', interaction.type);

  // PING
  if (interaction.type === 1) {
    return json({ type: 1 });
  }

  // Slash command (type 2)
  if (interaction.type === 2) {
    const name = interaction.data?.name;
    console.log(`[Discord] command: /${name}`);

    switch (name) {
      case 'ping':
        return handlePing(interaction, env);
      case 'anime':
        return handleAnime(interaction, env, ctx);
      default:
        return json({
          type: 4,
          data: { content: `❌ Command \`/${name}\` belum diimplementasi.` },
        });
    }
  }

  // Button click (type 3 MESSAGE_COMPONENT)
  if (interaction.type === 3) {
    const customId = interaction.data?.custom_id ?? '';
    console.log(`[Discord] button: ${customId}`);

    if (customId.startsWith('an:')) {
      return handleAnimeButton(interaction, env, customId);
    }

    return json({
      type: 4,
      data: { content: '❌ Tombol tidak dikenal.', flags: 64 },
    });
  }

  return json({ type: 1 });
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}