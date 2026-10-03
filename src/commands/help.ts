import type { CommandDefinition } from './registry';
import { COMMANDS } from './list';
import { isAdmin } from '../lib/permissions';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const helpCommand: CommandDefinition = {
  name: 'help',
  description: 'Daftar command yang tersedia',
  handler: async (ctx, env) => {
    const admin = isAdmin(ctx.from?.id, env);

    let msg = '🤖 <b>Yukio Bot</b>\n';
    msg += '<i>Personal assistant — admin only</i>\n\n';
    msg += '<b>Commands</b>\n';

    for (const cmd of COMMANDS) {
      if (cmd.adminOnly && !admin) continue;

      msg += `\n<code>/${escapeHtml(cmd.name)}</code>\n`;
      msg += `  ${escapeHtml(cmd.description)}\n`;

      if (cmd.usage) {
        msg += `  <i>Contoh: ${escapeHtml(cmd.usage)}</i>\n`;
      }
    }

    msg += '\n';
    if (!admin) {
      msg += '<i>Beberapa command memerlukan akses admin.</i>';
    }

    // Telegram limit 4096 char
    if (msg.length > 4000) {
      msg = msg.slice(0, 3950) + '\n\n<i>… [truncated]</i>';
    }

    await ctx.reply(msg, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  },
};