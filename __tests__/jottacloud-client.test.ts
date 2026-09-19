import { describe, expect, it } from "vitest";
import { DirectJottacloudBackend, JottacloudError } from "../src/jottacloud/client";

const file = { device: "Jotta", mountpoint: "Archive", path: "Guests.xlsx" };

const METADATA_XML = `<file name="Guests.xlsx"><currentRevision><state>COMPLETED</state>
<created>2026-09-01-T10:00:00+0000</created><modified>2026-09-18-T12:00:00+0000</modified>
<size>11</size><mime>text/plain</mime><md5>5eb63bbbe01eeed093cb22bb8f5acdc3</md5></currentRevision></file>`;

const DELETED_METADATA_XML = METADATA_XML.replace('<file name="Guests.xlsx">', '<file name="Guests.xlsx" deleted="true">');

function router(handlers: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const key = `${url.origin}${url.pathname}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return handler();
  }) as typeof fetch;
}

describe("DirectJottacloudBackend", () => {
  it("getMetadata returns parsed metadata", async () => {
    const fetchImpl = router({
      "https://jfs.jottacloud.com/jfs/alice/Jotta/Archive/Guests.xlsx": () => new Response(METADATA_XML, { status: 200 }),
    });
    const backend = new DirectJottacloudBackend(async () => "token", fetchImpl);
    const metadata = await backend.getMetadata("alice", file);
    expect(metadata.md5).toBe("5eb63bbbe01eeed093cb22bb8f5acdc3");
  });

  it("getMetadata surfaces a deleted file as RESOURCE_NOT_FOUND", async () => {
    const fetchImpl = router({
      "https://jfs.jottacloud.com/jfs/alice/Jotta/Archive/Guests.xlsx": () => new Response(DELETED_METADATA_XML, { status: 200 }),
    });
    const backend = new DirectJottacloudBackend(async () => "token", fetchImpl);
    await expect(backend.getMetadata("alice", file)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("read downloads and returns the raw bytes", async () => {
    const fetchImpl = router({
      "https://jfs.jottacloud.com/jfs/alice/Jotta/Archive/Guests.xlsx": () => new Response("hello world", { status: 200 }),
    });
    const backend = new DirectJottacloudBackend(async () => "token", fetchImpl);
    const content = await backend.read("alice", file);
    expect(new TextDecoder().decode(content)).toBe("hello world");
  });

  it("write allocates, uploads, and re-reads metadata to confirm the new revision", async () => {
    let allocateBody: Record<string, unknown> | undefined;
    let uploadedBody: ArrayBuffer | undefined;
    const fetchImpl = router({
      "https://api.jottacloud.com/files/v1/allocate": () => new Response(
        JSON.stringify({ state: "INCOMPLETE", upload_url: "https://up.jottacloud.com/session1", resume_pos: 0 }), { status: 200 }),
      "https://up.jottacloud.com/session1": () => new Response("", { status: 200 }),
      "https://jfs.jottacloud.com/jfs/alice/Jotta/Archive/Guests.xlsx": () => new Response(METADATA_XML, { status: 200 }),
    });
    // Wrap to capture bodies without complicating the router.
    const capturingFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://api.jottacloud.com/files/v1/allocate") allocateBody = JSON.parse(init?.body as string);
      if (url === "https://up.jottacloud.com/session1") uploadedBody = init?.body as ArrayBuffer;
      return fetchImpl(input as never, init);
    };
    const backend = new DirectJottacloudBackend(async () => "token", capturingFetch);
    const content = new TextEncoder().encode("hello world").buffer;
    const metadata = await backend.write("alice", file, content);

    expect(allocateBody).toMatchObject({ path: "/jfs/Jotta/Archive/Guests.xlsx", bytes: 11, md5: "5eb63bbbe01eeed093cb22bb8f5acdc3" });
    expect(new TextDecoder().decode(uploadedBody)).toBe("hello world");
    expect(metadata.md5).toBe("5eb63bbbe01eeed093cb22bb8f5acdc3");
  });

  it("propagates a rate-limit error as RATE_LIMITED after retries are exhausted", async () => {
    const fetchImpl: typeof fetch = async () => new Response("busy", { status: 429 });
    const backend = new DirectJottacloudBackend(async () => "token", fetchImpl);
    const error: unknown = await backend.getMetadata("alice", file).catch(e => e);
    expect(error).toBeInstanceOf(JottacloudError);
    expect((error as JottacloudError).code).toBe("RATE_LIMITED");
  });

  it("list fetches and parses a folder's immediate contents", async () => {
    const FOLDER_XML = `<mountPoint><folders><folder name="Events"/></folders><files>
      <file name="Notes.md"><currentRevision><state>COMPLETED</state>
      <created>2026-09-01-T10:00:00+0000</created><modified>2026-09-18-T12:00:00+0000</modified>
      <size>42</size><mime>text/markdown</mime><md5>abc123</md5></currentRevision></file>
    </files></mountPoint>`;
    const fetchImpl = router({
      "https://jfs.jottacloud.com/jfs/alice/Jotta/Archive": () => new Response(FOLDER_XML, { status: 200 }),
    });
    const backend = new DirectJottacloudBackend(async () => "token", fetchImpl);
    const entries = await backend.list("alice", { device: "Jotta", mountpoint: "Archive", path: "" });
    expect(entries).toEqual([
      { kind: "folder", name: "Events", deleted: false },
      {
        kind: "file", name: "Notes.md", size: 42, md5: "abc123", mimeType: "text/markdown",
        createdAt: new Date("2026-09-01T10:00:00.000Z"), modifiedAt: new Date("2026-09-18T12:00:00.000Z"),
        deleted: false,
      },
    ]);
  });
});
