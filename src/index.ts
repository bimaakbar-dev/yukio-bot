import { Bot, webhookCallback } from 'grammy';
import type { Env } from './types/env';
import { registerCommands } from './commands/registry';
import { setupBusinessHandler } from './business/autoReply';
import { cleanupCache } from './lib/cache';

/**
 * Buat instance bot baru.
 * Dipanggil setiap request — Worker tidak punya persistent state.
 */
function createBot(env: Env): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // Register semua command dari registry
  registerCommands(bot, env);

  // Setup business handler (auto-reply chat personal)
  setupBusinessHandler(bot, env);

  // Global error handler
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(
      `[Bot] error while handling update ${ctx.update.update_id}:`,
      err.error
    );
  });

  return bot;
}

export default {
  /**
   * HTTP handler — dipanggil Telegram untuk setiap update via webhook.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const bot = createBot(env);
      const handler = webhookCallback(bot, 'cloudflare-mod');
      return await handler(request);
    } catch (err) {
      console.error('[Worker] fetch error:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  },

  /**
   * Scheduled handler — dipanggil oleh cron trigger.
   * Config di wrangler.toml: "0 3 * * *" (3 pagi UTC setiap hari)
   */
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