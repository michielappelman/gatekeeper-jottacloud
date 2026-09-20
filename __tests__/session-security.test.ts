import { describe, expect, it, vi } from "vitest";
import {
  clearSimulatedWriteIfLatest, getCachedMetadata, putCachedContent, putCachedMetadata,
} from "../src/cache";
import { applyPendingWrite, JottacloudFileSessionImpl } from "../src/jottacloud";
import { JottacloudError, type JottacloudBackend } from "../src/jottacloud/client";
import type { FileMetadata } from "../src/jottacloud/types";

const file = { device: "Jotta", mountpoint: "Archive", path: "Guests.xlsx" };

function metadata(overrides: Partial<FileMetadata> = {}): FileMetadata {
  return {
    name: "Guests.xlsx", size: 10, md5: "abc123", mimeType: "text/plain",
    createdAt: new Date(), modifiedAt: new Date(), deleted: false, ...overrides,
  };
}

function fakeBackend(overrides: Partial<JottacloudBackend> = {}): JottacloudBackend {
  return {
    getMetadata: vi.fn(async () => metadata()),
    read: vi.fn(async () => new ArrayBuffer(0)),
    write: vi.fn(async () => metadata()),
    list: vi.fn(async () => []),
    ...overrides,
  };
}

// A conditional write must never silently overwrite a change made since the file was last read.
describe("applyPendingWrite (optimistic concurrency)", () => {
  it("applies the write when the current MD5 still matches ifMatchMd5", async () => {
    const backend = fakeBackend({ getMetadata: vi.fn(async () => metadata({ md5: "same" })) });
    const content = new ArrayBuffer(3);
    await applyPendingWrite(backend, "alice", file, { content, ifMatchMd5: "same" });
    expect(backend.write).toHaveBeenCalledWith("alice", file, content);
  });

  it("throws FILE_CHANGED and does not write when the file changed since it was read", async () => {
    const backend = fakeBackend({ getMetadata: vi.fn(async () => metadata({ md5: "changed-on-server" })) });
    await expect(
      applyPendingWrite(backend, "alice", file, { content: new ArrayBuffer(3), ifMatchMd5: "stale" }),
    ).rejects.toMatchObject({ code: "FILE_CHANGED" });
    expect(backend.write).not.toHaveBeenCalled();
  });

  it("writes unconditionally when no ifMatchMd5 was given", async () => {
    const backend = fakeBackend();
    await applyPendingWrite(backend, "alice", file, { content: new ArrayBuffer(3) });
    expect(backend.getMetadata).not.toHaveBeenCalled();
    expect(backend.write).toHaveBeenCalled();
  });
});

function mapKv() {
  const store = new Map<string, unknown>();
  return {
    store,
    kv: {
      get: (k: string) => store.get(k),
      put: (k: string, v: unknown) => store.set(k, v),
      delete: (k: string) => store.delete(k),
    },
  };
}

function fakeAi(toMarkdown: (...args: unknown[]) => unknown = vi.fn(async () => (
  { id: "1", name: "f", mimeType: "application/pdf", format: "markdown" as const, tokens: 1, data: "# md" }
))): Ai {
  return { toMarkdown } as unknown as Ai;
}

function fakeApprovalQueue() {
  const observations: unknown[] = [];
  const actions: { id: number; description: unknown }[] = [];
  return {
    observations,
    actions,
    stub: {
      authorizeObservation: vi.fn(async (description: unknown) => { observations.push(description); }),
      submitAction: vi.fn(async (id: number, description: unknown) => { actions.push({ id, description }); }),
      [Symbol.dispose]: vi.fn(),
    },
  };
}

