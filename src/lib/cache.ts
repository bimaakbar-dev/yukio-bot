interface CacheRow {
  value: string;
  expires_at: number;
}

/**
 * Ambil value dari cache D1 berdasarkan key.
 * Return null kalau:
 * - key tidak ada
 * - sudah expired (sekaligus hapus entry)
 * - error saat query
 */
export async function getCache<T>(
  db: D1Database,
  key: string
): Promise<T | null> {
  try {
    const row = await db
      .prepare('SELECT value, expires_at FROM cache WHERE key = ?')
      .bind(key)
      .first<CacheRow>();

    if (!row) return null;

    // Kalau expired — hapus dan return null
    if (row.expires_at < Date.now()) {
      await db.prepare('DELETE FROM cache WHERE key = ?').bind(key).run();
      return null;
    }

    return JSON.parse(row.value) as T;
  } catch (err) {
    console.error('[Cache] read error:', err);
    return null;
  }
}

/**
 * Simpan value ke cache D1.
 * Kalau key sudah ada, update (upsert).
 *
 * @param ttlMs — Time to live dalam milidetik
 */
export async function setCache(
  db: D1Database,
  key: string,
  value: unknown,
  ttlMs: number
): Promise<void> {
  try {
    const expiresAt = Date.now() + ttlMs;

    await db
      .prepare(
        `INSERT INTO cache (key, value, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           expires_at = excluded.expires_at`
      )
      .bind(key, JSON.stringify(value), expiresAt)
      .run();
  } catch (err) {
    console.error('[Cache] write error:', err);
  }
}

/**
 * Hapus entry dari cache.
 */
export async function deleteCache(db: D1Database, key: string): Promise<void> {
  try {
    await db.prepare('DELETE FROM cache WHERE key = ?').bind(key).run();
  } catch (err) {
    console.error('[Cache] delete error:', err);
  }
}

/**
 * Hapus semua entry yang sudah expired.
 * Dipanggil via cron trigger harian.
 */
export async function cleanupCache(db: D1Database): Promise<number> {
  try {
    const result = await db
      .prepare('DELETE FROM cache WHERE expires_at < ?')
      .bind(Date.now())
      .run();

    return result.meta?.changes ?? 0;
  } catch (err) {
    console.error('[Cache] cleanup error:', err);
    return 0;
  }
}