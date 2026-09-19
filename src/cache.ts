/**
 * Caching and simulation for the bound file's metadata/content (write-gatekeeper skill, Phase 2:
 * "Caching" and "Simulation").
 *
 * Approach 1 from the skill ("mutate the cache on submit; invalidate on rejectAction()"): `write()`
 * computes the file's metadata as it will look once the upload lands and stores it as the
 * *simulated* state; `getMetadata()`/`read()` prefer that simulated state over the real cache while
 * a write is pending, so the caller sees its own not-yet-approved write immediately. `applyAction()`
 * promotes the simulated state to the confirmed real cache; `rejectAction()` discards it, which is
 * enough to fall back to the last confirmed state (or a fresh fetch) with no separate rollback data
 * to track, since nothing here was ever written to Jottacloud.
 *
 * Only the single most recently submitted pending write is tracked as "simulated" — a second write
 * submitted before the first resolves simply becomes the new simulated state, and resolving the
 * first (whichever order that happens in) only clears the overlay if it is still the latest one.
 * Good enough for a single-file resource, where concurrent pending writes are rare; documented here
 * rather than hidden, per the skill's guidance on simulation gaps.
 */

import type { FileMetadata, JottaFilePath } from "./jottacloud/types";

/** The subset of `DurableObjectStorage["kv"]` this module needs, for easy unit testing. */
export type CacheKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean | void;
};

/** How long a fetched metadata/content pair is trusted before re-fetching. */
export const CACHE_TTL_MS = 30_000;

/** Content above this size is not cached (kept only in the pending-write record until applied);
 * see README.md's Durable Object storage size caveat. */
export const CACHE_CONTENT_MAX_BYTES = 1_000_000;

const METADATA_KEY = "cache:metadata";
const CONTENT_KEY = "cache:content";
const SIMULATED_KEY = "sim:latest";

type CachedMetadata = { metadata: FileMetadata; fetchedAt: number };
type CachedContent = { md5: string; content: ArrayBuffer; fetchedAt: number };
export type SimulatedWrite = { actionId: number; metadata: FileMetadata };

export function getCachedMetadata(kv: CacheKv, now: number): FileMetadata | undefined {
  const cached = kv.get<CachedMetadata>(METADATA_KEY);
  if (!cached || now - cached.fetchedAt >= CACHE_TTL_MS) return undefined;
  return cached.metadata;
}

export function putCachedMetadata(kv: CacheKv, metadata: FileMetadata, now: number): void {
  kv.put<CachedMetadata>(METADATA_KEY, { metadata, fetchedAt: now });
}

/**
 * Returns fresh cached content and the MD5 it was fetched with, or `undefined` if nothing fresh is
 * cached. Callers that also hold a fresher metadata MD5 (from a `getCachedMetadata()` in the same
 * call) should still compare the two: this function alone only knows the content cache's own TTL,
 * not whether a separate, newer metadata read has since revealed the file changed.
 */
export function getCachedContent(kv: CacheKv, now: number): { md5: string; content: ArrayBuffer } | undefined {
  const cached = kv.get<CachedContent>(CONTENT_KEY);
  if (!cached || now - cached.fetchedAt >= CACHE_TTL_MS) return undefined;
  return { md5: cached.md5, content: cached.content };
}

/** No-ops for content over {@link CACHE_CONTENT_MAX_BYTES}: still returned to the caller, just not
 * retained, so a large file doesn't grow the gatekeeper's own Durable Object storage without bound. */
export function putCachedContent(kv: CacheKv, md5: string, content: ArrayBuffer, now: number): void {
  if (content.byteLength > CACHE_CONTENT_MAX_BYTES) return;
  kv.put<CachedContent>(CONTENT_KEY, { md5, content, fetchedAt: now });
}

export function getSimulatedWrite(kv: CacheKv): SimulatedWrite | undefined {
  return kv.get<SimulatedWrite>(SIMULATED_KEY);
}

export function setSimulatedWrite(kv: CacheKv, write: SimulatedWrite): void {
  kv.put<SimulatedWrite>(SIMULATED_KEY, write);
}

/** Idempotent: only clears the overlay if `actionId` is still the latest one, so resolving an
 * older, already-superseded write leaves a newer pending write's simulation alone. */
export function clearSimulatedWriteIfLatest(kv: CacheKv, actionId: number): void {
  const current = kv.get<SimulatedWrite>(SIMULATED_KEY);
  if (current?.actionId === actionId) kv.delete(SIMULATED_KEY);
}

/**
 * The metadata a write will produce once it lands, computed without contacting Jottacloud (we
 * already have the content and its MD5 locally). Fields Jottacloud alone controls and that writing
 * doesn't change (name, creation time) carry over from whatever state — simulated, cached, or
 * freshly fetched — was known before this write.
 */
export function simulateWriteMetadata(
  previous: FileMetadata | undefined, file: JottaFilePath, content: ArrayBuffer, md5: string, now: Date,
): FileMetadata {
  return {
    name: previous?.name ?? file.path.split("/").pop() ?? file.path,
    size: content.byteLength,
    md5,
    mimeType: previous?.mimeType ?? "application/octet-stream",
    createdAt: previous?.createdAt ?? now,
    modifiedAt: now,
    deleted: false,
  };
}
