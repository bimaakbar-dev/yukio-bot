import type { Env } from '../types/env';

export function isAdmin(userId: number | undefined, env: Env): boolean {
  if (!userId) return false;
  return userId.toString() === env.ADMIN_USER_ID;
}

export function isOwner(userId: number | undefined, env: Env): boolean {
  if (!userId) return false;
  return userId.toString() === env.BUSINESS_OWNER_ID;
}