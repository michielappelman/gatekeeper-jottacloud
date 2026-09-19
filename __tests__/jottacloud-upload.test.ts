import { describe, expect, it } from "vitest";
import { allocateUpload, uploadContent } from "../src/jottacloud/upload";

const file = { device: "Jotta", mountpoint: "Archive", path: "Events/Guests.xlsx" };

describe("allocateUpload", () => {
  it("posts the rclone-verified allocate request shape", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    let capturedAuth: string | undefined;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ state: "INCOMPLETE", upload_url: "https://up.jottacloud.com/xyz", resume_pos: 0 }), { status: 200 });
    };
    const session = await allocateUpload(
      file, { size: 5, md5: "abc123", modified: new Date("2026-09-18T12:00:00Z") },
      async () => "token", fetchImpl as typeof fetch);
    expect(capturedUrl).toBe("https://api.jottacloud.com/files/v1/allocate");
    expect(capturedAuth).toBe("Bearer token");
    expect(capturedBody).toMatchObject({
      path: "/jfs/Jotta/Archive/Events/Guests.xlsx",
      bytes: 5,
      md5: "abc123",
      modified: "2026-09-18T12:00:00.000Z",
    });
    expect(session).toEqual({ uploadUrl: "https://up.jottacloud.com/xyz", resumePos: 0, completed: false });
  });

  it("reports completed when Jottacloud already has the content (dedup by MD5)", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ state: "COMPLETED" }), { status: 200 });
    const session = await allocateUpload(file, { size: 5, md5: "abc" }, async () => "t", fetchImpl as typeof fetch);
    expect(session.completed).toBe(true);
  });

  it("throws UPLOAD_FAILED when the response has neither COMPLETED state nor an upload URL", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ state: "INCOMPLETE" }), { status: 200 });
    await expect(allocateUpload(file, { size: 5, md5: "abc" }, async () => "t", fetchImpl as typeof fetch))
      .rejects.toMatchObject({ code: "UPLOAD_FAILED" });
  });

  it("maps a non-ok allocate response through errorForStatus", async () => {
    const fetchImpl = async () => new Response("denied", { status: 403 });
    await expect(allocateUpload(file, { size: 5, md5: "abc" }, async () => "t", fetchImpl as typeof fetch))
      .rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("uploadContent", () => {
  it("posts the remaining bytes as octet-stream", async () => {
    let capturedBody: unknown;
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body;
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response("", { status: 200 });
    };
    const content = new TextEncoder().encode("hello world").buffer;
    await uploadContent(
      { uploadUrl: "https://up.jottacloud.com/xyz", resumePos: 0, completed: false }, content,
      async () => "token", fetchImpl as typeof fetch);
    expect(capturedHeaders?.["Content-Type"]).toBe("application/octet-stream");
    expect(capturedHeaders?.Authorization).toBe("Bearer token");
    expect(capturedHeaders?.["Content-Range"]).toBeUndefined();
    expect(new TextDecoder().decode(capturedBody as ArrayBuffer)).toBe("hello world");
  });

  it("sends only the unsent tail with a Content-Range header when resuming", async () => {
    let capturedBody: unknown;
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body;
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response("", { status: 200 });
    };
    const content = new TextEncoder().encode("hello world").buffer; // 11 bytes
    await uploadContent(
      { uploadUrl: "https://up.jottacloud.com/xyz", resumePos: 6, completed: false }, content,
      async () => "token", fetchImpl as typeof fetch);
    expect(capturedHeaders?.["Content-Range"]).toBe("bytes 6-10/11");
    expect(new TextDecoder().decode(capturedBody as ArrayBuffer)).toBe("world");
  });

  it("does nothing when the allocate step already completed the upload", async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return new Response("", { status: 200 }); };
    await uploadContent(
      { uploadUrl: "https://up.jottacloud.com/xyz", resumePos: 0, completed: true },
      new ArrayBuffer(0), async () => "t", fetchImpl as typeof fetch);
    expect(called).toBe(false);
  });

  it("maps a non-ok upload response to UPLOAD_FAILED", async () => {
    const fetchImpl = async () => new Response("boom", { status: 400 });
    await expect(uploadContent(
      { uploadUrl: "https://up.jottacloud.com/xyz", resumePos: 0, completed: false },
      new ArrayBuffer(1), async () => "t", fetchImpl as typeof fetch),
    ).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
  });
});
