/**
 * Retry/backoff for Jottacloud's transient statuses.
 *
 * Jottacloud publishes no rate-limit numbers (see README.md §3.11), so this does not try to honor a
 * requests-per-minute budget — it only retries the status codes rclone's Jottacloud backend treats
 * as transient (429, 500, 502, 503, 504, 509), honoring `Retry-After` when Jottacloud sends one and
 * falling back to capped exponential backoff with jitter otherwise.
 */

export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 509]);

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 4000;

function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
}

function backoffMs(attempt: number): number {
  const capped = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return capped / 2 + Math.random() * (capped / 2);
}

/**
 * Runs `send()` up to {@link MAX_ATTEMPTS} times, retrying only on {@link RETRYABLE_STATUSES}.
 * Returns the last response otherwise (including a non-retryable error status, which the caller
 * classifies via `errorForStatus`).
 */
export async function fetchWithRetry(
  send: () => Promise<Response>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<Response> {
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await send();
    if (!RETRYABLE_STATUSES.has(response.status)) return response;
    lastResponse = response;
    if (attempt === MAX_ATTEMPTS - 1) break;
    await response.body?.cancel().catch(() => undefined);
    await sleep(parseRetryAfterMs(response) ?? backoffMs(attempt));
  }
  return lastResponse!;
}
