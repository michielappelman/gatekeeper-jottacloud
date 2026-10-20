import { describe, expect, it, vi } from "vitest";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({ component, props: props ?? {}, children }),
  Field: "Field",
  HierarchyPicker: "HierarchyPicker",
  Section: "Section",
}));
import configuratorSpec from "../src/configurator/jottacloud-configurator-ui";
import type { JottacloudNode } from "../src/configurator/jottacloud-configurator-types";
import {
  JOTTACLOUD_FILE_RESOURCE,
  JOTTACLOUD_FOLDER_RESOURCE,
  normalizeFilePath,
  normalizeFolderPath,
  toFolderResourceUrl,
  toResourceUrl,
} from "../src/resource";

const FILE = JOTTACLOUD_FILE_RESOURCE.urlPattern;
const FOLDER = JOTTACLOUD_FOLDER_RESOURCE.urlPattern;

// `resourceUrl` never calls `ui`; it is present only to satisfy the context type.
const noUi = new Proxy({}, { get() { throw new Error("must not call the ui capability"); } }) as never;

const prefill = (resourceUrl: string) => configuratorSpec.initialValuesFromResourceUrl!({
  resourceUrl, resourceUrlPattern: FOLDER, ui: noUi,
});

// The module is transpiled on its own (see its header comment) and cannot import ../resource.ts, so
// these keep its copy of the URL shapes in step with the code that mints node ids and bindings.
describe("configurator URLs match resource.ts", () => {
  const folders = [
    normalizeFolderPath("", "Archive", ""),
    normalizeFolderPath("", "Sync", "Events/2026"),
    normalizeFolderPath("MyPhone", "Camera Archive", "Q3, final (draft)"),
  ];
  const files = [
    normalizeFilePath("", "", "Events/Guests.xlsx"),
    normalizeFilePath("Jotta", "Archive", "a+b=c&d;e@f:g$h.txt"),
    normalizeFilePath("", "Sync", "Søknad 100%.pdf"),
  ];
  const bindings = [
    ...folders.map(folder => toFolderResourceUrl(folder)),
    ...files.map(file => toResourceUrl(file)),
  ];

  it.each(bindings)("binds the node id %s as itself", async url => {
    expect(await prefill(url)).toEqual({ target: url });
    expect(configuratorSpec.isReady!({ values: { target: url }, acceptedResourceUrlPatterns: [FILE, FOLDER] }))
      .toBe(true);
    expect(await configuratorSpec.resourceUrl({ values: { target: url }, ui: noUi })).toBe(url);
  });

  // An agent's request carries a URL as it wrote it; the picker must still find the node it names.
  it("pre-fills a URL encoded otherwise as the id the gatekeeper lists", async () => {
    const id = toResourceUrl(normalizeFilePath("", "Sync", "Q3, final (draft).xlsx"));
    expect(await prefill("https://jfs.jottacloud.com/jfs/Jotta/Sync/Q3,%20final%20(draft).xlsx")).toEqual({ target: id });
    expect(await prefill("https://jfs.jottacloud.com/jfs-folder/Jotta/Sync/")).toEqual(
      { target: toFolderResourceUrl(normalizeFolderPath("", "Sync", "")) });
  });

  it.each([
    "https://jfs.jottacloud.com/other/Jotta/Sync/a.txt",
    "https://evil.example/jfs/Jotta/Sync/a.txt",
    "https://jfs.jottacloud.com/jfs/Jotta/Sync/%E0%A4%A",
    "not a url",
  ])("pre-fills nothing from %s", async url => {
    expect(await prefill(url)).toEqual({});
  });
});

describe("configurator readiness", () => {
  const folder = toFolderResourceUrl(normalizeFolderPath("", "Sync", "Events"));
  const file = toResourceUrl(normalizeFilePath("", "Sync", "Events/Guests.xlsx"));

  it("is not ready until something is chosen", () => {
    expect(configuratorSpec.isReady!({ values: { target: null } })).toBe(false);
    expect(configuratorSpec.isReady!({ values: {} })).toBe(false);
    expect(() => configuratorSpec.resourceUrl({ values: { target: null }, ui: noUi })).toThrow();
  });

  it("is not ready for a grouping, which binds nothing", () => {
    expect(configuratorSpec.isReady!({ values: { target: "devices" } })).toBe(false);
    expect(configuratorSpec.isReady!({ values: { target: "jottacloud" } })).toBe(false);
    expect(() => configuratorSpec.resourceUrl({ values: { target: "devices" }, ui: noUi })).toThrow();
  });

  // A blueprint binding asks for one type; an older Workshop does not say, and takes either.
  it("is ready only for a type the Workshop accepts", () => {
    expect(configuratorSpec.isReady!({ values: { target: file }, acceptedResourceUrlPatterns: [FOLDER] })).toBe(false);
    expect(configuratorSpec.isReady!({ values: { target: folder }, acceptedResourceUrlPatterns: [FOLDER] })).toBe(true);
    expect(configuratorSpec.isReady!({ values: { target: file } })).toBe(true);
  });
});

