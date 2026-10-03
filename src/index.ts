import { Bot, webhookCallback } from 'grammy';
import type { Env } from './types/env';
import { registerCommands } from './commands/registry';
import { setupBusinessHandler } from './business/autoReply';
import { cleanupCache } from './lib/cache';
import { isAdmin } from './lib/permissions';
import {
  handleDocumentAuto,
  setupDecodeCallbacks,
} from './commands/decode';

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

  // ─────────────────────────────────────────────
  // Auto-decode file .html / .txt dari admin
  // ─────────────────────────────────────────────
  bot.on('message:document', async (ctx) => {
    const caption = ctx.message.caption ?? '';

    // Skip kalau caption-nya command (biar /decode command yang handle)
    if (caption.startsWith('/')) return;

    // Hanya di private chat
    if (ctx.chat?.type !== 'private') return;

    // Hanya dari admin
    if (!isAdmin(ctx.from?.id, env)) return;

    // Hanya .html / .txt
    const name = ctx.message.document.file_name ?? '';
    if (!/\.(html?|txt)$/i.test(name)) return;

    try {
      await handleDocumentAuto(ctx, env);
    } catch (err) {
      console.error('[AutoDecode] error:', err);
      await ctx.reply('❌ Auto-decode gagal. Coba /decode.').catch(() => {});
    }
  });

  // Setup callback tombol pagination & selesai
  setupDecodeCallbacks(bot, env);

  bot.catch((err) => {
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

      // Cleanup session decode yang expired (>1 jam)
      try {
        const res = await env.DB
          .prepare('DELETE FROM temp_decode WHERE expires_at < ?')
          .bind(Date.now())
          .run();
        const sessionCleaned = res.meta?.changes ?? 0;
        if (sessionCleaned > 0) {
          console.log(`[Cron] Cleaned ${sessionCleaned} expired decode sessions`);
        }
      } catch {
        // Tabel belum ada — skip
      }
    } catch (err) {
      console.error('[Cron] cleanup error:', err);
    }
  },
};