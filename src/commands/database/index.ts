// src/commands/database/index.ts
import type { CommandDefinition } from '../registry';
import type { Env } from '../../types/env';
import { showMainMenu, handleSlugInput } from './actions';

export const databaseCommand: CommandDefinition = {
  name: 'database',
  description: 'CMS data repo — cek slug, edit, hapus',
  usage: '/database [slug]',
  adminOnly: true,

  handler: async (ctx, env: Env) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const userId = ctx.from?.id;
    if (!userId) return;

    if (arg) {
      await handleSlugInput(ctx, env, userId, arg);
      return;
    }

    await showMainMenu(ctx, env);
  },
};
