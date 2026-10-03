import type { CommandDefinition } from './registry';

export const clearcacheCommand: CommandDefinition = {
  name: 'clearcache',
  description: 'Hapus cache anime',
  usage: '/clearcache\n/clearcache all',
  adminOnly: true,

  handler: async (ctx, env) => {
    const arg = typeof ctx.match === 'string' ? ctx.match.trim().toLowerCase() : '';

    // Default: hapus cache anime saja
    // "all": hapus semua cache (termasuk AI, dll nanti)
    const deleteAll = arg === 'all';
    const pattern = deleteAll ? '%' : 'anime:%';

    const loading = await ctx.reply(
      `🗑️ Menghapus cache${deleteAll ? ' (semua)' : ' anime'}...`
    );

    try {
      // Hitung dulu berapa yang akan dihapus
      const countResult = await env.DB
        .prepare('SELECT COUNT(*) as count FROM cache WHERE key LIKE ?')
        .bind(pattern)
        .first<{ count: number }>();

      const total = countResult?.count ?? 0;

      if (total === 0) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          loading.message_id,
          `ℹ️ Tidak ada cache yang perlu dihapus.`
        );
        return;
      }

      // Hapus
      const deleteResult = await env.DB
        .prepare('DELETE FROM cache WHERE key LIKE ?')
        .bind(pattern)
        .run();

      const deleted = deleteResult.meta?.changes ?? total;

      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `✅ <b>Cache dihapus</b>\n\n` +
          `📦 Total: <b>${deleted}</b> entry\n` +
          `🎯 Filter: <code>${pattern}</code>\n\n` +
          `<i>Fetch berikutnya akan ambil data fresh dari API.</i>`,
        { parse_mode: 'HTML' }
      );
    } catch (err: any) {
      console.error('[ClearCache] error:', err);
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