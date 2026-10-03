import type { CommandDefinition } from './registry';

export const pingCommand: CommandDefinition = {
  name: 'ping',
  description: 'Health check — cek bot masih hidup',
  adminOnly: true,
  handler: async (ctx) => {
    const start = Date.now();

    // Kirim pesan loading dulu
    const msg = await ctx.reply('🏓 Pinging...');

    // Hitung latency
    const latency = Date.now() - start;

    // Edit pesan dengan hasil
    await ctx.api.editMessageText(
      ctx.chat!.id,
      msg.message_id,
      `🏓 <b>Pong!</b>\n\n` +
        `⏱️ Latency: ${latency}ms\n` +
        `🕐 Waktu: ${new Date().toISOString()}`,
      { parse_mode: 'HTML' }
    );
  },
};