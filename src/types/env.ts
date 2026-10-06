export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  ADMIN_USER_ID: string;
  BUSINESS_OWNER_ID: string;

  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APP_ID: string;
  DISCORD_ADMIN_USER_ID: string;

  VAL_TOWN_FETCH_URL: string;

  DB: D1Database;
  AI: Ai;
}
