import { describe, expect, it } from "vitest";
import {
  downloadFile,
  getMetadata,
  jfsUrlPath,
  listDevices,
  listFolder,
  listMountpoints,
  parseJottaFileXml,
  parseJottaFolderXml,
} from "../src/jottacloud/jfs";

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<file name="Guests.xlsx" time="2026.09.18-12.00.00" host="dn-101">
  <currentRevision>
    <number>3</number>
    <state>COMPLETED</state>
    <created>2026-09-01-T10:00:00+0200</created>
    <modified>2026-09-18-T12:34:56+0200</modified>
    <updated>2026-09-18-T12:35:00+0200</updated>
    <size>12345</size>
    <mime>application/vnd.openxmlformats-officedocument.spreadsheetml.sheet</mime>
    <md5>d41d8cd98f00b204e9800998ecf8427e</md5>
</currentRevision>
</file>`;

describe("parseJottaFileXml", () => {
  it("parses the currentRevision fields", () => {
    const metadata = parseJottaFileXml(SAMPLE_XML);
    expect(metadata.name).toBe("Guests.xlsx");
    expect(metadata.size).toBe(12345);
    expect(metadata.md5).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(metadata.mimeType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(metadata.deleted).toBe(false);
    // "2026-09-18-T12:34:56+0200" -> 10:34:56 UTC.
    expect(metadata.modifiedAt.toISOString()).toBe("2026-09-18T10:34:56.000Z");
    expect(metadata.createdAt.toISOString()).toBe("2026-09-01T08:00:00.000Z");
  });

  it("detects the deleted attribute regardless of its value", () => {
    const xml = SAMPLE_XML.replace('<file name="Guests.xlsx"', '<file name="Guests.xlsx" deleted="true"');
    expect(parseJottaFileXml(xml).deleted).toBe(true);
  });

  it("decodes XML entities in the file name", () => {
    const xml = SAMPLE_XML.replace("Guests.xlsx", "Q3 &amp; Q4.xlsx");
    expect(parseJottaFileXml(xml).name).toBe("Q3 & Q4.xlsx");
  });

  it("throws a descriptive error for unrecognized XML", () => {
    expect(() => parseJottaFileXml("<not-a-file/>")).toThrow(/not understood/);
  });
});

// Real recorded example (rclone's backend/jottacloud/api/types.go doc comments), not a guess:
// folders come back self-closing with attributes only, and device/mountpoint field values are
// wrapped with an xml:space="preserve" attribute rather than a bare tag.
const SAMPLE_FOLDER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mountPoint time="2026.09.18-12.00.00" host="dn-101">
  <name xml:space="preserve">Archive</name>
  <path xml:space="preserve">/alice/Jotta/Archive</path>
  <folders>
    <folder name="Events" time="2026.09.01-10.00.00"/>
    <folder name="Trashed" deleted="true"/>
  </folders>
  <files>
    <file name="Notes.md" time="2026.09.18-12.00.00">
      <currentRevision>
        <state>COMPLETED</state>
        <created>2026-09-01-T10:00:00+0200</created>
        <modified>2026-09-18-T12:34:56+0200</modified>
        <size>42</size>
        <mime>text/markdown</mime>
        <md5>abc123</md5>
      </currentRevision>
    </file>
  </files>
</mountPoint>`;

const SAMPLE_DEVICES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<user time="2026.09.18-12.00.00" host="dn-101">
  <username>alice</username>
  <devices>
    <device>
      <name xml:space="preserve">Jotta</name>
      <display_name xml:space="preserve">Jotta</display_name>
      <type>JOTTA</type>
      <size>123456</size>
    </device>
    <device>
      <name xml:space="preserve">Chromebook</name>
      <display_name xml:space="preserve">My Chromebook</display_name>
      <type>CHROME</type>
      <size>0</size>
    </device>
  </devices>
</user>`;

const SAMPLE_MOUNTPOINTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<device time="2026.09.18-12.00.00" host="dn-101">
  <name xml:space="preserve">Jotta</name>
  <mountPoints>
    <mountPoint>
      <name xml:space="preserve">Archive</name>
      <size>123456</size>
    </mountPoint>
    <mountPoint>
      <name xml:space="preserve">Sync</name>
      <size>0</size>
    </mountPoint>
  </mountPoints>
</device>`;

describe("parseJottaFolderXml", () => {
  it("parses immediate subfolders and files, skipping neither on the deleted flag", () => {
    const entries = parseJottaFolderXml(SAMPLE_FOLDER_XML);
    expect(entries).toEqual([
      { kind: "folder", name: "Events", deleted: false },
      { kind: "folder", name: "Trashed", deleted: true },
      {
        kind: "file",
        name: "Notes.md",
        size: 42,
        md5: "abc123",
        mimeType: "text/markdown",
        createdAt: new Date("2026-09-01T08:00:00.000Z"),
        modifiedAt: new Date("2026-09-18T10:34:56.000Z"),
        deleted: false,
      },
    ]);
  });

  it("returns no entries for a response with no folders/files blocks (a file, not a directory)", () => {
    expect(parseJottaFolderXml(SAMPLE_XML)).toEqual([]);
  });
});

