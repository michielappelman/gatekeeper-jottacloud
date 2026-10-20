/** The chosen node, by its {@link JottacloudNode.id}, or null when nothing is chosen. */
export type JottacloudConfiguratorValues = { target?: string | null };

/** An ancestor of a {@link JottacloudNode}, outermost first below the account. */
export type JottacloudNodeAncestor = Pick<JottacloudNode, "id" | "title" | "kind">;

/** A grouping, device, mountpoint, folder or file the Jottacloud picker shows. */
export type JottacloudNode = {
  /**
   * For a mountpoint or folder, the folder resource URL that binds it; for a file, the file resource
   * URL. `devices` (other devices than the default one) and `device:<name>` are groupings, which are
   * not resources.
   */
  id: string;
  title: string;
  kind: "group" | "device" | "mountpoint" | "folder" | "file";
  /** For a mountpoint or file, in bytes. */
  size?: number;
  /** For a file. */
  mimeType?: string;
  /** For a file, as an ISO timestamp. */
  modifiedTime?: string;
  /** Every ancestor below the account, so search results and pre-filled nodes show where they live. */
  path: JottacloudNodeAncestor[];
};

export type JottacloudNodePage = {
  nodes: JottacloudNode[];
  nextCursor?: string;
};

export interface JottacloudConfiguratorRpc {
  /**
   * One page of a location's nodes: the account's (`jottacloud`) mountpoints and other devices, a
   * device's mountpoints, or a mountpoint's or folder's subfolders and files. A `query` narrows that
   * listing by name, unless it is a path (`<mountpoint>/<path>`) or a resource URL, which is looked
   * up as {@link getNode} would.
   */
  listNodes(parentId: string, query: string, cursor: string | null): Promise<JottacloudNodePage>;
  /** The mountpoint, folder or file a resource URL names, or null if it does not exist. */
  getNode(id: string): Promise<JottacloudNode | null>;
}
