export default {
  async fetch(): Promise<Response> {
    return new Response(
      JSON.stringify({
        status: 'ok',
        bot: 'yukio-bot',
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  },
};