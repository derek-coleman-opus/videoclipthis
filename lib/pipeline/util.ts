/** Structured (JSON-line) log — greppable in Vercel logs. */
export function slog(event: string, data: Record<string, unknown> = {}): void {
  try {
    console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
  } catch {
    console.log(event);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry a transient async op with exponential backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { tries?: number; baseMs?: number; label?: string } = {},
): Promise<T> {
  const tries = opts.tries ?? 3;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        slog("retry", { label: opts.label ?? "op", attempt: i + 1, error: (e as Error).message });
        await sleep(baseMs * 2 ** i);
      }
    }
  }
  throw lastErr;
}
