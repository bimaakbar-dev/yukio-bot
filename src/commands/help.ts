import type { CommandDefinition } from './registry';
import { COMMANDS } from './registry';
import { isAdmin } from '../lib/permissions';

export const helpCommand: CommandDefinition = {
  name: 'help',
  description: 'Daftar command yang tersedia',
  handler: async (ctx, env) => {
    const admin = isAdmin(ctx.from?.id, env);

    // Header
    let msg = '🤖 <b>Yukio Bot</b>\n';
    msg += '<i>Personal assistant — admin only</i>\n\n';

    // List command yang user boleh lihat
    msg += '<b>Commands</b>\n';

    for (const cmd of COMMANDS) {
      // Skip command admin-only kalau user bukan admin
      if (cmd.adminOnly && !admin) continue;

      msg += `\n<code>/${cmd.name}</code>\n`;
      msg += `  ${cmd.description}\n`;

      if (cmd.usage) {
        msg += `  <i>Contoh: ${cmd.usage}</i>\n`;
      }
    }

    // Footer
    msg += '\n';
    if (!admin) {
      msg += '<i>Beberapa command memerlukan akses admin.</i>';
    }

    await ctx.reply(msg, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  },
};