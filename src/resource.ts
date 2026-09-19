/**
 * The grantable resources this gatekeeper offers — a single Jottacloud file, or a folder — and the
 * parsers that turn a bound resource URL into the {@link JottaFilePath} its gatekeeper Durable
 * Object takes.
 *
 * A resource's `urlPattern` is permanent identity: do not change one after deploy. The file and
 * folder resources share the same `{device, mountpoint, path}` addressing scheme but cannot share a
 * URL shape because JFS does not distinguish files from folders syntactically. The folder resource
 * therefore uses the distinct `jfs-folder` prefix so routing can happen from the URL alone.
 *
 * A file binding names exactly one file; its session has no path argument and cannot be retargeted.
 * A folder binding names one folder (possibly the mountpoint root); session paths are relative to
 * it and are validated by {@link resolveWithinFolder}.
 */

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { JottacloudError } from "./jottacloud/errors";
import { DEFAULT_DEVICE, DEFAULT_MOUNTPOINT } from "./jottacloud/jfs";
import type { JottaFilePath } from "./jottacloud/types";

export { DEFAULT_DEVICE, DEFAULT_MOUNTPOINT };

/** Host used for this gatekeeper's synthetic resource-identity URLs (the real JFS API host). */
const RESOURCE_HOST = "jfs.jottacloud.com";

export const JOTTACLOUD_FILE_RESOURCE: SupportedResource = {
  urlPattern: `https://${RESOURCE_HOST}/jfs/*`,
  title: "Jottacloud File",
  description: "Read metadata and content, and upload new revisions, for one file you choose in Jottacloud.",
};

export const JOTTACLOUD_FOLDER_RESOURCE: SupportedResource = {
  urlPattern: `https://${RESOURCE_HOST}/jfs-folder/*`,
  title: "Jottacloud Folder",
  description:
      "List, read, and write files within one folder you choose in Jottacloud, including creating " +
      "new files there — never your whole Jottacloud account.",
};

export const SUPPORTED_RESOURCES: SupportedResource[] = [JOTTACLOUD_FILE_RESOURCE, JOTTACLOUD_FOLDER_RESOURCE];

/** Rejects an empty, ".", or ".." path segment — the traversal and root-escape defenses. */
function validateSegment(segment: string, whole: string): void {
  if (segment === "" || segment === "." || segment === "..") {
    throw new JottacloudError(
      "INVALID_RESOURCE",
      `Invalid Jottacloud path "${whole}": segments may not be empty, ".", or "..".`);
  }
}

/**
 * Normalizes and validates a human-entered device/mountpoint/path triple (from the resource
 * configurator form) into a {@link JottaFilePath}. Throws `INVALID_RESOURCE` on anything that could
 * escape the file it names: empty segments, ".", "..", or a leading/trailing slash.
 */
export function normalizeFilePath(device: string, mountpoint: string, path: string): JottaFilePath {
  const trimmedDevice = device.trim() || DEFAULT_DEVICE;
  const trimmedMountpoint = mountpoint.trim() || DEFAULT_MOUNTPOINT;
  const trimmedPath = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmedPath) {
    throw new JottacloudError("INVALID_RESOURCE", "A file path is required.");
  }
  const pathSegments = trimmedPath.split("/");
  for (const segment of [trimmedDevice, trimmedMountpoint, ...pathSegments]) {
    validateSegment(segment, trimmedPath);
  }
  return { device: trimmedDevice, mountpoint: trimmedMountpoint, path: pathSegments.join("/") };
}

/** Builds this binding's canonical resource URL from a validated {@link JottaFilePath}. */
export function toResourceUrl(file: JottaFilePath): string {
  const segments = ["jfs", file.device, file.mountpoint, ...file.path.split("/")];
  return `https://${RESOURCE_HOST}/${segments.map(encodeURIComponent).join("/")}`;
}

/**
 * Parses a bound resource URL back into a {@link JottaFilePath}.
 *
 * Throws `INVALID_RESOURCE` on any URL that is not a valid file resource URL with every segment
 * passing {@link validateSegment} — including a URL containing `..`, an empty segment, or naming a
 * different host.
 */
