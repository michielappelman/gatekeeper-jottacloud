import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE,
  DEFAULT_MOUNTPOINT,
  isFolderResourceUrl,
  JOTTACLOUD_FILE_RESOURCE,
  JOTTACLOUD_FOLDER_RESOURCE,
  normalizeFilePath,
  normalizeFolderPath,
  parseFolderResourceUrl,
  parseResourceUrl,
  resolveWithinFolder,
  SUPPORTED_RESOURCES,
  toFolderResourceUrl,
  toResourceUrl,
} from "../src/resource";

/** The message `parseResourceUrl` rejects `url` with. Fails the test if it accepts it. */
function rejectionMessage(url: string): string {
  try {
    parseResourceUrl(url);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected ${url} to be rejected`);
}

describe("resource declarations", () => {
  it("pins each grantable resource's urlPattern", () => {
    // Permanent identity: never change these after deploy (see resource.ts doc comment).
    expect(SUPPORTED_RESOURCES.map(r => r.urlPattern)).toEqual([
      "https://jfs.jottacloud.com/jfs/*",
      "https://jfs.jottacloud.com/jfs-folder/*",
    ]);
  });
});

describe("normalizeFilePath / toResourceUrl / parseResourceUrl round trip", () => {
  it("round-trips a simple path", () => {
    const file = normalizeFilePath("", "", "Events/Guests.xlsx");
    expect(file).toEqual({ device: DEFAULT_DEVICE, mountpoint: DEFAULT_MOUNTPOINT, path: "Events/Guests.xlsx" });
    const url = toResourceUrl(file);
    expect(parseResourceUrl(url)).toEqual(file);
  });

  it("trims slashes and defaults device/mountpoint when blank", () => {
    const file = normalizeFilePath("  ", "  ", "/Notes.md/");
    expect(file).toEqual({ device: "Jotta", mountpoint: "Sync", path: "Notes.md" });
  });

  it("preserves an explicit device and mountpoint", () => {
    const file = normalizeFilePath("MyPhone", "Camera Archive", "2026/photo.jpg");
    expect(file).toEqual({ device: "MyPhone", mountpoint: "Camera Archive", path: "2026/photo.jpg" });
    expect(parseResourceUrl(toResourceUrl(file))).toEqual(file);
  });

  it("percent-encodes special characters in the resource URL", () => {
    const file = normalizeFilePath("Jotta", "Archive", "Q3 Report (draft).xlsx");
    const url = toResourceUrl(file);
    expect(url).toBe("https://jfs.jottacloud.com/jfs/Jotta/Archive/Q3%20Report%20(draft).xlsx");
    expect(parseResourceUrl(url)).toEqual(file);
  });
});

describe("security: resource-path validation", () => {
  it("rejects a '..' segment via normalizeFilePath (the configurator form input path)", () => {
    expect(() => normalizeFilePath("Jotta", "Archive", "../secrets.txt")).toThrow(/\.\./);
  });

  it("rejects a resource URL containing '..' — the WHATWG URL parser collapses it before we ever " +
     "see it, which only strengthens the defense in normalizeFilePath's explicit check", () => {
    // "/jfs/Jotta/Archive/../secrets.txt" normalizes to "/jfs/Jotta/secrets.txt": too few segments
    // to name a device+mountpoint+path, so it is still rejected, just for that reason instead.
    expect(() => parseResourceUrl("https://jfs.jottacloud.com/jfs/Jotta/Archive/../secrets.txt")).toThrow();
  });

  it("rejects a '..' segment in the middle of the path", () => {
    expect(() => normalizeFilePath("Jotta", "Archive", "Events/../../Other/file.txt")).toThrow(/\.\./);
  });

  it("rejects an empty path", () => {
    expect(() => normalizeFilePath("Jotta", "Archive", "")).toThrow(/required/);
    expect(() => normalizeFilePath("Jotta", "Archive", "///")).toThrow(/required/);
  });

  it("rejects a '.' segment", () => {
    expect(() => normalizeFilePath("Jotta", "Archive", "./file.txt")).toThrow(/"\."/);
  });

  it("rejects a URL on a different host (resource substitution)", () => {
    expect(rejectionMessage("https://evil.example.com/jfs/Jotta/Archive/file.txt")).toMatch(/Unsupported/);
  });

  it("rejects a URL missing the /jfs/ prefix", () => {
    expect(rejectionMessage("https://jfs.jottacloud.com/Jotta/Archive/file.txt")).toMatch(/jfs.jottacloud.com\/jfs/);
  });

  it("rejects a URL with too few path segments", () => {
    expect(rejectionMessage("https://jfs.jottacloud.com/jfs/Jotta")).toMatch(/jfs.jottacloud.com\/jfs/);
  });

  it("rejects an unparseable URL", () => {
    expect(rejectionMessage("not-a-url")).toMatch(/Not a valid resource URL/);
  });

  it("rejects a non-https protocol", () => {
    expect(rejectionMessage("http://jfs.jottacloud.com/jfs/Jotta/Archive/file.txt")).toMatch(/Unsupported/);
  });
});

describe("isFolderResourceUrl", () => {
  it("distinguishes the folder prefix from the file prefix", () => {
    expect(isFolderResourceUrl("https://jfs.jottacloud.com/jfs-folder/Jotta/Sync")).toBe(true);
    expect(isFolderResourceUrl("https://jfs.jottacloud.com/jfs/Jotta/Sync/Notes.md")).toBe(false);
  });

  it("returns false rather than throwing on an unparseable URL", () => {
    expect(isFolderResourceUrl("not-a-url")).toBe(false);
  });
});

describe("normalizeFolderPath / toFolderResourceUrl / parseFolderResourceUrl round trip", () => {
  it("round-trips a subfolder path", () => {
    const folder = normalizeFolderPath("", "", "Documents/ProjectX");
    expect(folder).toEqual({ device: DEFAULT_DEVICE, mountpoint: DEFAULT_MOUNTPOINT, path: "Documents/ProjectX" });
    const url = toFolderResourceUrl(folder);
    expect(url).toBe(`https://jfs.jottacloud.com/jfs-folder/${DEFAULT_DEVICE}/${DEFAULT_MOUNTPOINT}/Documents/ProjectX`);
    expect(parseFolderResourceUrl(url)).toEqual(folder);
  });

  it("accepts an empty path as the mountpoint's own root, unlike normalizeFilePath", () => {
    const folder = normalizeFolderPath("Jotta", "Sync", "");
    expect(folder).toEqual({ device: "Jotta", mountpoint: "Sync", path: "" });
    const url = toFolderResourceUrl(folder);
    expect(url).toBe("https://jfs.jottacloud.com/jfs-folder/Jotta/Sync");
    expect(parseFolderResourceUrl(url)).toEqual(folder);
  });

  it("trims slashes and defaults device/mountpoint when blank", () => {
    const folder = normalizeFolderPath("  ", "  ", "/Documents/");
    expect(folder).toEqual({ device: "Jotta", mountpoint: "Sync", path: "Documents" });
  });

  it("rejects a folder path containing '..'", () => {
    expect(() => normalizeFolderPath("Jotta", "Sync", "../secrets")).toThrow(/\.\./);
  });

  it("rejects a folder URL missing the /jfs-folder/ prefix", () => {
    expect(() => parseFolderResourceUrl("https://jfs.jottacloud.com/jfs/Jotta/Sync"))
      .toThrow(/jfs-folder/);
  });

  it("rejects a folder URL with too few segments (no device/mountpoint at all)", () => {
    expect(() => parseFolderResourceUrl("https://jfs.jottacloud.com/jfs-folder/Jotta")).toThrow(/jfs-folder/);
  });

  it("rejects a folder URL on a different host", () => {
    expect(() => parseFolderResourceUrl("https://evil.example.com/jfs-folder/Jotta/Sync")).toThrow(/Unsupported/);
  });
});

