import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { JottacloudFileConfiguratorRpc, JottacloudFileConfiguratorValues } from "./jottacloud-file-configurator-types";

// Jottacloud partitions storage by device (one per registered client) and mountpoint within it.
// Nobody sees "device" anywhere in Jottacloud's own web/mobile/desktop apps -- they always talk to
// the built-in "Jotta" device transparently -- so it's tucked behind "Advanced" here too, collapsed
// by default. Mountpoint stays visible: Jottacloud's own web UI does show mountpoints as top-level
// folder names (e.g. "Archive", "Sync"), and which one holds the file that matters depends on how
// the account is actually used (desktop-sync users keep their real files under "Sync", not "Archive").
const DEFAULT_DEVICE = "Jotta";
const DEFAULT_MOUNTPOINT = "Sync";

// Must mirror `normalizeFilePath` + `toResourceUrl` in ../resource.ts, which is what actually mints
// the capability. This module is transpiled on its own and cannot import that parser, so
// `__tests__/configurator-url.test.ts` is what keeps the copies honest.
function buildResourceUrl(values: JottacloudFileConfiguratorValues): string {
  const device = (values.device ?? "").trim() || DEFAULT_DEVICE;
  const mountpoint = (values.mountpoint ?? "").trim() || DEFAULT_MOUNTPOINT;
  const path = (values.path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = ["jfs", device, mountpoint, ...path.split("/")];
  return `https://jfs.jottacloud.com/${segments.map(encodeURIComponent).join("/")}`;
}

export default {
  initial: { device: DEFAULT_DEVICE, mountpoint: DEFAULT_MOUNTPOINT },
  isReady: ({ values }) => {
    const raw = (values.path ?? "").trim();
    // A trailing slash means the human browsed into a folder but hasn't picked a file inside it
    // yet -- this gatekeeper only ever binds a file (README.md §16: no folder resource in V1).
    if (!raw || raw.endsWith("/")) return false;
    const path = raw.replace(/^\/+/, "");
    return path.length > 0 && !path.split("/").some(segment => segment === "" || segment === "." || segment === "..");
  },
  resourceUrl: ({ values }) => buildResourceUrl(values),
  render({ values, setValues, clearFields, ui }) {
    const advancedOpen = Boolean(values.advancedOpen);
    return <Section title="Jottacloud file">
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
          onChange={mountpoint => { setValues({ mountpoint: mountpoint ?? undefined }); clearFields("path"); }}
          onClear={() => { setValues({ mountpoint: undefined }); clearFields("path"); }}
        />
      </Field>
      <Field
        label="File"
        description="Search or browse to the file to grant access to. Click a folder to look inside it, then keep typing to narrow further."
      >
        <Autocomplete
          name="path"
          value={values.path}
          placeholder="Search or browse files..."
          loadOptions={query => ui.browse(values.device, values.mountpoint, query)}
          onChange={path => setValues({ path: path ?? undefined })}
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
          onChange={device => { setValues({ device: device ?? undefined }); clearFields("mountpoint", "path"); }}
          onClear={() => { setValues({ device: undefined }); clearFields("mountpoint", "path"); }}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<JottacloudFileConfiguratorRpc, JottacloudFileConfiguratorValues>;
