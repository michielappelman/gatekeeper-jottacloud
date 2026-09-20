import { describe, expect, it } from "vitest";
import {
  CACHE_CONTENT_MAX_BYTES,
  CACHE_MARKDOWN_MAX_CHARS,
  CACHE_TTL_MS,
  clearSimulatedWriteIfLatest,
  getCachedContent,
  getCachedMarkdown,
  getCachedMetadata,
  getSimulatedWrite,
  putCachedContent,
  putCachedMarkdown,
  putCachedMetadata,
  setSimulatedWrite,
  simulateWriteMetadata,
  type CacheKv,
} from "../src/cache";
import type { FileMetadata } from "../src/jottacloud/types";

function fakeKv(): CacheKv {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string) => store.get(key) as T | undefined,
    put: <T>(key: string, value: T) => { store.set(key, value); },
    delete: (key: string) => store.delete(key),
  };
}

function metadata(overrides: Partial<FileMetadata> = {}): FileMetadata {
  return {
    name: "Guests.xlsx", size: 10, md5: "abc123", mimeType: "text/plain",
    createdAt: new Date("2026-01-01T00:00:00Z"), modifiedAt: new Date("2026-01-01T00:00:00Z"),
    deleted: false, ...overrides,
  };
}

describe("metadata cache", () => {
  it("returns undefined when nothing is cached", () => {
    expect(getCachedMetadata(fakeKv(), 1000)).toBeUndefined();
  });

  it("returns the cached value while fresh", () => {
    const kv = fakeKv();
    putCachedMetadata(kv, metadata(), 1000);
    expect(getCachedMetadata(kv, 1000 + CACHE_TTL_MS - 1)).toEqual(metadata());
  });

  it("expires exactly at the TTL boundary", () => {
    const kv = fakeKv();
    putCachedMetadata(kv, metadata(), 1000);
    expect(getCachedMetadata(kv, 1000 + CACHE_TTL_MS)).toBeUndefined();
  });
});

describe("content cache", () => {
  it("returns undefined when nothing is cached", () => {
    expect(getCachedContent(fakeKv(), 1000)).toBeUndefined();
  });

  it("returns the cached content and the MD5 it was fetched with, while fresh", () => {
    const kv = fakeKv();
    const content = new TextEncoder().encode("hello").buffer;
    putCachedContent(kv, "abc123", content, 1000);
    expect(getCachedContent(kv, 1000)).toEqual({ md5: "abc123", content });
  });

  it("expires after the TTL", () => {
    const kv = fakeKv();
    putCachedContent(kv, "abc123", new ArrayBuffer(1), 1000);
    expect(getCachedContent(kv, 1000 + CACHE_TTL_MS)).toBeUndefined();
  });

  it("does not cache content over the size cap", () => {
    const kv = fakeKv();
    const oversized = new ArrayBuffer(CACHE_CONTENT_MAX_BYTES + 1);
    putCachedContent(kv, "abc123", oversized, 1000);
    expect(getCachedContent(kv, 1000)).toBeUndefined();
  });

  it("caches content exactly at the size cap", () => {
    const kv = fakeKv();
    const atCap = new ArrayBuffer(CACHE_CONTENT_MAX_BYTES);
    putCachedContent(kv, "abc123", atCap, 1000);
    expect(getCachedContent(kv, 1000)).toEqual({ md5: "abc123", content: atCap });
  });
});

describe("markdown cache", () => {
  it("returns undefined when nothing is cached", () => {
    expect(getCachedMarkdown(fakeKv(), 1000)).toBeUndefined();
  });

  it("returns the cached markdown and the MD5 it was converted from, while fresh", () => {
    const kv = fakeKv();
    putCachedMarkdown(kv, { md5: "abc123", markdown: "# Hello", sourceMimeType: "application/pdf" }, 1000);
    expect(getCachedMarkdown(kv, 1000)).toEqual(
      { md5: "abc123", markdown: "# Hello", sourceMimeType: "application/pdf" });
  });

  it("expires after the TTL", () => {
    const kv = fakeKv();
    putCachedMarkdown(kv, { md5: "abc123", markdown: "# Hello", sourceMimeType: "application/pdf" }, 1000);
    expect(getCachedMarkdown(kv, 1000 + CACHE_TTL_MS)).toBeUndefined();
  });

  it("does not cache markdown over the size cap", () => {
    const kv = fakeKv();
    const oversized = "x".repeat(CACHE_MARKDOWN_MAX_CHARS + 1);
    putCachedMarkdown(kv, { md5: "abc123", markdown: oversized, sourceMimeType: "application/pdf" }, 1000);
    expect(getCachedMarkdown(kv, 1000)).toBeUndefined();
  });

  it("caches markdown exactly at the size cap", () => {
    const kv = fakeKv();
    const atCap = "x".repeat(CACHE_MARKDOWN_MAX_CHARS);
    putCachedMarkdown(kv, { md5: "abc123", markdown: atCap, sourceMimeType: "application/pdf" }, 1000);
    expect(getCachedMarkdown(kv, 1000)).toEqual(
      { md5: "abc123", markdown: atCap, sourceMimeType: "application/pdf" });
  });
});

describe("simulated write overlay", () => {
  it("is absent until a write sets it", () => {
    expect(getSimulatedWrite(fakeKv())).toBeUndefined();
  });

  it("clearSimulatedWriteIfLatest only clears when the id matches", () => {
    const kv = fakeKv();
    setSimulatedWrite(kv, { actionId: 5, metadata: metadata() });
    clearSimulatedWriteIfLatest(kv, 4); // an older, already-superseded action resolving late
    expect(getSimulatedWrite(kv)).toEqual({ actionId: 5, metadata: metadata() });

    clearSimulatedWriteIfLatest(kv, 5);
    expect(getSimulatedWrite(kv)).toBeUndefined();
  });

  it("clearing an id when nothing is simulated is a no-op", () => {
    const kv = fakeKv();
    expect(() => clearSimulatedWriteIfLatest(kv, 1)).not.toThrow();
  });
});

describe("simulateWriteMetadata", () => {
  const file = { device: "Jotta", mountpoint: "Archive", path: "Events/Guests.xlsx" };

  it("carries over name/mimeType/createdAt from the previous known state", () => {
    const previous = metadata({ name: "Guests.xlsx", mimeType: "application/vnd.ms-excel", createdAt: new Date("2020-01-01T00:00:00Z") });
    const now = new Date("2026-09-18T12:00:00Z");
    const content = new TextEncoder().encode("new content").buffer;
    const simulated = simulateWriteMetadata(previous, file, content, "new-md5", now);
    expect(simulated).toEqual({
      name: "Guests.xlsx",
      mimeType: "application/vnd.ms-excel",
      createdAt: new Date("2020-01-01T00:00:00Z"),
      size: content.byteLength,
      md5: "new-md5",
      modifiedAt: now,
      deleted: false,
    });
  });

  it("falls back to the file path and a generic MIME type when nothing is known yet", () => {
    const now = new Date("2026-09-18T12:00:00Z");
    const content = new ArrayBuffer(3);
    const simulated = simulateWriteMetadata(undefined, file, content, "md5", now);
    expect(simulated.name).toBe("Guests.xlsx");
    expect(simulated.mimeType).toBe("application/octet-stream");
    expect(simulated.createdAt).toEqual(now);
  });
});
