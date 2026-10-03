import type { Env } from '../../types/env';
import type { DiscordInteraction } from '../handler';

export function handlePing(
  _interaction: DiscordInteraction,
  _env: Env
): Response {
  const body = {
    type: 4,
    data: {
      content: `🏓 **Pong!**\n🕐 \`${new Date().toISOString()}\``,
    },
  };

  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}