describe("listFolder", () => {
  it("lists a mountpoint's own root when path is empty", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(SAMPLE_FOLDER_XML, { status: 200 });
    };
    const entries = await listFolder(
      { device: "Jotta", mountpoint: "Archive", path: "" }, "alice", async () => "t", fetchImpl as typeof fetch);
    expect(capturedUrl).toBe("https://jfs.jottacloud.com/jfs/alice/Jotta/Archive");
    expect(entries).toHaveLength(3);
  });

  it("maps a 404 to RESOURCE_NOT_FOUND for a directory that doesn't exist", async () => {
    const fetchImpl = async () => new Response("not found", { status: 404 });
    await expect(listFolder(
      { device: "Jotta", mountpoint: "Archive", path: "Nope" }, "alice", async () => "t", fetchImpl as typeof fetch))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});

describe("listDevices", () => {
  it("fetches the account root and parses each device's element-form fields", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(SAMPLE_DEVICES_XML, { status: 200 });
    };
    const devices = await listDevices("alice", async () => "t", fetchImpl as typeof fetch);
    expect(capturedUrl).toBe("https://jfs.jottacloud.com/jfs/alice");
    expect(devices).toEqual([
      { name: "Jotta", displayName: "Jotta", type: "JOTTA", sizeBytes: 123456 },
      { name: "Chromebook", displayName: "My Chromebook", type: "CHROME", sizeBytes: 0 },
    ]);
  });
});

describe("listMountpoints", () => {
  it("fetches the device root and parses each mountpoint", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(SAMPLE_MOUNTPOINTS_XML, { status: 200 });
    };
    const mountpoints = await listMountpoints("alice", "Jotta", async () => "t", fetchImpl as typeof fetch);
    expect(capturedUrl).toBe("https://jfs.jottacloud.com/jfs/alice/Jotta");
    expect(mountpoints).toEqual([
      { name: "Archive", sizeBytes: 123456 },
      { name: "Sync", sizeBytes: 0 },
    ]);
  });
});

describe("jfsUrlPath", () => {
  it("joins username/device/mountpoint/path, encoding each segment", () => {
    const path = jfsUrlPath("alice", { device: "Jotta", mountpoint: "Archive", path: "Q3 Report.xlsx" });
    expect(path).toBe("alice/Jotta/Archive/Q3%20Report.xlsx");
  });

  it("omits the trailing segment for an empty path (mountpoint-root browsing)", () => {
    const path = jfsUrlPath("alice", { device: "Jotta", mountpoint: "Archive", path: "" });
    expect(path).toBe("alice/Jotta/Archive");
  });

  it("encodes a path with multiple segments", () => {
    const path = jfsUrlPath("alice", { device: "Jotta", mountpoint: "Archive", path: "Events/Guests.xlsx" });
    expect(path).toBe("alice/Jotta/Archive/Events/Guests.xlsx");
  });

  it("escapes '+' the way rclone's urlPathEscape does", () => {
    const path = jfsUrlPath("alice", { device: "Jotta", mountpoint: "Archive", path: "a+b.txt" });
    expect(path).toBe("alice/Jotta/Archive/a%2Bb.txt");
  });
});

describe("getMetadata", () => {
  const file = { device: "Jotta", mountpoint: "Archive", path: "Guests.xlsx" };

  it("fetches with a bearer token and parses the XML body", async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(SAMPLE_XML, { status: 200 });
    };
    const metadata = await getMetadata(file, "alice", async () => "token-123", fetchImpl as typeof fetch);
    expect(capturedUrl).toBe("https://jfs.jottacloud.com/jfs/alice/Jotta/Archive/Guests.xlsx");
    expect(capturedAuth).toBe("Bearer token-123");
    expect(metadata.md5).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });

  it("maps a 404 to RESOURCE_NOT_FOUND", async () => {
    const fetchImpl = async () => new Response("not found", { status: 404 });
    await expect(getMetadata(file, "alice", async () => "t", fetchImpl as typeof fetch))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("maps a 401 to AUTH_EXPIRED", async () => {
    const fetchImpl = async () => new Response("unauthorized", { status: 401 });
    await expect(getMetadata(file, "alice", async () => "t", fetchImpl as typeof fetch))
      .rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("retries a 503 and eventually succeeds", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts++;
      if (attempts < 2) return new Response("unavailable", { status: 503 });
      return new Response(SAMPLE_XML, { status: 200 });
    };
    const metadata = await getMetadata(file, "alice", async () => "t", fetchImpl as typeof fetch);
    expect(attempts).toBe(2);
    expect(metadata.name).toBe("Guests.xlsx");
  });
});

describe("downloadFile", () => {
  const file = { device: "Jotta", mountpoint: "Archive", path: "Guests.xlsx" };

  it("requests mode=bin", async () => {
    let capturedUrl: URL | undefined;
    const fetchImpl = async (input: string | URL | Request) => {
      capturedUrl = new URL(String(input));
      return new Response("binary content", { status: 200 });
    };
    const response = await downloadFile(file, "alice", async () => "t", undefined, fetchImpl as typeof fetch);
    expect(capturedUrl?.searchParams.get("mode")).toBe("bin");
    expect(await response.text()).toBe("binary content");
  });

  it("sends a Range header when a byte range is given", async () => {
    let capturedRange: string | undefined;
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      capturedRange = (init?.headers as Record<string, string>)?.Range;
      return new Response("chunk", { status: 206 });
    };
    await downloadFile(file, "alice", async () => "t", { start: 10, end: 20 }, fetchImpl as typeof fetch);
    expect(capturedRange).toBe("bytes=10-20");
  });

  it("maps a download failure to DOWNLOAD_FAILED", async () => {
    const fetchImpl = async () => new Response("nope", { status: 418 });
    await expect(downloadFile(file, "alice", async () => "t", undefined, fetchImpl as typeof fetch))
      .rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
  });
});
