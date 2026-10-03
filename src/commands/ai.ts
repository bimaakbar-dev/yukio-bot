import type { CommandDefinition } from './registry';
import { askAI } from '../services/ai';

export const aiCommand: CommandDefinition = {
  name: 'ai',
  description: 'Chat dengan AI',
  usage: '/ai jelaskan anime isekai',
  adminOnly: true,

  handler: async (ctx, env) => {
    // Ambil prompt dari arg atau dari pesan yang di-reply
    const argPrompt = ctx.match?.trim() ?? '';
    const repliedText = ctx.message?.reply_to_message?.text ?? '';
    const prompt = argPrompt || repliedText;

    if (!prompt) {
      await ctx.reply(
        'Kasih prompt-nya.\n\n' +
          '<b>Contoh:</b>\n' +
          '<code>/ai jelaskan anime isekai</code>\n\n' +
          'Atau reply ke pesan yang berisi teks, lalu kirim <code>/ai</code>.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const loading = await ctx.reply('🤔 Berpikir...');

    try {
      const response = await askAI(env, prompt, {
        system:
          'Kamu adalah Yukio, asisten pribadi yang ramah dan membantu. ' +
          'Jawab dengan singkat, jelas, dan natural dalam bahasa yang sama ' +
          'dengan user. Hindari basa-basi berlebihan.',
        maxTokens: 800,
        temperature: 0.7,
      });

      if (!response) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          loading.message_id,
          '❌ AI tidak memberikan response. Coba lagi.'
        );
        return;
      }

      // Split kalau response > 4000 char (limit Telegram 4096)
      const MAX_MSG_LEN = 4000;

      if (response.length <= MAX_MSG_LEN) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          loading.message_id,
          response
        );
      } else {
        // Edit loading dengan bagian pertama
        const firstPart = response.slice(0, MAX_MSG_LEN);
        await ctx.api.editMessageText(
          ctx.chat!.id,
          loading.message_id,
          firstPart
        );

        // Kirim sisanya sebagai pesan baru
        let remaining = response.slice(MAX_MSG_LEN);
        while (remaining.length > 0) {
          const chunk = remaining.slice(0, MAX_MSG_LEN);
          await ctx.reply(chunk);
          remaining = remaining.slice(MAX_MSG_LEN);
        }
      }
    } catch (err: any) {
      console.error('[AI] error:', err);
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