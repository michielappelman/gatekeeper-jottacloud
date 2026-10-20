import {
  Field, h, HierarchyPicker, Section,
  type ConfiguratorUIHierarchyAncestor, type ConfiguratorUIHierarchyItem, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  JottacloudConfiguratorRpc, JottacloudConfiguratorValues, JottacloudNode, JottacloudNodeAncestor,
} from "./jottacloud-configurator-types";

// Must mirror `toResourceUrl`/`toFolderResourceUrl` and the URL patterns in ../resource.ts, which
// is what actually mints the capability. This module is transpiled on its own and cannot import
// those, so `__tests__/configurator-ui.test.ts` is what keeps the copies honest.
const RESOURCE_ORIGIN = "https://jfs.jottacloud.com";
const FILE_PATTERN = `${RESOURCE_ORIGIN}/jfs/*`;
const FOLDER_PATTERN = `${RESOURCE_ORIGIN}/jfs-folder/*`;

/** The account's node, the picker's root. Not a resource: a connection never grants the account. */
const ROOT_ID = "jottacloud";

/** The resource type a node binds, or undefined for a grouping, which binds nothing. */
const patternOf = (id: string): string | undefined =>
  id.startsWith(`${RESOURCE_ORIGIN}/jfs-folder/`) ? FOLDER_PATTERN
  : id.startsWith(`${RESOURCE_ORIGIN}/jfs/`) ? FILE_PATTERN
  : undefined;

/** Whether the Workshop accepts the type a node binds. An older Workshop does not say, and takes any. */
const accepts = (accepted: readonly string[] | undefined, id: string): boolean => {
  const pattern = patternOf(id);
  return pattern !== undefined && (accepted === undefined || accepted.includes(pattern));
};

/**
 * A resource URL as the gatekeeper writes node ids, so a pre-filled URL encoded differently (an
 * agent's `%20` against a `+`, an unescaped `,`) still names the node the picker lists.
 */
const canonicalResourceUrl = (resourceUrl: string): string | undefined => {
  try {
    const url = new URL(resourceUrl);
    if (url.origin !== RESOURCE_ORIGIN) return undefined;
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const canonical = `${RESOURCE_ORIGIN}/${segments.map(encodeURIComponent).join("/")}`;
    return patternOf(canonical) ? canonical : undefined;
  } catch {
    return undefined;
  }
};

const icon = (d: string) => <svg viewBox="0 0 256 256" fill="currentColor"><path d={d} /></svg>;

// Phosphor's regular weight, as the runtime's own icons.
const ICONS = {
  cloud: icon("M160,40A88.09,88.09,0,0,0,81.29,88.67,64,64,0,1,0,72,216h88a88,88,0,0,0,0-176Zm0,160H72a48,48,0,0,1,0-96c1.1,0,2.2,0,3.29.11A88,88,0,0,0,72,128a8,8,0,0,0,16,0,72,72,0,1,1,72,72Z"),
  devices: icon("M208,136H48a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V152A16,16,0,0,0,208,136Zm0,64H48V152H208v48Zm0-160H48A16,16,0,0,0,32,56v48a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V56A16,16,0,0,0,208,40Zm0,64H48V56H208v48ZM192,80a12,12,0,1,1-12-12A12,12,0,0,1,192,80Zm0,96a12,12,0,1,1-12-12A12,12,0,0,1,192,176Z"),
  folder: icon("M216,72H131.31L104,44.69A15.86,15.86,0,0,0,92.69,40H40A16,16,0,0,0,24,56V200.62A15.4,15.4,0,0,0,39.38,216H216.89A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72ZM40,56H92.69l16,16H40ZM216,200H40V88H216Z"),
  doc: icon("M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z"),
  sheet: icon("M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM40,112H80v32H40Zm56,0H216v32H96ZM216,64V96H40V64ZM40,160H80v32H40Zm176,32H96V160H216v32Z"),
  pdf: icon("M224,152a8,8,0,0,1-8,8H192v16h16a8,8,0,0,1,0,16H192v16a8,8,0,0,1-16,0V152a8,8,0,0,1,8-8h32A8,8,0,0,1,224,152ZM92,172a28,28,0,0,1-28,28H56v8a8,8,0,0,1-16,0V152a8,8,0,0,1,8-8H64A28,28,0,0,1,92,172Zm-16,0a12,12,0,0,0-12-12H56v24h8A12,12,0,0,0,76,172Zm88,8a36,36,0,0,1-36,36H112a8,8,0,0,1-8-8V152a8,8,0,0,1,8-8h16A36,36,0,0,1,164,180Zm-16,0a20,20,0,0,0-20-20h-8v40h8A20,20,0,0,0,148,180ZM40,112V40A16,16,0,0,1,56,24h96a8,8,0,0,1,5.66,2.34l56,56A8,8,0,0,1,216,88v24a8,8,0,0,1-16,0V96H152a8,8,0,0,1-8-8V40H56v72a8,8,0,0,1-16,0ZM160,80h28.69L160,51.31Z"),
  image: icon("M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.06a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,172l52-52,80,80H40Zm176,28H194.63l-36-36,20-20L216,181.38V200ZM144,100a12,12,0,1,1,12,12A12,12,0,0,1,144,100Z"),
};

