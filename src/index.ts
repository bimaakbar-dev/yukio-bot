import { Bot, webhookCallback } from 'grammy';
import type { Env } from './types/env';
import { registerCommands } from './commands/registry';
import { setupBusinessHandler } from './business/autoReply';
import { cleanupCache } from './lib/cache';
import { isAdmin } from './lib/permissions';
import { escapeHtml } from './lib/utils';
import {
  handleDocumentAuto,
  handleBatchWizardText,
  setupBatchWizardCallbacks,
} from './commands/decode';
import { setupAnimeCallbacks } from './commands/anime';
import { setupVaCallbacks } from './commands/va';
import { handleDiscordRequest } from './discord/handler';
import { registerDiscordCommands } from './discord/register';
import { setupDatabaseAnimeCallbacks } from './commands/database-anime';
import { setupPublishCallbacks } from './commands/publish';
import { setupPostCallbacks } from './commands/post';
import { setupKillCallbacks } from './commands/kill';
import { setupEditCallbacks } from './commands/edit/callbacks';
import { handleEditTextInput } from './commands/edit';
import { handleTrackTextV2, setupTrackCallbacks } from './commands/track';
import { COMMANDS } from './commands/list';
import { databaseCommand, handleCmsText, setupCmsCallbacks } from './commands/cms';

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
  setupBusinessHandler(bot, env);
  setupAnimeCallbacks(bot, env);
  setupDatabaseAnimeCallbacks(bot, env);
  setupVaCallbacks(bot, env);
  setupPublishCallbacks(bot, env);
  setupPostCallbacks(bot, env);
  setupKillCallbacks(bot, env);
  setupTrackCallbacks(bot, env);
  setupBatchWizardCallbacks(bot, env);
  setupEditCallbacks(bot, env);
  setupCmsCallbacks(bot, env);

  bot.on('message:text', async (ctx) => {
    if (!isAdmin(ctx.from?.id, env)) return;
    if (ctx.chat?.type !== 'private') return;
    try {
      const handledTrackV2 = await handleTrackTextV2(ctx, env);
      if (handledTrackV2) return;

      const handledBatchWizard = await handleBatchWizardText(ctx, env);
      if (handledBatchWizard) return;
      
      const handledCms = await handleCmsText(ctx, env);
      if (handledCms) return;

      const handledEdit = await handleEditTextInput(ctx, env);
      if (handledEdit) return;
      
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
): Promise<{
  commands: { command: string; description: string }[];
  skipped: string[];
}> {
  const commands = COMMANDS.filter((c) => COMMAND_NAME_RE.test(c.name)).map(
    (c) => ({
      command: c.name,
      description: (c.description || c.name).slice(0, 256),
    })
  );
  const skipped = COMMANDS.filter((c) => !COMMAND_NAME_RE.test(c.name)).map(
    (c) => c.name
  );
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
  if (!cachedBot) {
    cachedBot = createBot(env);
  }
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

    if (url.pathname === '/discord/register')
      return registerDiscordCommands(env);
    if (url.pathname === '/discord')
      return handleDiscordRequest(request, env, ctx);

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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[Worker] webhook error after ${Date.now() - t0}ms:`,
          msg
        );
        return new Response('OK', { status: 200 });
      }
    }
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const cron = event.cron;
    console.log(`[Cron] trigger: ${cron}`);

    if (cron === '0 3 * * *') {
      try {
        const cleaned = await cleanupCache(env.DB);
        console.log(`[Cron] Cleaned ${cleaned}`);
      } catch (err) {
        console.error('[Cron] cleanup error:', err);
      }
      return;
    }

    if (cron === '0 23 * * *' || cron === '0 11 * * *') {
      try {
        const { runCron } = await import('./lib/cron/runner');
        const result = await runCron(env);
        const summaryLines: string[] = [];
        summaryLines.push(
          `<b>📡 Cron Episode Report</b>\n🕐 <code>${cron}</code>\n`
        );
        summaryLines.push(`🔍 Dicek: <b>${result.animeChecked}</b>`);
        summaryLines.push(`📼 Push: <b>${result.episodesPushed}</b>`);
        if (result.errors.length > 0) {
          summaryLines.push('');
          summaryLines.push(`⚠️ <b>Error (${result.errors.length}):</b>`);
          for (const e of result.errors.slice(0, 5))
            summaryLines.push(`• <code>${escapeHtml(e.slice(0, 150))}</code>`);
          if (result.errors.length > 5)
            summaryLines.push(`<i>…dan ${result.errors.length - 5}</i>`);
        }
        try {
          const { Bot: BotCtor } = await import('grammy');
          const bot = new BotCtor(env.TELEGRAM_BOT_TOKEN);
          await bot.api.sendMessage(env.ADMIN_USER_ID, summaryLines.join('\n'), {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          });
        } catch (notifErr) {
          console.error('[Cron] notif error:', notifErr);
        }
        console.log(
          `[Cron] done — pushed ${result.episodesPushed}, errors ${result.errors.length}`
        );
      } catch (err) {
        console.error('[Cron] error:', err);
      }
      return;
    }
    console.warn(`[Cron] unknown: ${cron}`);
  },
};
