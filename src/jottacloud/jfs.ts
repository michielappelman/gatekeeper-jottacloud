/**
 * JFS (Jotta File System) HTTP access: metadata and binary content for one file, plus directory/
 * device/mountpoint listing for the resource configurator's live browser. Endpoint shapes and
 * parameters are cross-checked against rclone's current Jottacloud backend (README.md
 * §"Evidence") — Jottacloud publishes no API docs, so this is undocumented-but-verified, not a
 * guaranteed contract (README.md §"Assumptions we do not treat as facts").
 */

import { errorForStatus, JottacloudError } from "./errors";
import { fetchWithRetry } from "./retry";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import type { FileMetadata, JottaFilePath } from "./types";

export const JFS_BASE_URL = "https://jfs.jottacloud.com/jfs/";
export const DEFAULT_DEVICE = "Jotta";
/**
 * "Archive" is rclone's own hardcoded config-wizard default (the manual-upload mountpoint), but
 * this deployment's account keeps its real files under "Sync" (the desktop-client sync target) —
 * confirmed against the live account, not assumed. Falling back to the wrong one here would only
 * matter if some caller ever supplies an empty mountpoint outside the resource configurator (which
 * always supplies a concrete value), but the configurator's own default (README.md's configurator
 * module) must agree with this one or clearing the field mid-browse would silently point at the
 * other mountpoint's contents.
 */
export const DEFAULT_MOUNTPOINT = "Sync";

/** rclone's `urlPathEscape`: percent-encode a path segment, then escape `+` (which `encodeURIComponent`
 * leaves alone but a JFS query-string neighbor could otherwise misread as a space). */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/\+/g, "%2B");
}

/**
 * Builds the `<username>/<device>/<mountpoint>/<path>` JFS URL path, each segment encoded on its
 * own. `file.path` may be empty (the browser lists a mountpoint's own root this way); every other
 * caller has already validated a non-empty path (see `resource.ts`'s `normalizeFilePath`).
 */
export function jfsUrlPath(username: string, file: JottaFilePath): string {
  const pathSegments = file.path ? file.path.split("/") : [];
  const segments = [username, file.device, file.mountpoint, ...pathSegments];
  return segments.map(encodeSegment).join("/");
}

// Jottacloud's XML timestamp format, e.g. "2026-09-18-T12:34:56+0200" (rclone's `jottaTimeFormat`:
// "2006-01-02-T15:04:05Z0700" — RFC3339 with an extra hyphen before "T" and no colon in the offset).
const JOTTA_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})-T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{4})$/;

function parseJottaTime(value: string): Date {
  const match = JOTTA_TIME_RE.exec(value.trim());
  if (!match) return new Date(NaN);
  const [, year, month, day, hour, minute, second, zone] = match;
  const offset = zone === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
}

function xmlAttr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return match ? decodeXmlEntities(match[1]) : undefined;
}

/**
 * Extracts a tag's text content. Tolerates attributes on the opening tag (verified against
 * rclone's real recorded example responses: device/mountpoint `<name>`/`<display_name>` come back
 * as `<name xml:space="preserve">Jotta</name>`, not bare `<name>Jotta</name>`).
 */
