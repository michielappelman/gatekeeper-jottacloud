/** Metadata for a Jottacloud file, without downloading its content. */
export type JottacloudFileMetadata = {
  /** Current file name (the last path segment). */
  name: string;
  /** Size in bytes. */
  size: number;
  /** MD5 checksum of the current content. Pass this to `write()` to detect concurrent changes. */
  md5: string;
  /** MIME type Jottacloud has recorded for the file. */
  mimeType: string;
  /** When this revision was created in Jottacloud. */
  createdAt: Date;
  /** When the file's content was last modified. */
  modifiedAt: Date;
};

/** Result of converting a file's content to Markdown. */
export type JottacloudMarkdownContent = {
  /** The converted content. */
  markdown: string;
  /** The MIME type the original content was converted from. */
  sourceMimeType: string;
};

/**
 * Read-write access to one Jottacloud file. The file was chosen when this connection was created
 * and cannot be changed from here — there is no method that takes a different path or file ID.
 */
export interface JottacloudFileSession {
  /** Returns metadata for the bound file without downloading its content. */
  getMetadata(): Promise<JottacloudFileMetadata>;

  /** Downloads the file's current content. */
  read(): Promise<ArrayBuffer>;

  /**
   * Downloads the file's current content and converts it to Markdown — HTML, PDF, and common
   * office/document formats (Word, Excel, OpenDocument, Apple Numbers) become readable text.
   * Throws with code `UNSUPPORTED_FOR_MARKDOWN` if the file's recorded MIME type cannot be
   * converted, or `TOO_LARGE_FOR_MARKDOWN` if it is too large — check `getMetadata()` first, or
   * call `read()` instead, if either is a possibility.
   */
  readAsMarkdown(): Promise<JottacloudMarkdownContent>;

  /**
   * Replaces the file's content by uploading a new revision, preserving Jottacloud's version
   * history (the previous content remains recoverable there).
   *
   * Pass `ifMatchMd5` (the `md5` from an earlier `getMetadata()` or `read()` in this session) to
   * detect a conflicting change: if the file's current content no longer matches, the write is
   * rejected with an error instead of overwriting it — call `getMetadata()` again, reconcile, and
   * retry. Omit it to write unconditionally.
   *
   * The write may be held for approval before it actually reaches Jottacloud. Until it is applied,
   * `read()` and `getMetadata()` continue to reflect the file's previous content, not this pending
   * write.
   */
  write(content: ArrayBuffer, ifMatchMd5?: string): Promise<void>;
}

/** One immediate child of a listed folder — either a file or a subfolder. */
export type JottacloudFolderEntry = {
  /**
   * Path relative to the bound folder's root — pass this to `getMetadata()`, `read()`, or
   * `write()` on a file entry, or back into `list()` to descend into a folder entry.
   */
  path: string;
  /** Current name (the last path segment). */
  name: string;
  /** True for a subfolder; `list()` never descends into one on its own — pass its `path` back in. */
  isFolder: boolean;
  /** Size in bytes. Absent for a folder entry. */
  size?: number;
  /** MIME type Jottacloud has recorded. Absent for a folder entry. */
  mimeType?: string;
  /** MD5 checksum of the current content. Absent for a folder entry. */
  md5?: string;
  /** When last modified. Absent for a folder entry. */
  modifiedAt?: Date;
};

/** The immutable identity of a folder binding. */
export type JottacloudFolderScope = {
  /** The Jottacloud device the bound folder lives on. */
  device: string;
  /** The mountpoint within that device. */
  mountpoint: string;
  /** Path within the mountpoint. Empty string means the mountpoint's own root. */
  path: string;
};

/**
 * Read-write access to files within one Jottacloud folder. The folder was chosen when this
 * connection was created and cannot be changed from here. Every method's path argument is relative
 * to that folder and is validated so it can never address anything outside it — there is no way to
 * retarget this binding at a different folder or escape it with `..`.
 */
export interface JottacloudFolderSession {
  /** Returns the bound folder's identity. */
  getScope(): Promise<JottacloudFolderScope>;

  /**
   * Lists the immediate children of `path` (relative to the bound folder; omit, or pass `""`, for
   * the bound folder's own root). Never recursive — descend into a subfolder by calling this again
   * with that entry's `path`. Throws if `path` names a file, or a folder outside this binding.
   */
  list(path?: string): Promise<JottacloudFolderEntry[]>;

  /** Returns metadata for one file within the bound folder, without downloading its content. */
  getMetadata(path: string): Promise<JottacloudFileMetadata>;

  /** Downloads one file's current content. */
  read(path: string): Promise<ArrayBuffer>;

  /** Downloads one file's current content and converts it to Markdown, the same as
   * `JottacloudFileSession.readAsMarkdown()` does for a bound single file. */
  readAsMarkdown(path: string): Promise<JottacloudMarkdownContent>;

  /**
   * Writes `path`'s content, creating it (and preserving history for updates the same way
   * `JottacloudFileSession.write()` does) if it doesn't already exist. `ifMatchMd5` behaves the
   * same as on `JottacloudFileSession.write()`, and is only meaningful when the file already exists.
   */
  write(path: string, content: ArrayBuffer, ifMatchMd5?: string): Promise<void>;
}