describe("JottacloudFileSessionImpl", () => {
  it("authorizes an observation before returning metadata", async () => {
    const { stub, observations } = fakeApprovalQueue();
    const backend = fakeBackend({ getMetadata: vi.fn(async () => metadata({ md5: "m1" })) });
    const kv = new Map<string, unknown>();
    const session = new JottacloudFileSessionImpl(
      stub as never, {} as never, async () => "alice", backend as never, file,
      { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => kv.set(k, v) } as never, {} as never);

    const result = await session.getMetadata();
    expect(result.md5).toBe("m1");
    expect(observations).toHaveLength(1);
  });

  it("authorizes an observation before returning file content", async () => {
    const { stub, observations } = fakeApprovalQueue();
    const backend = fakeBackend({ read: vi.fn(async () => new TextEncoder().encode("data").buffer) });
    const session = new JottacloudFileSessionImpl(
      stub as never, {} as never, async () => "alice", backend as never, file,
      { get: () => undefined, put: () => {} } as never, {} as never);

    await session.read();
    expect(observations).toHaveLength(1);
  });

  it("does not write immediately: write() submits an action and only stores the pending write", async () => {
    const { stub, actions } = fakeApprovalQueue();
    const backend = fakeBackend();
    const kv = new Map<string, unknown>();
    const session = new JottacloudFileSessionImpl(
      stub as never, {} as never, async () => "alice", backend as never, file,
      { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => kv.set(k, v) } as never, {} as never);

    await session.write(new ArrayBuffer(4), "md5-at-read-time");
    expect(backend.write).not.toHaveBeenCalled();
    expect(actions).toHaveLength(1);
    expect(kv.get("write:pending:1")).toEqual({ content: expect.any(ArrayBuffer), ifMatchMd5: "md5-at-read-time" });
  });

  it("discards the pending write if submitAction is rejected/throws", async () => {
    const { stub } = fakeApprovalQueue();
    stub.submitAction = vi.fn(async () => { throw new Error("denied"); });
    const backend = fakeBackend();
    const kv = new Map<string, unknown>();
    const session = new JottacloudFileSessionImpl(
      stub as never, {} as never, async () => "alice", backend as never, file,
      { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => kv.set(k, v), delete: (k: string) => kv.delete(k) } as never, {} as never);

    await expect(session.write(new ArrayBuffer(4))).rejects.toThrow("denied");
    expect(kv.has("write:pending:1")).toBe(false);
  });

  it("translates an AUTH_EXPIRED backend error into a reconnect-prompting message", async () => {
    const { stub } = fakeApprovalQueue();
    const backend = fakeBackend({
      getMetadata: vi.fn(async () => { throw new JottacloudError("AUTH_EXPIRED", "token dead"); }),
    });
    const session = new JottacloudFileSessionImpl(
      stub as never, {} as never, async () => "alice", backend as never, file,
      { get: () => undefined, put: () => {} } as never, {} as never);

    await expect(session.getMetadata()).rejects.toThrow(/reconnect/i);
  });
});

