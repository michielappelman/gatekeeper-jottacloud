import { describe, expect, it, vi } from "vitest";
import { JottacloudFolderSessionImpl } from "../src/jottacloud";
import { JottacloudError, type JottacloudBackend } from "../src/jottacloud/client";
import type { FileMetadata, JottaFilePath } from "../src/jottacloud/types";
import type { FolderListEntry } from "../src/jottacloud/jfs";

const folder: JottaFilePath = { device: "Jotta", mountpoint: "Sync", path: "Documents" };
const rootFolder: JottaFilePath = { device: "Jotta", mountpoint: "Sync", path: "" };

function fileMetadata(overrides: Partial<FileMetadata> = {}): FileMetadata {
  return {
    name: "Guests.xlsx", size: 10, md5: "abc123", mimeType: "text/plain",
    createdAt: new Date("2026-09-01T00:00:00Z"), modifiedAt: new Date("2026-09-18T00:00:00Z"),
    deleted: false, ...overrides,
  };
}

function fakeBackend(overrides: Partial<JottacloudBackend> = {}): JottacloudBackend {
  return {
    getMetadata: vi.fn(async () => fileMetadata()),
    read: vi.fn(async () => new ArrayBuffer(0)),
    write: vi.fn(async () => fileMetadata()),
    list: vi.fn(async () => []),
    ...overrides,
  };
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

function session(
  backend: JottacloudBackend, boundFolder: JottaFilePath = folder,
  approvalQueue = fakeApprovalQueue(), kv = mapKv(), ai: Ai = {} as never,
) {
  return {
    approvalQueue,
    kv,
    session: new JottacloudFolderSessionImpl(
      approvalQueue.stub as never, async () => "alice", backend, boundFolder, kv.kv as never, ai),
  };
}

describe("JottacloudFolderSessionImpl.getScope", () => {
  it("returns the bound folder's identity", async () => {
    const { session: s } = session(fakeBackend());
    expect(await s.getScope()).toEqual({ device: "Jotta", mountpoint: "Sync", path: "Documents" });
  });

  it("reports an empty path for a mountpoint-root binding", async () => {
    const { session: s } = session(fakeBackend(), rootFolder);
    expect(await s.getScope()).toEqual({ device: "Jotta", mountpoint: "Sync", path: "" });
  });
});

describe("JottacloudFolderSessionImpl.list", () => {
  const entries: FolderListEntry[] = [
    { kind: "folder", name: "ProjectX", deleted: false },
    { kind: "folder", name: "Trashed", deleted: true },
    { kind: "file", ...fileMetadata({ name: "Guests.xlsx" }) },
  ];

  it("lists the bound folder's own root by default, mapping entries and dropping deleted ones", async () => {
    const backend = fakeBackend({ list: vi.fn(async () => entries) });
    const { session: s, approvalQueue } = session(backend);
    const result = await s.list();
    expect(backend.list).toHaveBeenCalledWith("alice", folder);
    expect(result).toEqual([
      { path: "Documents/ProjectX", name: "ProjectX", isFolder: true },
      {
        path: "Documents/Guests.xlsx", name: "Guests.xlsx", isFolder: false,
        size: 10, mimeType: "text/plain", md5: "abc123", modifiedAt: fileMetadata().modifiedAt,
      },
    ]);
    expect(approvalQueue.observations).toHaveLength(1);
  });

  it("lists a subfolder when given a relative path", async () => {
    const backend = fakeBackend({ list: vi.fn(async () => []) });
    const { session: s } = session(backend);
    await s.list("ProjectX");
    expect(backend.list).toHaveBeenCalledWith("alice", { device: "Jotta", mountpoint: "Sync", path: "Documents/ProjectX" });
  });

  it("lists the mountpoint root itself for a root-bound folder with no sub-path", async () => {
    const backend = fakeBackend({ list: vi.fn(async () => []) });
    const { session: s } = session(backend, rootFolder);
    await s.list();
    expect(backend.list).toHaveBeenCalledWith("alice", rootFolder);
  });

  it("rejects a relative path that tries to escape the bound folder", async () => {
    const { session: s } = session(fakeBackend());
    await expect(s.list("../../etc")).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
  });
});

describe("JottacloudFolderSessionImpl.getMetadata / read", () => {
  it("getMetadata resolves the relative path within the bound folder", async () => {
    const backend = fakeBackend({ getMetadata: vi.fn(async () => fileMetadata({ md5: "m1" })) });
    const { session: s } = session(backend);
    const result = await s.getMetadata("Guests.xlsx");
    expect(backend.getMetadata).toHaveBeenCalledWith("alice", { device: "Jotta", mountpoint: "Sync", path: "Documents/Guests.xlsx" });
    expect(result.md5).toBe("m1");
  });

  it("getMetadata rejects an empty path -- the folder itself has no file metadata", async () => {
    const { session: s } = session(fakeBackend());
    await expect(s.getMetadata("")).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
  });

  it("read resolves the relative path and returns the raw bytes", async () => {
    const bytes = new TextEncoder().encode("hello").buffer;
    const backend = fakeBackend({ read: vi.fn(async () => bytes) });
    const { session: s } = session(backend);
    const result = await s.read("Guests.xlsx");
    expect(backend.read).toHaveBeenCalledWith("alice", { device: "Jotta", mountpoint: "Sync", path: "Documents/Guests.xlsx" });
    expect(result).toBe(bytes);
  });

  it("rejects a traversal attempt on getMetadata/read before ever calling the backend", async () => {
    const backend = fakeBackend();
    const { session: s } = session(backend);
    await expect(s.getMetadata("../secrets.txt")).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    await expect(s.read("../secrets.txt")).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    expect(backend.getMetadata).not.toHaveBeenCalled();
    expect(backend.read).not.toHaveBeenCalled();
  });

  it("wraps an AUTH_EXPIRED backend error in a reconnect-prompting message", async () => {
    const backend = fakeBackend({
      getMetadata: vi.fn(async () => { throw new JottacloudError("AUTH_EXPIRED", "expired"); }),
    });
    const { session: s } = session(backend);
    await expect(s.getMetadata("Guests.xlsx")).rejects.toThrow(/reconnect/i);
  });
});

describe("JottacloudFolderSessionImpl.readAsMarkdown", () => {
  it("resolves the relative path, converts the content, and authorizes an observation", async () => {
    const backend = fakeBackend({
      getMetadata: vi.fn(async () => fileMetadata({ mimeType: "application/pdf" })),
      read: vi.fn(async () => new TextEncoder().encode("pdf bytes").buffer),
    });
    const toMarkdown = vi.fn(async () => (
      { id: "1", name: "Guests.xlsx", mimeType: "application/pdf", format: "markdown" as const, tokens: 1, data: "# Guests" }
    ));
    const { session: s, approvalQueue } = session(backend, folder, fakeApprovalQueue(), mapKv(), fakeAi(toMarkdown));

    const result = await s.readAsMarkdown("Guests.xlsx");
    expect(result).toEqual({ markdown: "# Guests", sourceMimeType: "application/pdf" });
    expect(backend.read).toHaveBeenCalledWith(
      "alice", { device: "Jotta", mountpoint: "Sync", path: "Documents/Guests.xlsx" });
    expect(approvalQueue.observations).toHaveLength(3); // getMetadata, read, conversion
  });

  it("throws UNSUPPORTED_FOR_MARKDOWN without downloading content", async () => {
    const backend = fakeBackend({ getMetadata: vi.fn(async () => fileMetadata({ mimeType: "image/png" })) });
    const { session: s } = session(backend);
    await expect(s.readAsMarkdown("Guests.xlsx")).rejects.toMatchObject({ code: "UNSUPPORTED_FOR_MARKDOWN" });
    expect(backend.read).not.toHaveBeenCalled();
  });

  it("rejects a traversal attempt before ever calling the backend", async () => {
    const backend = fakeBackend();
    const { session: s } = session(backend);
    await expect(s.readAsMarkdown("../secrets.txt")).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    expect(backend.getMetadata).not.toHaveBeenCalled();
  });

  it("does not affect read()'s raw-bytes contract", async () => {
    const raw = new TextEncoder().encode("pdf bytes").buffer;
    const backend = fakeBackend({
      getMetadata: vi.fn(async () => fileMetadata({ mimeType: "application/pdf" })),
      read: vi.fn(async () => raw),
    });
    const { session: s } = session(backend, folder, fakeApprovalQueue(), mapKv(), fakeAi());
    await s.readAsMarkdown("Guests.xlsx");
    const rawResult = await s.read("Guests.xlsx");
    expect(rawResult).toBe(raw);
  });
});

describe("JottacloudFolderSessionImpl.write", () => {
  it("submits a pending write for approval, keyed to the resolved file, without writing directly", async () => {
    const backend = fakeBackend();
    const { session: s, approvalQueue, kv } = session(backend);
    const content = new TextEncoder().encode("hi").buffer;
    await s.write("Guests.xlsx", content, "expected-md5");

    expect(backend.write).not.toHaveBeenCalled();
    expect(approvalQueue.actions).toHaveLength(1);
    expect(approvalQueue.actions[0].description).toMatchObject({
      title: "Write Jottacloud file", implementsRevert: false,
    });
    const pending = kv.store.get("write:pending:1") as { file: JottaFilePath; content: ArrayBuffer; ifMatchMd5?: string };
    expect(pending.file).toEqual({ device: "Jotta", mountpoint: "Sync", path: "Documents/Guests.xlsx" });
    expect(pending.ifMatchMd5).toBe("expected-md5");
  });

  it("rejects writing to the folder's own root (empty path)", async () => {
    const { session: s } = session(fakeBackend());
    await expect(s.write("", new ArrayBuffer(0))).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
  });

  it("rejects a traversal attempt without ever queuing a pending write", async () => {
    const { session: s, kv } = session(fakeBackend());
    await expect(s.write("../escape.txt", new ArrayBuffer(0))).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    expect(kv.store.size).toBe(0);
  });

  it("cleans up the pending write if the approval queue rejects the submission", async () => {
    const approvalQueue = fakeApprovalQueue();
    approvalQueue.stub.submitAction = vi.fn(async () => { throw new Error("denied"); });
    const { session: s, kv } = session(fakeBackend(), folder, approvalQueue);
    await expect(s.write("Guests.xlsx", new ArrayBuffer(0))).rejects.toThrow("denied");
    expect(kv.store.has("write:pending:1")).toBe(false);
  });

  it("allocates increasing action IDs across successive writes", async () => {
    const { session: s, kv } = session(fakeBackend());
    await s.write("a.txt", new ArrayBuffer(0));
    await s.write("b.txt", new ArrayBuffer(0));
    expect(kv.store.has("write:pending:1")).toBe(true);
    expect(kv.store.has("write:pending:2")).toBe(true);
  });
});
