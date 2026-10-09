// src/commands/track-helpers.ts
export async function showMainMenuPublic(
  ctx: any,
  env: any,
  edit: boolean
): Promise<void> {
  const mod = await import('./track');
  await (mod as any).showMainMenuPublicImpl?.(ctx, env, edit);
}

export async function showListPublic(
  ctx: any,
  env: any,
  page: number
): Promise<void> {
  const mod = await import('./track');
  await (mod as any).showListPublicImpl?.(ctx, env, page);
}

export async function showDetailPublic(
  ctx: any,
  env: any,
  slug: string,
  edit: boolean
): Promise<void> {
  const mod = await import('./track');
  await (mod as any).showDetailPublicImpl?.(ctx, env, slug, edit);
}

export async function promptEditPublic(
  ctx: any,
  env: any,
  userId: number,
  slug: string,
  field: string
): Promise<void> {
  const mod = await import('./track');
  await (mod as any).promptEditPublicImpl?.(ctx, env, userId, slug, field);
}

export async function startAddFlowPublic(
  ctx: any,
  env: any,
  userId: number
): Promise<void> {
  const mod = await import('./track');
  await (mod as any).startAddFlowPublicImpl?.(ctx, env, userId);
}

export async function handleCatchupPublic(ctx: any, env: any): Promise<void> {
  const mod = await import('./track');
  await (mod as any).handleCatchupPublicImpl?.(ctx, env);
}