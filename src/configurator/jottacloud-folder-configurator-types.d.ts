import type { ConfiguratorOption } from "./jottacloud-file-configurator-types";

export type JottacloudFolderConfiguratorValues = {
  device?: string | null;
  mountpoint?: string | null;
  /**
   * Path within the mountpoint. Distinguishing an explicit `""` (the mountpoint's own root was
   * chosen) from `undefined`/`null` (nothing chosen yet) is what lets `isReady` require a real
   * selection even though an empty path is itself a valid one.
   */
  path?: string | null;
  /** UI-only: whether the (rarely needed) Device field is expanded. Not part of the resource. */
  advancedOpen?: string | null;
};

/**
 * Live JFS lookups for the folder resource configurator. Shares `listDevices`/`listMountpoints`
 * with the file configurator's RPC (see `JottacloudFolderConfiguratorUI extends
 * JottacloudFileConfiguratorUI` in jottacloud.ts); `browseFolders` is the one addition, since
 * picking a folder to bind is a different browsing shape than picking a file (every listed entry
 * is directly selectable — there is no "keep browsing vs. pick this one" distinction files need).
 */
export interface JottacloudFolderConfiguratorRpc {
  listDevices(query: string): Promise<ConfiguratorOption[]>;
  listMountpoints(device: string | null | undefined, query: string): Promise<ConfiguratorOption[]>;
  browseFolders(
    device: string | null | undefined, mountpoint: string | null | undefined, query: string,
  ): Promise<ConfiguratorOption[]>;
}
