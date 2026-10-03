import { Bot, webhookCallback } from 'grammy';
import type { Env } from './types/env';
import { registerCommands } from './commands/registry';
import { setupBusinessHandler } from './business/autoReply';
import { cleanupCache } from './lib/cache';

function createBot(env: Env): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.command('start', async (ctx) => {
    await ctx.reply(
      '🤖 <b>Yukio Bot</b>\n' +
        '<i>Personal assistant</i>\n\n' +
        'Bot ini untuk keperluan pribadi.\n' +
        'Ketik /help untuk lihat command yang tersedia.',
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }
    );
  });

  registerCommands(bot, env);
  setupBusinessHandler(bot, env);
    console.error('[Bot] error:', err.error);
  });

  return bot;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          bot: 'yukio-bot',
          timestamp: new Date().toISOString(),
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.pathname === '/webhook') {
      try {
        const bot = createBot(env);
        const handler = webhookCallback(bot, 'cloudflare-mod');
        return await handler(request);
      } catch (err) {
        console.error('[Worker] webhook error:', err);
        return new Response('Internal Server Error', { status: 500 });
      }
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    try {
      const cleaned = await cleanupCache(env.DB);
      console.log(`[Cron] Cleaned ${cleaned} expired cache entries`);
    } catch (err) {
      console.error('[Cron] cleanup error:', err);
    }
  },
};