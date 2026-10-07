import { Bot, webhookCallback } from 'grammy';
import type { Env } from './types/env';
import { registerCommands } from './commands/registry';
import { setupBusinessHandler } from './business/autoReply';
import { cleanupCache } from './lib/cache';
import { isAdmin } from './lib/permissions';
import { handleDocumentAuto } from './commands/decode';
import { setupAnimeCallbacks } from './commands/anime';
import { setupVaCallbacks } from './commands/va';
import { handleDiscordRequest } from './discord/handler';
import { registerDiscordCommands } from './discord/register';
import { setupDatabaseAnimeCallbacks } from './commands/database-anime';
import { setupPublishCallbacks } from './commands/publish';
import { setupPostCallbacks } from './commands/post';
import { setupKillCallbacks } from './commands/kill';
import { COMMANDS } from './commands/list';

const COMMAND_NAME_RE = /^[a-z0-9_]{1,32}$/;

let cachedBot: Bot | null = null;
let initPromise: Promise<void> | null = null;
let menuSetForToken: string | null = null;

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
  setupDatabaseAnimeCallbacks(bot, env);
  setupVaCallbacks(bot, env);
  setupPublishCallbacks(bot, env);
  setupPostCallbacks(bot, env);
  setupKillCallbacks(bot, env);

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
  const commands = COMMANDS.filter((c) => COMMAND_NAME_RE.test(c.name)).map(
    (c) => ({
      command: c.name,
      description: (c.description || c.name).slice(0, 256),
    })
  );

  const skipped = COMMANDS.filter(
    (c) => !COMMAND_NAME_RE.test(c.name)
  ).map((c) => c.name);

  if (skipped.length > 0) {
    console.warn(
      `[Bot] Skipped invalid command names from menu: ${skipped.join(', ')}`
    );
  }

  await bot.api.setMyCommands(commands);

  return { commands, skipped };
}

async function setupBotMenu(bot: Bot, token: string): Promise<void> {
  if (menuSetForToken === token) return;

  try {
    const { commands } = await applyBotCommands(bot);
    menuSetForToken = token;
    console.log(`[Bot] setMyCommands: ${commands.length} commands registered`);
  } catch (err) {
    console.error('[Bot] setMyCommands failed:', err);
  }
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
      .then(async () => {
        console.log(`[Bot] init OK in ${Date.now() - t0}ms`);
        await setupBotMenu(cachedBot!, env.TELEGRAM_BOT_TOKEN);
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

    if (url.pathname === '/debug/anilist') {
      const t0 = Date.now();
      const proxyUrl =
        'https://bimaakbar--062eb542c0de11f1b2c41607ee4eb77e.web.val.run';

      const query = `
        query ($idMal: Int) {
          Media(idMal: $idMal, type: ANIME) {
            id
            title { romaji }
            characters(page: 1, perPage: 3) {
              edges {
                role
                node { name { full } }
                voiceActors(language: JAPANESE) {
                  id
                  name { full }
                  languageV2
                }
              }
            }
          }
        }
      `;

      try {
        const res = await fetch(proxyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            query,
            variables: { idMal: 40748 },
          }),
        });

        const text = await res.text();

        return new Response(
          JSON.stringify(
            {
              ok: res.ok,
              status: res.status,
              elapsed: Date.now() - t0,
              bodyPreview: text.slice(0, 2000),
            },
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

    if (url.pathname === '/debug/gh-app') {
      try {
        const { getInstallationToken } = await import('./lib/github-app');
        const token = await getInstallationToken(env);

        return new Response(
          JSON.stringify(
            {
              ok: true,
              tokenPreview: token.slice(0, 20) + '...',
              tokenLength: token.length,
              appId: env.GH_APP_ID,
              installationId: env.GH_APP_INSTALLATION_ID,
            },
            null,
            2
          ),
          { headers: { 'Content-Type': 'application/json' } }
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: err?.message ?? String(err),
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    if (url.pathname === '/discord/register') {
      return registerDiscordCommands(env);
    }

    if (url.pathname === '/discord') {
      return handleDiscordRequest(request, env, ctx);
    }

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
