export interface Env {
  // ────────────────────────────────────────────────────────
  // Telegram
  // ────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: string;

  // ────────────────────────────────────────────────────────
  // Admin & Owner
  // ────────────────────────────────────────────────────────
  /** User ID Telegram kamu — untuk akses admin commands */
  ADMIN_USER_ID: string;
  
  /** User ID Telegram akun personal — untuk business mode */
  BUSINESS_OWNER_ID: string;

  // ────────────────────────────────────────────────────────
  // Cloudflare Bindings
  // ────────────────────────────────────────────────────────
  /** D1 Database — cache & chat log */
  DB: D1Database;
  
  /** Workers AI — untuk fitur AI */
  AI: Ai;
}