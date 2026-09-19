/**
 * Stable error codes the rest of the gatekeeper can branch on, independent of Jottacloud's own HTTP
 * statuses or response bodies (which are undocumented and not a contract we can rely on — see
 * README.md). Every call into `./client.ts` throws a `JottacloudError`, never a raw `Response` or
 * fetch failure.
 */
export type JottacloudErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "PERMISSION_DENIED"
  | "RESOURCE_NOT_FOUND"
  | "FILE_CHANGED"
  | "UPLOAD_FAILED"
  | "DOWNLOAD_FAILED"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "INVALID_RESOURCE";

export class JottacloudError extends Error {
  constructor(readonly code: JottacloudErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JottacloudError";
  }
}

/**
 * Classifies a Jottacloud HTTP response status into a stable error code for the given operation.
 * `retryExhausted` distinguishes "still 429/5xx after retries" (RATE_LIMITED / UPSTREAM_UNAVAILABLE)
 * from a status seen on the first attempt of a non-retried call site.
 */
export function errorForStatus(
  status: number,
  operation: "metadata" | "download" | "allocate" | "upload" | "auth",
): JottacloudError {
  if (status === 401) {
    return new JottacloudError("AUTH_EXPIRED", "Jottacloud rejected the current access token.");
  }
  if (status === 403) {
    return new JottacloudError("PERMISSION_DENIED", "Jottacloud denied access to this resource.");
  }
  if (status === 404) {
    return new JottacloudError("RESOURCE_NOT_FOUND", "The bound Jottacloud file was not found.");
  }
  if (status === 429) {
    return new JottacloudError("RATE_LIMITED", "Jottacloud is rate-limiting this account.");
  }
  if (status >= 500) {
    return new JottacloudError(
      "UPSTREAM_UNAVAILABLE", `Jottacloud returned a server error (${status}).`);
  }
  switch (operation) {
    case "download":
      return new JottacloudError("DOWNLOAD_FAILED", `Jottacloud download failed with status ${status}.`);
    case "allocate":
    case "upload":
      return new JottacloudError("UPLOAD_FAILED", `Jottacloud upload failed with status ${status}.`);
    case "auth":
      return new JottacloudError("AUTH_REQUIRED", `Jottacloud authentication failed with status ${status}.`);
    default:
      return new JottacloudError(
        "UPSTREAM_UNAVAILABLE", `Jottacloud request failed with unexpected status ${status}.`);
  }
}