describe("JottacloudFileSessionImpl caching and simulation", () => {
  it("getMetadata() caches: a second call does not hit the backend again", async () => {
    const { stub } = fakeApprovalQueue();
    const backend = fakeBackend({ getMetadata: vi.fn(async () => metadata({ md5: "m1" })) });
    const { kv } = mapKv();
    const session = new JottacloudFileSessionImpl(stub as never, {} as never, async () => "alice", backend as never, file, kv as never, {} as never);

    await session.getMetadata();
    const second = await session.getMetadata();
    expect(second.md5).toBe("m1");
    expect(backend.getMetadata).toHaveBeenCalledTimes(1);
  });

  it("read() caches content keyed to the metadata's MD5: a second read skips the backend", async () => {
    const { stub } = fakeApprovalQueue();
    const backend = fakeBackend({ read: vi.fn(async () => new TextEncoder().encode("data").buffer) });
    const { kv } = mapKv();
    const session = new JottacloudFileSessionImpl(stub as never, {} as never, async () => "alice", backend as never, file, kv as never, {} as never);

    const first = await session.read();
    const second = await session.read();
    expect(new TextDecoder().decode(second)).toBe("data");
    expect(second).toBe(first);
    expect(backend.read).toHaveBeenCalledTimes(1);
  });

  it("a metadata cache revealing a changed MD5 invalidates a still-fresh content cache", async () => {
    const { stub } = fakeApprovalQueue();
    const backend = fakeBackend({
      read: vi.fn(async () => new TextEncoder().encode("v1").buffer),
      getMetadata: vi.fn(async () => metadata({ md5: "v2-md5" })),
    });
    const { kv } = mapKv();
    const session = new JottacloudFileSessionImpl(stub as never, {} as never, async () => "alice", backend as never, file, kv as never, {} as never);

    await session.read(); // caches "v1" content under its own (different) MD5
    await session.getMetadata(); // reveals the file is now at v2-md5
    expect(backend.read).toHaveBeenCalledTimes(1);

    // The v1 content cache is still within its TTL, but must not be served now that metadata
    // disagrees with it.
    backend.read = vi.fn(async () => new TextEncoder().encode("v2").buffer);
    const third = await session.read();
    expect(new TextDecoder().decode(third)).toBe("v2");
    expect(backend.read).toHaveBeenCalledTimes(1);
  });

  it("write() simulates: getMetadata()/read() reflect the pending write without touching the backend", async () => {
    const { stub } = fakeApprovalQueue();
    const backend = fakeBackend();
    const { kv } = mapKv();
    const session = new JottacloudFileSessionImpl(stub as never, {} as never, async () => "alice", backend as never, file, kv as never, {} as never);

    const newContent = new TextEncoder().encode("new content").buffer;
    await session.write(newContent, "old-md5");

    const readBack = await session.read();
    expect(new TextDecoder().decode(readBack)).toBe("new content");
    expect(backend.read).not.toHaveBeenCalled();

    const simulatedMetadata = await session.getMetadata();
    expect(simulatedMetadata.size).toBe(newContent.byteLength);
    expect(backend.getMetadata).not.toHaveBeenCalled();
  });

  it("a rejected write's simulated view is cleared by the gatekeeper's rejectAction, not by the session", async () => {
    // The session itself has no rejectAction (that's the DO's job); this documents the contract:
    // submitAction() succeeding leaves the simulation in place until the DO resolves it.
    const { stub } = fakeApprovalQueue();
    const backend = fakeBackend();
    const { kv, store } = mapKv();
    const session = new JottacloudFileSessionImpl(stub as never, {} as never, async () => "alice", backend as never, file, kv as never, {} as never);

    await session.write(new ArrayBuffer(4));
    expect(store.get("sim:latest")).toBeDefined();
  });

  it("discarding a write on submitAction failure also clears its simulated view", async () => {
    const { stub } = fakeApprovalQueue();
    stub.submitAction = vi.fn(async () => { throw new Error("denied"); });
    const backend = fakeBackend();
    const { kv, store } = mapKv();
    const session = new JottacloudFileSessionImpl(stub as never, {} as never, async () => "alice", backend as never, file, kv as never, {} as never);

    await expect(session.write(new ArrayBuffer(4))).rejects.toThrow("denied");
    expect(store.get("sim:latest")).toBeUndefined();
  });

  // End-to-end lifecycle through the same steps JottacloudGatekeeperImpl.applyAction runs (the DO
  // itself is not unit-testable without full Durable Object scaffolding), catching drift
  // between the session's write() and the gatekeeper's apply-side cache promotion.
  it("full lifecycle: write -> simulated -> applied -> promoted to cache -> simulation cleared", async () => {
    const { stub } = fakeApprovalQueue();
    let submittedActionId: number | undefined;
    stub.submitAction = vi.fn(async (id: number) => { submittedActionId = id; });
    const confirmed = metadata({ md5: "confirmed-md5", size: 11 });
    const backend = fakeBackend({ write: vi.fn(async () => confirmed) });
    const { kv, store } = mapKv();
    const session = new JottacloudFileSessionImpl(stub as never, {} as never, async () => "alice", backend as never, file, kv as never, {} as never);

    const content = new TextEncoder().encode("new content").buffer;
    await session.write(content);
    expect(submittedActionId).toBe(1);

    // Simulated state is visible before approval.
    expect((await session.getMetadata()).md5).not.toBe("confirmed-md5");

    // What JottacloudGatekeeperImpl.applyAction does on approval:
    const pending = store.get(`write:pending:${submittedActionId}`) as { content: ArrayBuffer };
    const result = await applyPendingWrite(backend, "alice", file, pending);
    const now = Date.now();
    putCachedMetadata(kv, result, now);
    putCachedContent(kv, result.md5, pending.content, now);
    clearSimulatedWriteIfLatest(kv, submittedActionId!);

    expect(getCachedMetadata(kv, now)).toEqual(confirmed);
    const afterApply = await session.getMetadata();
    expect(afterApply.md5).toBe("confirmed-md5");
    expect(backend.getMetadata).not.toHaveBeenCalled(); // served from the promoted cache
  });
});

