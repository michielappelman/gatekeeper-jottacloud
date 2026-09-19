export type JottacloudFileConfiguratorValues = {
  device?: string | null;
  mountpoint?: string | null;
  path?: string | null;
  /** UI-only: whether the (rarely needed) Device field is expanded. Not part of the resource. */
  advancedOpen?: string | null;
};

/** Option shown by the sandboxed iframe's Autocomplete control. Mirrors `@gadgets/configurator-ui`'s
 * `ConfiguratorUIOption` — duplicated rather than imported, since that package's JSX globals should
 * not leak into non-sandboxed Worker code (see `github-configurators.ts` for the same pattern). */
export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

/**
 * Live JFS lookups for the resource configurator, backed directly by the connected account's
 * device/mountpoint/folder listing.
 */
export interface JottacloudFileConfiguratorRpc {
  listDevices(query: string): Promise<ConfiguratorOption[]>;
  listMountpoints(device: string | null | undefined, query: string): Promise<ConfiguratorOption[]>;
  browse(
    device: string | null | undefined, mountpoint: string | null | undefined, query: string,
  ): Promise<ConfiguratorOption[]>;
}
