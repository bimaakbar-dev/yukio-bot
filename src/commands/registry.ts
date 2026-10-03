import type { Bot, Context } from 'grammy';
import type { Env } from '../types/env';
import { isAdmin } from '../lib/permissions';

/**
 * Definisi satu command.
 * Setiap command file export object dengan shape ini.
 */
export interface CommandDefinition {
  /** Nama command tanpa slash — misal "anime" untuk /anime */
  name: string;

  /** Deskripsi singkat — muncul di /help */
  description: string;

  /** Contoh penggunaan — misal "/anime jujutsu kaisen" */
  usage?: string;

  /** Kalau true, hanya admin yang bisa pakai */
  adminOnly?: boolean;

  /** Function handler — dijalankan saat command dipanggil */
  handler: (ctx: Context, env: Env) => Promise<void>;
}

// ──────────────────────────────────────────────────────────
// Import semua command
// ──────────────────────────────────────────────────────────
import { pingCommand } from './ping';
import { helpCommand } from './help';
import { statusCommand } from './status';
import { animeCommand } from './anime';
import { aiCommand } from './ai';

/**
 * Daftar semua command yang terdaftar.
 * Tambah command baru = tambah 1 baris di sini.
 */
export const COMMANDS: CommandDefinition[] = [
  pingCommand,
  helpCommand,
  statusCommand,
  animeCommand,
  aiCommand,
];

/**
 * Register semua command ke bot instance.
 * Dipanggil sekali saat bot di-create.
 */
export function registerCommands(bot: Bot, env: Env): void {
  for (const cmd of COMMANDS) {
    bot.command(cmd.name, async (ctx) => {
      // Cek permission admin-only
      if (cmd.adminOnly && !isAdmin(ctx.from?.id, env)) {
        await ctx.reply('⛔ Command ini hanya untuk admin.');
        return;
      }

      // Jalankan handler
      try {
        await cmd.handler(ctx, env);
      } catch (err) {
        console.error(`[Command:${cmd.name}] error:`, err);
        await ctx
          .reply('❌ Terjadi kesalahan. Coba lagi.')
          .catch(() => {});
      }
    });
  }
}