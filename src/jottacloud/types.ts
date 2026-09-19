/**
 * Internal Jottacloud protocol types. Nothing here is exposed to agents — see `../types.d.ts` for
 * the agent-facing API.
 */

/** A single JFS file, identified the way Jottacloud's JFS API addresses it. */
export type JottaFilePath = {
  /** Jottacloud "device" name, e.g. "Jotta" (the default used by Jottacloud's own clients). */
  device: string;
  /** Mountpoint within the device, e.g. "Sync" (this deployment's default — see jfs.ts). */
  mountpoint: string;
  /** Slash-separated path within the mountpoint. Never starts with "/" and never contains "..". */
  path: string;
};

/** Metadata for one file's current revision, parsed from JFS's XML response. */
export type FileMetadata = {
  name: string;
  size: number;
  md5: string;
  mimeType: string;
  createdAt: Date;
  modifiedAt: Date;
  /** True if JFS reports this file (or its containing folder) as deleted/trashed. */
  deleted: boolean;
};

/** The bearer credential used for every JFS/API call, plus what's needed to refresh it. */
export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  /** Unix ms timestamp; treat the access token as stale a little before this to avoid races. */
  expiresAt: number;
  /** The OIDC token endpoint discovered from the login token's well-known link. Needed to refresh. */
  tokenEndpoint: string;
  /** The Jottacloud username this session authenticates as. */
  username: string;
};

/** Non-secret fields of {@link AuthSession} worth showing to a human, for the connected-account UI. */
export type AuthIdentity = {
  username: string;
};

/** Metadata sent to Jottacloud's allocate endpoint ahead of an upload. */
export type UploadMetadata = {
  size: number;
  md5: string;
  created?: Date;
  modified?: Date;
};

/** The allocate endpoint's response: where (and how much) to upload. */
export type UploadSession = {
  uploadUrl: string;
  /** Bytes already present server-side (nonzero on a resumed upload); 0 for a fresh upload. */
  resumePos: number;
  /** True when the allocate call alone completed the upload (e.g. content already matches by MD5). */
  completed: boolean;
};
