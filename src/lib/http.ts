export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: { retries?: number; baseDelay?: number; timeout?: number } = {}
): Promise<Response> {
  const retries = opts.retries ?? 0;
  const baseDelay = opts.baseDelay ?? 500;
  const timeout = opts.timeout ?? 5000;

  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    try {
      const res = await fetch(input, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;

      if (attempt < retries) {
        await new Promise(r => setTimeout(r, baseDelay));
        continue;
      }
      throw err;
    }
  }

  throw lastErr ?? new Error('fetchWithRetry: unknown error');
}