describe("resolveWithinFolder", () => {
  const folder = { device: "Jotta", mountpoint: "Sync", path: "Documents" };
  const rootFolder = { device: "Jotta", mountpoint: "Sync", path: "" };

  it("joins a relative path onto the bound folder", () => {
    expect(resolveWithinFolder(folder, "Guests.xlsx")).toEqual(
      { device: "Jotta", mountpoint: "Sync", path: "Documents/Guests.xlsx" });
    expect(resolveWithinFolder(folder, "ProjectX/Report.pdf")).toEqual(
      { device: "Jotta", mountpoint: "Sync", path: "Documents/ProjectX/Report.pdf" });
  });

  it("joins onto a root-bound folder without a leading slash", () => {
    expect(resolveWithinFolder(rootFolder, "Notes.md")).toEqual(
      { device: "Jotta", mountpoint: "Sync", path: "Notes.md" });
  });

  it("returns the folder itself for an empty, or all-slashes, relative path", () => {
    expect(resolveWithinFolder(folder, "")).toEqual(folder);
    expect(resolveWithinFolder(folder, "///")).toEqual(folder);
  });

  it("strips a leading slash", () => {
    expect(resolveWithinFolder(folder, "/Guests.xlsx")).toEqual(
      { device: "Jotta", mountpoint: "Sync", path: "Documents/Guests.xlsx" });
  });

  it("rejects a '..' segment trying to escape the bound folder", () => {
    expect(() => resolveWithinFolder(folder, "../Other/file.txt")).toThrow(/\.\./);
    expect(() => resolveWithinFolder(folder, "../../../etc/passwd")).toThrow(/\.\./);
  });

  it("rejects a '.' segment", () => {
    expect(() => resolveWithinFolder(folder, "./Guests.xlsx")).toThrow(/"\."/);
  });

  it("rejects an internal empty segment", () => {
    expect(() => resolveWithinFolder(folder, "Sub//file.txt")).toThrow();
  });
});