function xmlTagText(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`).exec(xml);
  return match ? decodeXmlEntities(match[1]) : undefined;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/**
 * Parses a JFS `<file>` metadata document. Deliberately narrow: it reads only the handful of
 * `currentRevision` fields this gatekeeper exposes (name, deleted, state, created, modified, size,
 * mime, md5), via targeted regexes rather than a general XML parser — the Workers runtime has none
 * built in, and JFS's shape here is small, fixed, and does not nest same-named tags.
 */
export function parseJottaFileXml(xml: string): FileMetadata {
  const rootMatch = /<file\b([^>]*)>/i.exec(xml);
  if (!rootMatch) {
    throw new JottacloudError("DOWNLOAD_FAILED", "Jottacloud's file metadata response was not understood.");
  }
  const rootTag = rootMatch[1];
  const name = xmlAttr(rootTag, "name") ?? "";
  const deleted = /\bdeleted\s*=/.test(rootTag);

  const revisionMatch = /<currentRevision>([\s\S]*?)<\/currentRevision>/.exec(xml);
  const revision = revisionMatch?.[1] ?? "";
  const size = Number(xmlTagText(revision, "size") ?? "0");
  const md5 = xmlTagText(revision, "md5") ?? "";
  const mimeType = xmlTagText(revision, "mime") ?? "application/octet-stream";
  const createdAt = parseJottaTime(xmlTagText(revision, "created") ?? "");
  const modifiedAt = parseJottaTime(xmlTagText(revision, "modified") ?? "");

  return { name, size, md5, mimeType, createdAt, modifiedAt, deleted };
}

export type AccessTokenSource = () => Promise<string>;

async function authorizedFetch(
  url: string, getAccessToken: AccessTokenSource, init: RequestInit, fetchImpl: typeof fetch,
): Promise<Response> {
  const token = await getAccessToken();
  return fetchWithRetry(() => fetchImpl(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  }));
}

export async function getMetadata(
  file: JottaFilePath, username: string, getAccessToken: AccessTokenSource,
  fetchImpl: typeof fetch = fetch,
): Promise<FileMetadata> {
  const url = JFS_BASE_URL + jfsUrlPath(username, file);
  const response = await authorizedFetch(url, getAccessToken, { method: "GET" }, fetchImpl);
  if (!response.ok) throw errorForStatus(response.status, "metadata");
  return parseJottaFileXml(await readTextCapped(response));
}

/** One entry in a directory listing: either an immediate subfolder or an immediate file. */
export type FolderListEntry =
  | { kind: "folder"; name: string; deleted: boolean }
  | ({ kind: "file" } & FileMetadata);

/**
 * Parses a JFS folder/mountpoint listing response — the same `GET` used for file metadata, but
 * pointed at a directory instead of a file, so it returns a `<folder>`/`<mountPoint>` root with
 * `<folders>`/`<files>` children instead of a `<file>` root. Non-recursive: only the immediate
 * children rclone's own `List()` reads (`JottaFolder.Folders`/`.Files`), one level deep. A path
 * that names a file rather than a directory has neither block and yields no entries — callers
 * that need to tell "empty folder" from "not a folder" already have `getMetadata` for that.
 */
export function parseJottaFolderXml(xml: string): FolderListEntry[] {
  const entries: FolderListEntry[] = [];

  const foldersBlock = /<folders>([\s\S]*?)<\/folders>/.exec(xml)?.[1];
  for (const match of foldersBlock?.matchAll(/<folder\b([^>]*?)\/?>/g) ?? []) {
    const name = xmlAttr(match[1], "name");
    if (name) entries.push({ kind: "folder", name, deleted: /\bdeleted\s*=/.test(match[1]) });
  }

  const filesBlock = /<files>([\s\S]*?)<\/files>/.exec(xml)?.[1];
  for (const fragment of filesBlock?.match(/<file\b[^>]*>[\s\S]*?<\/file>/g) ?? []) {
    entries.push({ kind: "file", ...parseJottaFileXml(fragment) });
  }

  return entries;
}

/** One device registered on the account (e.g. the built-in "Jotta", or a synced desktop/backup client). */
export type JottaDeviceEntry = { name: string; displayName: string; type: string; sizeBytes: number };

/** One mountpoint within a device (e.g. "Archive", or "Sync" for a desktop-synced folder). */
export type JottaMountpointEntry = { name: string; sizeBytes: number };

/**
 * Parses the account root's `<devices>` listing (`api.DriveInfo`). Unlike folder/file entries,
 * `JottaDevice`'s fields are plain child elements, not attributes (`<name>Jotta</name>`, not
 * `name="Jotta"`) — verified against `api.JottaDevice`'s XML tags.
 */
function parseJottaDevicesXml(xml: string): JottaDeviceEntry[] {
  const devicesBlock = /<devices>([\s\S]*?)<\/devices>/.exec(xml)?.[1];
  const entries: JottaDeviceEntry[] = [];
  for (const fragment of devicesBlock?.match(/<device\b[^>]*>[\s\S]*?<\/device>/g) ?? []) {
    const name = xmlTagText(fragment, "name");
    if (!name) continue;
    entries.push({
      name,
      displayName: xmlTagText(fragment, "display_name") || name,
      type: xmlTagText(fragment, "type") ?? "",
      sizeBytes: Number(xmlTagText(fragment, "size") ?? "0"),
    });
  }
  return entries;
}

/** Parses one device's `<mountPoints>` listing (`api.JottaDevice`), same element-not-attribute shape. */
function parseJottaMountpointsXml(xml: string): JottaMountpointEntry[] {
  const mountPointsBlock = /<mountPoints>([\s\S]*?)<\/mountPoints>/.exec(xml)?.[1];
  const entries: JottaMountpointEntry[] = [];
  for (const fragment of mountPointsBlock?.match(/<mountPoint\b[^>]*>[\s\S]*?<\/mountPoint>/g) ?? []) {
    const name = xmlTagText(fragment, "name");
    if (!name) continue;
    entries.push({ name, sizeBytes: Number(xmlTagText(fragment, "size") ?? "0") });
  }
  return entries;
}

/** Lists the immediate contents of a folder (or a mountpoint's root, with `file.path === ""`). */
export async function listFolder(
  file: JottaFilePath, username: string, getAccessToken: AccessTokenSource,
  fetchImpl: typeof fetch = fetch,
): Promise<FolderListEntry[]> {
  const url = JFS_BASE_URL + jfsUrlPath(username, file);
  const response = await authorizedFetch(url, getAccessToken, { method: "GET" }, fetchImpl);
  if (!response.ok) throw errorForStatus(response.status, "metadata");
  return parseJottaFolderXml(await readTextCapped(response));
}

/** Lists the devices registered on the account (`GET` on the account's own JFS root). */
export async function listDevices(
  username: string, getAccessToken: AccessTokenSource, fetchImpl: typeof fetch = fetch,
): Promise<JottaDeviceEntry[]> {
  const url = JFS_BASE_URL + encodeSegment(username);
  const response = await authorizedFetch(url, getAccessToken, { method: "GET" }, fetchImpl);
  if (!response.ok) throw errorForStatus(response.status, "metadata");
  return parseJottaDevicesXml(await readTextCapped(response));
}

/** Lists a device's mountpoints (`GET` on the device's own JFS root). */
export async function listMountpoints(
  username: string, device: string, getAccessToken: AccessTokenSource, fetchImpl: typeof fetch = fetch,
): Promise<JottaMountpointEntry[]> {
  const url = JFS_BASE_URL + [username, device].map(encodeSegment).join("/");
  const response = await authorizedFetch(url, getAccessToken, { method: "GET" }, fetchImpl);
  if (!response.ok) throw errorForStatus(response.status, "metadata");
  return parseJottaMountpointsXml(await readTextCapped(response));
}

export type ByteRange = { start: number; end?: number };

/** Downloads file content (`mode=bin`), optionally as a byte range. Caller reads the body. */
export async function downloadFile(
  file: JottaFilePath, username: string, getAccessToken: AccessTokenSource,
  range?: ByteRange, fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(JFS_BASE_URL + jfsUrlPath(username, file));
  url.searchParams.set("mode", "bin");
  const headers: Record<string, string> = {};
  if (range) headers.Range = `bytes=${range.start}-${range.end ?? ""}`;
  const response = await authorizedFetch(url.toString(), getAccessToken, { method: "GET", headers }, fetchImpl);
  if (!response.ok) throw errorForStatus(response.status, "download");
  return response;
}
