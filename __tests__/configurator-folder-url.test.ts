import { describe, expect, it, vi } from "vitest";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({ component, props, children }),
  Field: "Field",
  Section: "Section",
  Autocomplete: "Autocomplete",
}));
import configuratorSpec from "../src/configurator/jottacloud-folder-configurator-ui";
import { normalizeFolderPath, parseFolderResourceUrl, toFolderResourceUrl } from "../src/resource";

// The configurators never call `ui` from these two methods; it is present only to satisfy the
// context type, and touching it is a bug.
const noUi = new Proxy({}, { get() { throw new Error("must not call the ui capability"); } }) as never;

// The configurator module is transpiled on its own (see its header comment) and cannot import
// ../resource.ts, so this test is what keeps its inlined URL-building logic in sync with the real
// parser that actually mints the capability.
describe("folder configurator resourceUrl matches resource.ts", () => {
  const cases: Array<{ device?: string; mountpoint?: string; path: string }> = [
    { path: "Documents/ProjectX" },
    { device: "Jotta", mountpoint: "Sync", path: "Notes" },
    { device: "MyPhone", mountpoint: "Camera Archive", path: "2026" },
    { path: "" }, // the mountpoint's own root
    { path: "/leading/and/trailing/slashes/folder/" },
  ];

  for (const testCase of cases) {
    it(`matches for ${JSON.stringify(testCase)}`, async () => {
      const fromConfigurator = await configuratorSpec.resourceUrl({
        values: { device: testCase.device, mountpoint: testCase.mountpoint, path: testCase.path },
        ui: noUi,
      });
      const fromResource = toFolderResourceUrl(
        normalizeFolderPath(testCase.device ?? "", testCase.mountpoint ?? "", testCase.path));
      expect(fromConfigurator).toBe(fromResource);
      // And the built URL parses back to the same folder.
      expect(parseFolderResourceUrl(fromConfigurator)).toEqual(
        normalizeFolderPath(testCase.device ?? "", testCase.mountpoint ?? "", testCase.path));
    });
  }

  it("isReady requires an explicit selection, but accepts an empty one (the mountpoint root)", () => {
    expect(configuratorSpec.isReady?.({ values: { path: "Documents" } })).toBe(true);
    expect(configuratorSpec.isReady?.({ values: { path: "" } })).toBe(true);
    expect(configuratorSpec.isReady?.({ values: {} })).toBe(false);
    expect(configuratorSpec.isReady?.({ values: { path: undefined } })).toBe(false);
  });

  it("isReady rejects a traversal path", () => {
    expect(configuratorSpec.isReady?.({ values: { path: "../secrets" } })).toBe(false);
    expect(configuratorSpec.isReady?.({ values: { path: "a/../b" } })).toBe(false);
  });
});

// The render tree is a plain object graph under the mock above (`h` never invokes a string
// component), so it can be walked directly to check which Fields are present.
function fieldLabels(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const { props, children } = node as { props?: { label?: string }; children?: unknown[] };
  const own = props?.label ? [props.label] : [];
  return own.concat((children ?? []).flatMap(fieldLabels));
}

describe("folder configurator Advanced disclosure", () => {
  const baseValues = { device: "Jotta", mountpoint: "Sync", path: "" };

  it("hides the Device field until Advanced is toggled open", () => {
    const tree = configuratorSpec.render({ values: baseValues, setValues: vi.fn(), clearFields: vi.fn(), ui: noUi });
    expect(fieldLabels(tree)).toEqual(["Mountpoint", "Folder"]);
  });

  it("shows the Device field once advancedOpen is set", () => {
    const tree = configuratorSpec.render({
      values: { ...baseValues, advancedOpen: "1" }, setValues: vi.fn(), clearFields: vi.fn(), ui: noUi,
    });
    expect(fieldLabels(tree)).toEqual(["Mountpoint", "Folder", "Device"]);
  });
});
