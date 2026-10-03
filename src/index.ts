import { Bot, webhookCallback } from 'grammy';
import type { Env } from './types/env';
import { registerCommands } from './commands/registry';
import { setupBusinessHandler } from './business/autoReply';
import { cleanupCache } from './lib/cache';
import { isAdmin } from './lib/permissions';
import { handleDocumentAuto } from './commands/decode';
import { setupAnimeCallbacks } from './commands/anime';
import { handleDiscordRequest } from './discord/handler';
import { registerDiscordCommands } from './discord/register';

let cachedBot: Bot | null = null;
let initPromise: Promise<void> | null = null;

function createBot(env: Env): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.command('start', async (ctx) => {
    await ctx.reply(
      '🤖 <b>Yukio Bot</b>\n' +
        '<i>Personal assistant</i>\n\n' +
        'Ketik /help untuk lihat command.',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
  });

  registerCommands(bot, env);
  setupBusinessHandler(bot, env);
  setupAnimeCallbacks(bot, env);

  bot.on('message:document', async (ctx) => {
    const caption = ctx.message.caption ?? '';
    if (caption.startsWith('/')) return;
    if (ctx.chat?.type !== 'private') return;
    if (!isAdmin(ctx.from?.id, env)) return;

    const name = ctx.message.document.file_name ?? '';
    if (!/\.(html?|txt)$/i.test(name)) return;

    try {
      await handleDocumentAuto(ctx, env);
    } catch (err) {
      console.error('[AutoDecode] error:', err);
      await ctx.reply('❌ Auto-decode gagal. Coba /decode.').catch(() => {});
    }
  });

  bot.catch((err) => {
    console.error('[Bot] error:', err.error);
  });

  return bot;
}

async function getBot(env: Env): Promise<Bot> {
  if (!cachedBot) {
    console.log('[Bot] creating new instance');
    cachedBot = createBot(env);
  }

  if (!initPromise) {
    const t0 = Date.now();
    initPromise = cachedBot
      .init()
      .then(() => {
        console.log(`[Bot] init OK in ${Date.now() - t0}ms`);
      })
      .catch((err) => {
        console.error(`[Bot] init FAILED in ${Date.now() - t0}ms:`, err);
        initPromise = null;
        cachedBot = null;
        throw err;
      });
  }

  await initPromise;
  return cachedBot;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
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

    // Debug Telegram
    if (url.pathname === '/debug') {
      const t0 = Date.now();
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`
        );
        const data = await res.json();
        return new Response(
          JSON.stringify(
            { ok: res.ok, status: res.status, elapsed: Date.now() - t0, data },
            null,
            2
          ),
          { headers: { 'Content-Type': 'application/json' } }
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({
            ok: false,
            elapsed: Date.now() - t0,
            error: err?.message ?? String(err),
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // Discord — register slash commands (buka di browser sekali)
    if (url.pathname === '/discord/register') {
      return registerDiscordCommands(env);
    }

    // Discord — interaction endpoint
    if (url.pathname === '/discord') {
      return handleDiscordRequest(request, env);
    }

    // Telegram — webhook
    if (url.pathname === '/webhook') {
      const t0 = Date.now();
      try {
        const bot = await getBot(env);
        const handler = webhookCallback(bot, 'cloudflare-mod', {
          timeoutMilliseconds: 15000,
          onTimeout: 'return',
        });
        const res = await handler(request);
        console.log(`[Worker] webhook done in ${Date.now() - t0}ms`);
        return res;
      } catch (err: any) {
        console.error(
          `[Worker] webhook error after ${Date.now() - t0}ms:`,
          err?.message ?? err
        );
        return new Response('OK', { status: 200 });
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