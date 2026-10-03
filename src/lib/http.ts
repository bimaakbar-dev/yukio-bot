/**
 * Fetch dengan retry otomatis untuk 429/503.
 * Hormati header Retry-After kalau ada.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: { retries?: number; baseDelay?: number } = {}
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const baseDelay = opts.baseDelay ?? 1500;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(input, init);

      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        const ra = parseInt(res.headers.get('retry-after') ?? '0', 10);
        const delay =
          ra > 0
            ? ra * 1000
            : baseDelay * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, Math.min(delay, 6000)));
        continue;
      }

      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) =>
          setTimeout(r, baseDelay * Math.pow(2, attempt))
        );
        continue;
      }
      throw err;
    }
  }

  throw lastErr ?? new Error('fetchWithRetry: unknown error');
}