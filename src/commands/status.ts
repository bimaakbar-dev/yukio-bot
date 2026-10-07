import type { CommandDefinition } from './registry';

export const statusCommand: CommandDefinition = {
  name: 'status',
  description: 'Status bot & statistik cache',
  adminOnly: true,
  handler: async (ctx, env) => {
    const loading = await ctx.reply('📊 Mengumpulkan stats...');

    try {
      const now = Date.now();

      const cacheActive = await env.DB
        .prepare('SELECT COUNT(*) as count FROM cache WHERE expires_at > ?')
        .bind(now)
        .first<{ count: number }>();

      const cacheExpired = await env.DB
        .prepare('SELECT COUNT(*) as count FROM cache WHERE expires_at <= ?')
        .bind(now)
        .first<{ count: number }>();

      const chatsTotal = await env.DB
        .prepare('SELECT COUNT(*) as count FROM business_chats')
        .first<{ count: number }>()
        .catch(() => ({ count: 0 }));

      const chatsToday = await env.DB
        .prepare(
          'SELECT COUNT(*) as count FROM business_chats WHERE created_at > ?'
        )
        .bind(now - 24 * 60 * 60 * 1000)
        .first<{ count: number }>()
        .catch(() => ({ count: 0 }));

      const msg =
        `📊 <b>Yukio Bot Status</b>\n\n` +
        `<b>Cache</b>\n` +
        `  ✅ Aktif: ${cacheActive?.count ?? 0}\n` +
        `  ⏳ Expired: ${cacheExpired?.count ?? 0}\n\n` +
        `<b>Business Chats</b>\n` +
        `  💬 Total: ${chatsTotal?.count ?? 0}\n` +
        `  📅 24 jam terakhir: ${chatsToday?.count ?? 0}\n\n` +
        `<b>Runtime</b>\n` +
        `  🌐 Platform: Cloudflare Workers\n` +
        `  🕐 Server: ${new Date().toISOString()}`;

      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        msg,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        }
      );
    } catch (err: any) {
      console.error('[Status] error:', err);
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `❌ Error: ${err?.message ?? 'unknown'}`
        )
        .catch(() => {});
    }
  },
};