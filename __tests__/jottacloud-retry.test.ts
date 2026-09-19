import { describe, expect, it } from "vitest";
import { fetchWithRetry, RETRYABLE_STATUSES } from "../src/jottacloud/retry";

async function noopSleep(): Promise<void> {}

describe("RETRYABLE_STATUSES", () => {
  it("matches rclone's Jottacloud retryErrorCodes exactly", () => {
    expect([...RETRYABLE_STATUSES].sort((a, b) => a - b)).toEqual([429, 500, 502, 503, 504, 509]);
  });
});

describe("fetchWithRetry", () => {
  it("returns immediately on a non-retryable status", async () => {
    let attempts = 0;
    const response = await fetchWithRetry(async () => { attempts++; return new Response("ok", { status: 200 }); }, noopSleep);
    expect(attempts).toBe(1);
    expect(response.status).toBe(200);
  });

  it("does not retry a 404 (client error, not transient)", async () => {
    let attempts = 0;
    const response = await fetchWithRetry(async () => { attempts++; return new Response("nf", { status: 404 }); }, noopSleep);
    expect(attempts).toBe(1);
    expect(response.status).toBe(404);
  });

  for (const status of [429, 500, 502, 503, 504, 509]) {
    it(`retries on ${status} and succeeds once it clears`, async () => {
      let attempts = 0;
      const response = await fetchWithRetry(async () => {
        attempts++;
        return attempts < 2 ? new Response("busy", { status }) : new Response("ok", { status: 200 });
      }, noopSleep);
      expect(attempts).toBe(2);
      expect(response.status).toBe(200);
    });
  }

  it("gives up after the maximum number of attempts and returns the last response", async () => {
    let attempts = 0;
    const response = await fetchWithRetry(async () => { attempts++; return new Response("busy", { status: 503 }); }, noopSleep);
    expect(attempts).toBe(4);
    expect(response.status).toBe(503);
  });

  it("honors a numeric Retry-After header", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    await fetchWithRetry(async () => {
      attempts++;
      if (attempts < 2) return new Response("busy", { status: 429, headers: { "Retry-After": "2" } });
      return new Response("ok", { status: 200 });
    }, async ms => { sleeps.push(ms); });
    expect(sleeps).toEqual([2000]);
  });
});
