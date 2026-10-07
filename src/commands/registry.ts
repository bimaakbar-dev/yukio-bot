import type { Bot, Context } from 'grammy';
import type { Env } from '../types/env';
import { isAdmin } from '../lib/permissions';
import { COMMANDS } from './list';

export interface CommandDefinition {
  name: string;
  description: string;
  usage?: string;
  adminOnly?: boolean;
  handler: (ctx: Context, env: Env) => Promise<void>;
}

export function registerCommands(bot: Bot, env: Env): void {
  for (const cmd of COMMANDS) {
    bot.command(cmd.name, async (ctx) => {
      if (cmd.adminOnly && !isAdmin(ctx.from?.id, env)) {
        await ctx.reply('⛔ Command ini hanya untuk admin.');
        return;
      }

      try {
        await cmd.handler(ctx, env);
      } catch (err) {
        console.error(`[Command:${cmd.name}] error:`, err);
        await ctx.reply('❌ Terjadi kesalahan. Coba lagi.').catch(() => {});
      }
    });
  }
}