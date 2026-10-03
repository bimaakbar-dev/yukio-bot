import type { Env } from '../types/env';

/**
 * Cek apakah user adalah admin (kamu).
 * Dipakai untuk membatasi command sensitif seperti /anime, /ai, /status.
 */
export function isAdmin(userId: number | undefined, env: Env): boolean {
  if (!userId) return false;
  return userId.toString() === env.ADMIN_USER_ID;
}

/**
 * Cek apakah pesan berasal dari owner (akun personal).
 * Dipakai di business handler untuk menghindari auto-reply loop —
 * bot tidak boleh balas pesan yang dikirim oleh owner sendiri.
 */
export function isOwner(userId: number | undefined, env: Env): boolean {
  if (!userId) return false;
  return userId.toString() === env.BUSINESS_OWNER_ID;
}