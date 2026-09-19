import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { JottacloudFolderConfiguratorRpc, JottacloudFolderConfiguratorValues } from "./jottacloud-folder-configurator-types";

// See jottacloud-file-configurator-ui.tsx for why these defaults are what they are and why Device
// is tucked behind Advanced -- identical reasoning, just binding a folder instead of a file here.
const DEFAULT_DEVICE = "Jotta";
const DEFAULT_MOUNTPOINT = "Sync";

// Must mirror `normalizeFolderPath` + `toFolderResourceUrl` in ../resource.ts, which is what
// actually mints the capability. This module is transpiled on its own and cannot import that
// parser, so `__tests__/configurator-url.test.ts` is what keeps the copies honest.
function buildResourceUrl(values: JottacloudFolderConfiguratorValues): string {
  const device = (values.device ?? "").trim() || DEFAULT_DEVICE;
  const mountpoint = (values.mountpoint ?? "").trim() || DEFAULT_MOUNTPOINT;
  const path = (values.path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = ["jfs-folder", device, mountpoint, ...(path ? path.split("/") : [])];
  return `https://jfs.jottacloud.com/${segments.map(encodeURIComponent).join("/")}`;
}

export default {
  initial: { device: DEFAULT_DEVICE, mountpoint: DEFAULT_MOUNTPOINT },
  isReady: ({ values }) => {
    // Unlike the file configurator, an empty path is a legitimate choice (the mountpoint's own
    // root as the bound folder) -- so readiness hinges on whether a selection was ever made
    // (values.path is a string at all), not on whether that selection happens to be non-empty.
    if (typeof values.path !== "string") return false;
    const path = values.path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    const segments = path === "" ? [] : path.split("/");
    return !segments.some(segment => segment === "" || segment === "." || segment === "..");
  },
  resourceUrl: ({ values }) => buildResourceUrl(values),
  render({ values, setValues, clearFields, ui }) {
    const advancedOpen = Boolean(values.advancedOpen);
    return <Section title="Jottacloud folder">
      <Field
        label="Mountpoint"
        description="A subdivision within the account's storage -- Jottacloud's own web UI shows these as top-level folders (e.g. 'Archive' for manual uploads, 'Sync' for a desktop-synced folder)."
      >
        <Autocomplete
          name="mountpoint"
          value={values.mountpoint}
          placeholder={DEFAULT_MOUNTPOINT}
          optional
          loadOptions={query => ui.listMountpoints(values.device, query)}
          onChange={mountpoint => { setValues({ mountpoint: mountpoint ?? undefined, path: undefined }); clearFields("path"); }}
          onClear={() => { setValues({ mountpoint: undefined, path: undefined }); clearFields("path"); }}
        />
      </Field>
      <Field
        label="Folder"
        description="Search or browse to the folder to grant access to. Click a folder to select it, or to look inside it and pick one of its subfolders instead."
      >
        <Autocomplete
          name="path"
          value={values.path}
          placeholder="Search or browse folders..."
          loadOptions={query => ui.browseFolders(values.device, values.mountpoint, query)}
          // "." is a sentinel for the mountpoint root's own path (""), which the runtime's option
          // sanitizer would otherwise drop as falsy -- see jottacloud.ts's browseFolders().
          onChange={path => setValues({ path: path === "." ? "" : (path ?? undefined) })}
        />
      </Field>
      <button
        type="button"
        className="checkbox-action"
        onclick={() => setValues({ advancedOpen: advancedOpen ? undefined : "1" })}
      >
        {advancedOpen ? "Hide advanced" : "Advanced: use a different device"}
      </button>
      {advancedOpen && <Field
        label="Device"
        description="Which registered client owns the storage -- almost always 'Jotta', the built-in device Jottacloud's own web and mobile apps use. It's not shown anywhere in Jottacloud's own apps; pick a different one only if you know you have a separately registered desktop or backup client."
      >
        <Autocomplete
          name="device"
          value={values.device}
          placeholder={DEFAULT_DEVICE}
          optional
          loadOptions={query => ui.listDevices(query)}
          onChange={device => { setValues({ device: device ?? undefined, mountpoint: undefined, path: undefined }); clearFields("mountpoint", "path"); }}
          onClear={() => { setValues({ device: undefined, mountpoint: undefined, path: undefined }); clearFields("mountpoint", "path"); }}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<JottacloudFolderConfiguratorRpc, JottacloudFolderConfiguratorValues>;
