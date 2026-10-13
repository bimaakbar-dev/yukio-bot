export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  ADMIN_USER_ID: string;
  BUSINESS_OWNER_ID: string;

  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APP_ID: string;

  VAL_TOWN_FETCH_URL: string;
  YUKIO_TOKEN: string;

  YUKIO_DATA_REPO: string;
  YUKIO_DATA_BRANCH: string;

  GH_APP_ID: string;
  GH_APP_INSTALLATION_ID: string;
  GH_APP_PRIVATE_KEY: string;

  DB: D1Database;
  AI: Ai;
}