const fileIconOf = (mimeType: string): keyof typeof ICONS | undefined =>
  mimeType === "application/pdf" ? "pdf"
  : mimeType.startsWith("image/") ? "image"
  : /spreadsheet|excel|csv/.test(mimeType) ? "sheet"
  : mimeType.startsWith("text/") || /wordprocessing|msword|opendocument\.text/.test(mimeType) ? "doc"
  : undefined;

const iconOf = (node: Pick<JottacloudNode, "kind" | "mimeType">): keyof typeof ICONS | undefined => {
  switch (node.kind) {
    case "group":
    case "device": return "devices";
    case "mountpoint":
    case "folder": return "folder";
    default: return fileIconOf(node.mimeType ?? "");
  }
};

const bytes = (size: number | undefined): string | undefined => {
  if (size === undefined || !Number.isFinite(size) || size <= 0) return undefined;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

const modified = (value: string | undefined): string | undefined => {
  const date = value === undefined ? undefined : new Date(value);
  return date && !Number.isNaN(date.getTime())
    ? `Modified ${date.toLocaleDateString(undefined, { dateStyle: "medium" })}`
    : undefined;
};

// A folder grant reaches everything in it, checked again on every call.
const FOLDER_CHOICE = { subtitle: "All of its files and subfolders, including anything added later" };

const isFolder = (kind: JottacloudNode["kind"]) => kind === "mountpoint" || kind === "folder";

const toAncestor = (
  { id, title, kind }: JottacloudNodeAncestor,
  accepted: readonly string[] | undefined,
): ConfiguratorUIHierarchyAncestor => isFolder(kind)
  ? { id, title, icon: iconOf({ kind }), selectable: accepts(accepted, id), choice: FOLDER_CHOICE }
  : { id, title, icon: iconOf({ kind }), selectable: false };

/** A grouping or device opens but binds nothing; a mountpoint or folder binds as a folder. */
const toItem = (node: JottacloudNode, accepted: readonly string[] | undefined): ConfiguratorUIHierarchyItem => {
  const file = node.kind === "file";
  return {
    id: node.id,
    title: node.title,
    kind: file ? "leaf" : "container",
    icon: iconOf(node),
    subtitle: [modified(node.modifiedTime), bytes(node.size)].filter(Boolean).join(" · ") || undefined,
    selectable: (file || isFolder(node.kind)) && accepts(accepted, node.id),
    choice: isFolder(node.kind) ? FOLDER_CHOICE : undefined,
    path: node.path.map(ancestor => toAncestor(ancestor, accepted)),
  };
};

export default {
  initial: { target: null },
  initialValuesFromResourceUrl: ({ resourceUrl }) => {
    const target = canonicalResourceUrl(resourceUrl);
    return target ? { target } : {};
  },
  isReady: ({ values: { target }, acceptedResourceUrlPatterns }) =>
    typeof target === "string" && accepts(acceptedResourceUrlPatterns, target),
  resourceUrl: ({ values: { target } }) => {
    if (!target || !patternOf(target)) throw new Error("Choose a folder or a file to connect.");
    return target;
  },
  render({ values: { target = null }, setValues, ui, acceptedResourceUrlPatterns: accepted }) {
    return <Section>
      <Field label="What to connect">
        <HierarchyPicker
          name="target"
          value={target}
          root={{ id: ROOT_ID, title: "Jottacloud", icon: "cloud", selectable: false }}
          loadItems={async ({ parentId, query, cursor }) => {
            const page = await ui.listNodes(parentId, query, cursor);
            return { items: page.nodes.map(node => toItem(node, accepted)), nextCursor: page.nextCursor };
          }}
          loadItem={async id => {
            const node = await ui.getNode(id);
            return node && toItem(node, accepted);
          }}
          onChange={next => setValues({ target: next })}
          icons={ICONS}
          searchPlaceholder="Filter this folder or paste a path…"
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<JottacloudConfiguratorRpc, JottacloudConfiguratorValues>;
