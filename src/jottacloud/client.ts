/**
 * The abstraction the Gatekeeper session code depends on, so the undocumented direct-to-Jottacloud
 * protocol stays swappable (README.md §"Assumptions" — Jottacloud could stop tolerating third-party
 * clients, or a local-sync-folder fallback could replace this backend without touching the
 * Gatekeeper's resource/permission model).
 */

import { errorForStatus, JottacloudError } from "./errors";
import { downloadFile, getMetadata, listFolder, type AccessTokenSource, type FolderListEntry } from "./jfs";
import { md5Hex } from "./md5";
import { allocateUpload, uploadContent } from "./upload";
import type { FileMetadata, JottaFilePath, UploadMetadata } from "./types";

export interface JottacloudBackend {
  getMetadata(username: string, file: JottaFilePath): Promise<FileMetadata>;
  read(username: string, file: JottaFilePath): Promise<ArrayBuffer>;
  /** Uploads `content` as a new revision of `file` (or creates it, if `file` doesn't exist yet),
   * preserving Jottacloud's version history. */
  write(username: string, file: JottaFilePath, content: ArrayBuffer): Promise<FileMetadata>;
  /** Lists the immediate contents of a folder (`file.path === ""` lists the mountpoint's own root). */
  list(username: string, folder: JottaFilePath): Promise<FolderListEntry[]>;
}

/** Talks to Jottacloud's real JFS/API endpoints (README.md §"Evidence"). */
export class DirectJottacloudBackend implements JottacloudBackend {
  #getAccessToken: AccessTokenSource;
  #fetchImpl: typeof fetch;

  constructor(getAccessToken: AccessTokenSource, fetchImpl: typeof fetch = fetch) {
    this.#getAccessToken = getAccessToken;
    this.#fetchImpl = fetchImpl;
  }

  async getMetadata(username: string, file: JottaFilePath): Promise<FileMetadata> {
    const metadata = await getMetadata(file, username, this.#getAccessToken, this.#fetchImpl);
    if (metadata.deleted) {
      throw new JottacloudError("RESOURCE_NOT_FOUND", "The bound Jottacloud file has been deleted.");
    }
    return metadata;
  }

  async read(username: string, file: JottaFilePath): Promise<ArrayBuffer> {
    const response = await downloadFile(file, username, this.#getAccessToken, undefined, this.#fetchImpl);
    return response.arrayBuffer();
  }

  async write(username: string, file: JottaFilePath, content: ArrayBuffer): Promise<FileMetadata> {
    const metadata: UploadMetadata = {
      size: content.byteLength,
      md5: md5Hex(content),
      modified: new Date(),
    };
    const session = await allocateUpload(file, metadata, this.#getAccessToken, this.#fetchImpl);
    await uploadContent(session, content, this.#getAccessToken, this.#fetchImpl);
    return this.getMetadata(username, file);
  }

  async list(username: string, folder: JottaFilePath): Promise<FolderListEntry[]> {
    return listFolder(folder, username, this.#getAccessToken, this.#fetchImpl);
  }
}

export { errorForStatus, JottacloudError } from "./errors";
export type { JottacloudErrorCode } from "./errors";
