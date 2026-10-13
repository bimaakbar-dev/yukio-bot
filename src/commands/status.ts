import type { CommandDefinition } from './registry';

export const statusCommand: CommandDefinition = {
  name: 'status',
  description: 'Status bot & statistik cache',
  adminOnly: true,

  handler: async (ctx, env) => {
    const t0 = Date.now();
    const loading = await ctx.reply('📊 Mengumpulkan stats...');

    try {
      const now = Date.now();

      const [cacheActive, cacheExpired, sessions] = await Promise.all([
        env.DB
          .prepare('SELECT COUNT(*) as count FROM cache WHERE expires_at > ?')
          .bind(now)
          .first<{ count: number }>()
          .catch(() => ({ count: 0 })),
        env.DB
          .prepare('SELECT COUNT(*) as count FROM cache WHERE expires_at <= ?')
          .bind(now)
          .first<{ count: number }>()
          .catch(() => ({ count: 0 })),
        env.DB
          .prepare(
            'SELECT COUNT(*) as count FROM qimochi_sessions WHERE expires_at > ?'
          )
          .bind(now)
          .first<{ count: number }>()
          .catch(() => ({ count: 0 })),
      ]);

      const latency = Date.now() - t0;

      const msg =
        `📊 <b>Yukio Bot Status</b>\n\n` +
        `<b>Cache</b>\n` +
        `  ✅ Aktif: ${cacheActive?.count ?? 0}\n` +
        `  ⏳ Expired: ${cacheExpired?.count ?? 0}\n\n` +
        `<b>Session /anime</b>\n` +
        `  🟢 Aktif: ${sessions?.count ?? 0}\n\n` +
        `<b>Runtime</b>\n` +
        `  🌐 Platform: Cloudflare Workers\n` +
        `  ⏱️ Latency: ${latency}ms\n` +
        `  🕐 Server: ${new Date().toISOString()}`;

      await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, msg, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
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