type Node = { component: unknown; props: Record<string, any>; children: unknown[] };

function picker(accepted?: readonly string[]) {
  const ui = { listNodes: vi.fn(), getNode: vi.fn() };
  const setValues = vi.fn();
  const tree = configuratorSpec.render({
    values: { target: null }, setValues, clearFields: vi.fn(), ensureResources: vi.fn(), ui,
    acceptedResourceUrlPatterns: accepted,
  }) as Node;
  const find = (node: Node): Node | undefined => node.component === "HierarchyPicker"
    ? node
    : (node.children as Node[]).map(child => child && typeof child === "object" ? find(child) : undefined).find(Boolean);
  return { ui, setValues, props: find(tree)!.props };
}

describe("configurator picker", () => {
  const mountpoint = toFolderResourceUrl(normalizeFolderPath("", "Sync", ""));
  const events = toFolderResourceUrl(normalizeFolderPath("", "Sync", "Events"));
  const guests = toResourceUrl(normalizeFilePath("", "Sync", "Events/Guests.xlsx"));
  const trail = [{ id: mountpoint, title: "Sync", kind: "mountpoint" as const }];
  const NODES: JottacloudNode[] = [
    { id: "devices", title: "Other devices", kind: "group", path: [] },
    { id: events, title: "Events", kind: "folder", path: trail },
    {
      id: guests, title: "Guests.xlsx", kind: "file", size: 12345, modifiedTime: "2026-09-18T10:34:56.000Z",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      path: [...trail, { id: events, title: "Events", kind: "folder" }],
    },
  ];

  it("starts at the account, which cannot itself be chosen", () => {
    expect(picker().props.root).toMatchObject({ id: "jottacloud", title: "Jottacloud", selectable: false });
  });

  it("offers folders and files, opens groupings without offering them", async () => {
    const { ui, props } = picker([FILE, FOLDER]);
    ui.listNodes.mockResolvedValue({ nodes: NODES, nextCursor: "100" });

    const page = await props.loadItems({ parentId: "jottacloud", query: "", cursor: null });
    expect(ui.listNodes).toHaveBeenCalledWith("jottacloud", "", null);
    expect(page.nextCursor).toBe("100");
    expect(page.items.map((item: Record<string, unknown>) => [item.id, item.kind, item.selectable, item.icon]))
      .toEqual([
        ["devices", "container", false, "devices"],
        [events, "container", true, "folder"],
        [guests, "leaf", true, "sheet"],
      ]);
    expect(page.items[1].choice.subtitle).toContain("including anything added later");
    expect(page.items[2].subtitle).toContain("12.1 KB");
    expect(page.items[2].path).toEqual([
      expect.objectContaining({ id: mountpoint, selectable: true }),
      expect.objectContaining({ id: events, selectable: true }),
    ]);
  });

  it("shows a type the Workshop does not accept, but does not offer it", async () => {
    const { ui, props } = picker([FOLDER]);
    ui.listNodes.mockResolvedValue({ nodes: NODES });
    const page = await props.loadItems({ parentId: events, query: "", cursor: null });
    expect(page.items.map((item: Record<string, unknown>) => item.selectable)).toEqual([false, true, false]);
  });

  it("looks a pre-filled node up, or lets it go when it is gone", async () => {
    const { ui, props } = picker();
    ui.getNode.mockResolvedValueOnce(NODES[2]).mockResolvedValueOnce(null);
    expect(await props.loadItem(guests)).toMatchObject({ id: guests, kind: "leaf", selectable: true });
    expect(await props.loadItem(guests)).toBeNull();
  });

  it("stores the choice as the target", () => {
    const { setValues, props } = picker();
    props.onChange(events, null);
    expect(setValues).toHaveBeenCalledWith({ target: events });
  });
});