export function parseResourceUrl(url: string): JottaFilePath {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new JottacloudError("INVALID_RESOURCE", "Not a valid resource URL.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== RESOURCE_HOST) {
    throw new JottacloudError("INVALID_RESOURCE", `Unsupported Jottacloud resource URL: ${parsed.hostname}`);
  }
  const segments = parsed.pathname.split("/").filter(Boolean).map(segment => decodeURIComponent(segment));
  if (segments[0] !== "jfs" || segments.length < 4) {
    throw new JottacloudError(
      "INVALID_RESOURCE",
      `Jottacloud file URLs must be https://${RESOURCE_HOST}/jfs/<device>/<mountpoint>/<path>.`);
  }
  const [, device, mountpoint, ...pathSegments] = segments;
  const path = pathSegments.join("/");
  for (const segment of [device, mountpoint, ...pathSegments]) {
    validateSegment(segment, path);
  }
  return { device, mountpoint, path };
}

/**
 * Normalizes and validates a human-entered device/mountpoint/path triple into a folder binding
 * target. Unlike {@link normalizeFilePath}, an empty path is valid: it names the mountpoint's own
 * root as the bound folder, rather than being rejected as "no file chosen".
 */
export function normalizeFolderPath(device: string, mountpoint: string, path: string): JottaFilePath {
  const trimmedDevice = device.trim() || DEFAULT_DEVICE;
  const trimmedMountpoint = mountpoint.trim() || DEFAULT_MOUNTPOINT;
  const trimmedPath = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const pathSegments = trimmedPath ? trimmedPath.split("/") : [];
  for (const segment of [trimmedDevice, trimmedMountpoint, ...pathSegments]) {
    validateSegment(segment, trimmedPath);
  }
  return { device: trimmedDevice, mountpoint: trimmedMountpoint, path: pathSegments.join("/") };
}

/** Builds a folder binding's canonical resource URL from a validated {@link JottaFilePath}. */
export function toFolderResourceUrl(folder: JottaFilePath): string {
  const pathSegments = folder.path ? folder.path.split("/") : [];
  const segments = ["jfs-folder", folder.device, folder.mountpoint, ...pathSegments];
  return `https://${RESOURCE_HOST}/${segments.map(encodeURIComponent).join("/")}`;
}

/**
 * Parses a bound folder resource URL back into a {@link JottaFilePath}. Mirrors
 * {@link parseResourceUrl}, except the path may be empty (the mountpoint's own root) and the
 * required prefix is the synthetic `jfs-folder`, not the real `jfs`.
 */
export function parseFolderResourceUrl(url: string): JottaFilePath {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new JottacloudError("INVALID_RESOURCE", "Not a valid resource URL.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== RESOURCE_HOST) {
    throw new JottacloudError("INVALID_RESOURCE", `Unsupported Jottacloud resource URL: ${parsed.hostname}`);
  }
  const segments = parsed.pathname.split("/").filter(Boolean).map(segment => decodeURIComponent(segment));
  if (segments[0] !== "jfs-folder" || segments.length < 3) {
    throw new JottacloudError(
      "INVALID_RESOURCE",
      `Jottacloud folder URLs must be https://${RESOURCE_HOST}/jfs-folder/<device>/<mountpoint>` +
      `[/<path>].`);
  }
  const [, device, mountpoint, ...pathSegments] = segments;
  const path = pathSegments.join("/");
  for (const segment of [device, mountpoint, ...pathSegments]) {
    validateSegment(segment, path);
  }
  return { device, mountpoint, path };
}

/** Whether a resource URL names a folder binding rather than a file binding — cheap enough (no
 * parsing) to call before deciding which parser to actually run. */
export function isFolderResourceUrl(url: string): boolean {
  try {
    return new URL(url).pathname.split("/").filter(Boolean)[0] === "jfs-folder";
  } catch {
    return false;
  }
}

/**
 * Resolves a relative path an agent supplies — for `list()`, `getMetadata()`, `read()`, or
 * `write()` on a folder session — against the bound folder, throwing `INVALID_RESOURCE` if it could
 * ever address anything outside that folder. An empty (or all-slashes) relative path addresses the
 * folder's own root and resolves to `folder` unchanged.
 *
 * JFS path containment is syntactic: the same segment validation used for a human-entered folder
 * path is applied to every caller-supplied relative path.
 */
export function resolveWithinFolder(folder: JottaFilePath, relativePath: string): JottaFilePath {
  const trimmed = (relativePath ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return folder;
  const segments = trimmed.split("/");
  for (const segment of segments) validateSegment(segment, trimmed);
  const combinedPath = folder.path ? `${folder.path}/${trimmed}` : trimmed;
  return { device: folder.device, mountpoint: folder.mountpoint, path: combinedPath };
}
