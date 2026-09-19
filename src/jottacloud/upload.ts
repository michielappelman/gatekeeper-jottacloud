/**
 * Upload allocation and content transfer using Jottacloud's `files/v1/allocate` + upload-URL flow.
 * A write is always an upload of a new revision to the existing path, never a delete-and-recreate.
 */

import { errorForStatus, JottacloudError } from "./errors";
import { fetchWithRetry } from "./retry";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import type { AccessTokenSource } from "./jfs";
import type { JottaFilePath, UploadMetadata, UploadSession } from "./types";

export const API_BASE_URL = "https://api.jottacloud.com/";
const ALLOCATE_PATH = "files/v1/allocate";

function isoDate(date: Date | undefined): string | undefined {
  return date ? date.toISOString() : undefined;
}

/** rclone's `allocatePathRaw`: `/jfs/<device>/<mountpoint>/<path>` — no username, unlike the JFS URL. */
function allocatePath(file: JottaFilePath): string {
  return `/jfs/${file.device}/${file.mountpoint}/${file.path}`;
}

export async function allocateUpload(
  file: JottaFilePath, metadata: UploadMetadata, getAccessToken: AccessTokenSource,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadSession> {
  const token = await getAccessToken();
  const body = {
    path: allocatePath(file),
    bytes: metadata.size,
    md5: metadata.md5,
    created: isoDate(metadata.created),
    modified: isoDate(metadata.modified),
  };
  const response = await fetchWithRetry(() => fetchImpl(API_BASE_URL + ALLOCATE_PATH, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  if (!response.ok) throw errorForStatus(response.status, "allocate");

  let parsed: { state?: unknown; resume_pos?: unknown; upload_url?: unknown };
  try {
    parsed = JSON.parse(await readTextCapped(response)) as typeof parsed;
  } catch (error) {
    throw new JottacloudError("UPLOAD_FAILED", "Jottacloud's allocation response could not be parsed.", { cause: error });
  }
  const state = typeof parsed.state === "string" ? parsed.state : "";
  const completed = state === "COMPLETED";
  if (!completed && typeof parsed.upload_url !== "string") {
    throw new JottacloudError("UPLOAD_FAILED", "Jottacloud did not return an upload URL.");
  }
  return {
    uploadUrl: typeof parsed.upload_url === "string" ? parsed.upload_url : "",
    resumePos: typeof parsed.resume_pos === "number" ? parsed.resume_pos : 0,
    completed,
  };
}

export async function uploadContent(
  session: UploadSession, content: ArrayBuffer, getAccessToken: AccessTokenSource,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (session.completed) return;
  const token = await getAccessToken();
  const remaining = content.slice(session.resumePos);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/octet-stream",
  };
  if (session.resumePos > 0) {
    headers["Content-Range"] = `bytes ${session.resumePos}-${content.byteLength - 1}/${content.byteLength}`;
  }
  const response = await fetchWithRetry(() => fetchImpl(session.uploadUrl, {
    method: "POST",
    headers,
    body: remaining,
  }));
  if (!response.ok) throw errorForStatus(response.status, "upload");
}
