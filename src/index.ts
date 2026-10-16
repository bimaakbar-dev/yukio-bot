import { Bot, webhookCallback } from 'grammy';
import type { Env } from './types/env';
import { registerCommands } from './commands/registry';
import { isAdmin } from './lib/permissions';
import { setupAnimeCallbacks } from './commands/anime/callbacks';
import { setupDatabaseCallbacks, handleDatabaseText } from './commands/database/actions';
import { handleDocumentAuto } from './commands/decode';
import { handleBatchWizardText, setupBatchWizardCallbacks } from './commands/batch';
import { setupVaCallbacks } from './commands/va';
import { setupKillCallbacks } from './commands/kill';
import { handleTrackTextV2, setupTrackCallbacks } from './commands/track';
import { COMMANDS } from './commands/list';

const COMMAND_NAME_RE = /^[a-z0-9_-]{1,32}$/;

let cachedBot: Bot | null = null;
let initPromise: Promise<void> | null = null;
let menuSetForToken: string | null = null;

function createBot(env: Env): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.command('start', async (ctx) => {
    await ctx.reply(
      '🤖 <b>Yukio Bot</b>\n<i>Personal assistant</i>\n\nKetik /help untuk lihat command.',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
  });

  registerCommands(bot, env);
  setupAnimeCallbacks(bot, env);
  setupDatabaseCallbacks(bot, env);
  setupBatchWizardCallbacks(bot, env);
  setupVaCallbacks(bot, env);
  setupKillCallbacks(bot, env);
  setupTrackCallbacks(bot, env);

  bot.on('message:text', async (ctx) => {
    if (!isAdmin(ctx.from?.id, env)) return;
    if (ctx.chat?.type !== 'private') return;
    try {
      const handledTrack = await handleTrackTextV2(ctx, env);
      if (handledTrack) return;

      const handledBatch = await handleBatchWizardText(ctx, env);
      if (handledBatch) return;

      const handledDb = await handleDatabaseText(ctx, env);
      if (handledDb) return;
    } catch (err) {
      console.error('[Text] handler error:', err);
    }
  });

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

async function applyBotCommands(
  bot: Bot
): Promise<{ commands: { command: string; description: string }[]; skipped: string[] }> {
  const commands = COMMANDS.filter((c) => COMMAND_NAME_RE.test(c.name)).map((c) => ({
    command: c.name,
    description: (c.description || c.name).slice(0, 256),
  }));
  const skipped = COMMANDS.filter((c) => !COMMAND_NAME_RE.test(c.name)).map((c) => c.name);
  if (skipped.length > 0) console.warn(`[Bot] Skipped: ${skipped.join(', ')}`);
  await bot.api.setMyCommands(commands);
  return { commands, skipped };
}

async function setupBotMenu(bot: Bot, token: string): Promise<void> {
  if (menuSetForToken === token) return;
  try {
    const { commands } = await applyBotCommands(bot);
    menuSetForToken = token;
    console.log(`[Bot] setMyCommands: ${commands.length} commands`);
  } catch (err) {
    console.error('[Bot] setMyCommands failed:', err);
  }
}

async function getBot(env: Env): Promise<Bot> {
  if (!cachedBot) cachedBot = createBot(env);
  if (!initPromise) {
    const t0 = Date.now();
    initPromise = cachedBot
      .init()
      .then(async () => {
        console.log(`[Bot] init OK in ${Date.now() - t0}ms`);
        await setupBotMenu(cachedBot!, env.TELEGRAM_BOT_TOKEN);
      })
      .catch((err) => {
        console.error(`[Bot] init FAILED:`, err);
        initPromise = null;
        cachedBot = null;
        throw err;
      });
  }
  await initPromise;
  return cachedBot;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(
          JSON.stringify({ ok: false, elapsed: Date.now() - t0, error: msg }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    if (url.pathname === '/webhook') {
      const t0 = Date.now();
      try {
        const bot = await getBot(env);
        const handler = webhookCallback(bot, 'cloudflare-mod', {
          timeoutMilliseconds: 25000,
          onTimeout: 'return',
        });
        const res = await handler(request);
        console.log(`[Worker] webhook done in ${Date.now() - t0}ms`);
        return res;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Worker] webhook error after ${Date.now() - t0}ms:`, msg);
        return new Response('OK', { status: 200 });
      }
    }
    void ctx;
    return new Response('Not Found', { status: 404 });
  },
};
