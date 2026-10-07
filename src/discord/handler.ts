import type { Env } from '../types/env';
import { verifyDiscordSignature } from './verify';
import { handlePing } from './commands/ping';
import { handleAnime, handleAnimeButton } from './commands/anime';
import { handleDecode } from './commands/decode';

export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  data?: {
    name?: string;
    options?: { name: string; value: string | number }[];
    custom_id?: string;
    resolved?: {
      attachments?: Record<string, {
        id: string;
        url: string;
        filename: string;
        size: number;
        content_type?: string;
      }>;
    };
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

  const customId = interaction.data?.custom_id ?? '';
  const cmdName = interaction.data?.name ?? '';

  console.log(
    `[Discord] type=${interaction.type} cmd=${cmdName} cid=${customId} app=${interaction.application_id}`
  );

  // PING
  if (interaction.type === 1) {
    console.log('[Discord] PING → PONG');
    return json({ type: 1 });
  }

  // Button (type 3) — CEK DULU sebelum slash command
  if (interaction.type === 3) {
    console.log(`[Discord] BUTTON: ${customId}`);

    if (customId.startsWith('an:')) {
      return handleAnimeButton(interaction, env, ctx, customId);
    }

    return json({
      type: 4,
      data: { content: `❌ Tombol tidak dikenal: ${customId}`, flags: 64 },
    });
  }

  // Slash command (type 2)
  if (interaction.type === 2) {
    console.log(`[Discord] COMMAND: /${cmdName}`);

    switch (cmdName) {
      case 'ping':
        return handlePing(interaction, env);
      case 'anime':
        return handleAnime(interaction, env, ctx);
      case 'decode':
  return handleDecode(interaction, env, ctx);
      default:
        return json({
          type: 4,
          data: { content: `❌ Command \`/${cmdName}\` belum diimplementasi.` },
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