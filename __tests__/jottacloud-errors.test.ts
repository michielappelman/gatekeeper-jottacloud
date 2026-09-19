import { describe, expect, it } from "vitest";
import { errorForStatus, JottacloudError } from "../src/jottacloud/errors";

describe("errorForStatus", () => {
  it("maps 401 to AUTH_EXPIRED regardless of operation", () => {
    expect(errorForStatus(401, "metadata").code).toBe("AUTH_EXPIRED");
    expect(errorForStatus(401, "upload").code).toBe("AUTH_EXPIRED");
  });

  it("maps 403 to PERMISSION_DENIED", () => {
    expect(errorForStatus(403, "download").code).toBe("PERMISSION_DENIED");
  });

  it("maps 404 to RESOURCE_NOT_FOUND", () => {
    expect(errorForStatus(404, "metadata").code).toBe("RESOURCE_NOT_FOUND");
  });

  it("maps 429 to RATE_LIMITED", () => {
    expect(errorForStatus(429, "metadata").code).toBe("RATE_LIMITED");
  });

  it("maps every 5xx to UPSTREAM_UNAVAILABLE", () => {
    for (const status of [500, 502, 503, 504, 509, 599]) {
      expect(errorForStatus(status, "metadata").code).toBe("UPSTREAM_UNAVAILABLE");
    }
  });

  it("maps an otherwise-unclassified download failure to DOWNLOAD_FAILED", () => {
    expect(errorForStatus(418, "download").code).toBe("DOWNLOAD_FAILED");
  });

  it("maps an otherwise-unclassified allocate/upload failure to UPLOAD_FAILED", () => {
    expect(errorForStatus(418, "allocate").code).toBe("UPLOAD_FAILED");
    expect(errorForStatus(418, "upload").code).toBe("UPLOAD_FAILED");
  });

  it("maps an otherwise-unclassified auth failure to AUTH_REQUIRED", () => {
    expect(errorForStatus(418, "auth").code).toBe("AUTH_REQUIRED");
  });

  it("produces a JottacloudError instance carrying the status in its message", () => {
    const error = errorForStatus(503, "metadata");
    expect(error).toBeInstanceOf(JottacloudError);
    expect(error.message).toContain("503");
  });
});