describe("JottacloudFileSessionImpl.readAsMarkdown", () => {
  it("converts the file's content and authorizes one observation", async () => {
    const { stub, observations } = fakeApprovalQueue();
    const backend = fakeBackend({
      getMetadata: vi.fn(async () => metadata({ mimeType: "application/pdf" })),
      read: vi.fn(async () => new TextEncoder().encode("pdf bytes").buffer),
    });
    const toMarkdown = vi.fn(async () => (
      { id: "1", name: "Guests.xlsx", mimeType: "application/pdf", format: "markdown" as const, tokens: 1, data: "# Guests" }
    ));
    const { kv } = mapKv();
    const session = new JottacloudFileSessionImpl(
      stub as never, {} as never, async () => "alice", backend as never, file, kv as never, fakeAi(toMarkdown));

    const result = await session.readAsMarkdown();
    expect(result).toEqual({ markdown: "# Guests", sourceMimeType: "application/pdf" });
    expect(toMarkdown).toHaveBeenCalledTimes(1);
    // One observation for getMetadata(), one for read(), one for the conversion itself.
    expect(observations).toHaveLength(3);
  });

  it("throws UNSUPPORTED_FOR_MARKDOWN without downloading content or calling toMarkdown", async () => {
    const { stub } = fakeApprovalQueue();
    const backend = fakeBackend({ getMetadata: vi.fn(async () => metadata({ mimeType: "image/png" })) });
    const toMarkdown = vi.fn();
    const { kv } = mapKv();
    const session = new JottacloudFileSessionImpl(
      stub as never, {} as never, async () => "alice", backend as never, file, kv as never, fakeAi(toMarkdown));

    await expect(session.readAsMarkdown()).rejects.toMatchObject({ code: "UNSUPPORTED_FOR_MARKDOWN" });
    expect(backend.read).not.toHaveBeenCalled();
    expect(toMarkdown).not.toHaveBeenCalled();
  });

  it("throws TOO_LARGE_FOR_MARKDOWN without downloading content or calling toMarkdown", async () => {
    const { stub } = fakeApprovalQueue();
    const backend = fakeBackend({
      getMetadata: vi.fn(async () => metadata({ mimeType: "application/pdf", size: 50_000_000 })),
    });
    const toMarkdown = vi.fn();
    const { kv } = mapKv();
    const session = new JottacloudFileSessionImpl(
      stub as never, {} as never, async () => "alice", backend as never, file, kv as never, fakeAi(toMarkdown));

    await expect(session.readAsMarkdown()).rejects.toMatchObject({ code: "TOO_LARGE_FOR_MARKDOWN" });
    expect(backend.read).not.toHaveBeenCalled();
    expect(toMarkdown).not.toHaveBeenCalled();
  });

  it("a second call at the same content MD5 is served from the markdown cache, skipping read() and toMarkdown()", async () => {
    const { stub } = fakeApprovalQueue();
    const backend = fakeBackend({
      getMetadata: vi.fn(async () => metadata({ mimeType: "application/pdf", md5: "same-md5" })),
      read: vi.fn(async () => new TextEncoder().encode("pdf bytes").buffer),
    });
    const toMarkdown = vi.fn(async () => (
      { id: "1", name: "Guests.xlsx", mimeType: "application/pdf", format: "markdown" as const, tokens: 1, data: "# Guests" }
    ));
    const { kv } = mapKv();
    const session = new JottacloudFileSessionImpl(
      stub as never, {} as never, async () => "alice", backend as never, file, kv as never, fakeAi(toMarkdown));

    const first = await session.readAsMarkdown();
    const second = await session.readAsMarkdown();
    expect(second).toEqual(first);
    expect(backend.read).toHaveBeenCalledTimes(1);
    expect(toMarkdown).toHaveBeenCalledTimes(1);
  });

  it("does not affect read()'s raw-bytes contract", async () => {
    const { stub } = fakeApprovalQueue();
    const raw = new TextEncoder().encode("pdf bytes").buffer;
    const backend = fakeBackend({
      getMetadata: vi.fn(async () => metadata({ mimeType: "application/pdf" })),
      read: vi.fn(async () => raw),
    });
    const { kv } = mapKv();
    const session = new JottacloudFileSessionImpl(
      stub as never, {} as never, async () => "alice", backend as never, file, kv as never, fakeAi());

    await session.readAsMarkdown();
    const rawResult = await session.read();
    expect(rawResult).toBe(raw);
  });
});
