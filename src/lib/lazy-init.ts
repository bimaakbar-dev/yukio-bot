// src/lib/lazy-init.ts
import type { D1Database } from '@cloudflare/workers-types';

/**
 * Wrap an init function so that it only runs ONCE per Worker instance.
 * Concurrent calls share the same in-flight promise.
 *
 * Usage:
 *   export const ensureDb = createLazyInit('MyModule', async (db) => {
 *     await db.prepare('CREATE TABLE ...').run();
 *   });
 */
export function createLazyInit(
  label: string,
  init: (db: D1Database) => Promise<void>
): (db: D1Database) => Promise<void> {
  let ready = false;
  let promise: Promise<void> | null = null;

  return async (db: D1Database): Promise<void> => {
    if (ready) return;
    if (promise) return promise;

    promise = (async () => {
      try {
        await init(db);
        ready = true;
      } catch (err) {
        console.error(`[${label}] DB init error:`, err);
        promise = null;
        throw err;
      }
    })();

    return promise;
  };
}