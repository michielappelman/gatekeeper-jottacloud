import { describe, expect, it, vi } from "vitest";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({ component, props, children }),
  Field: "Field",
  Section: "Section",
  Autocomplete: "Autocomplete",
}));
import configuratorSpec from "../src/configurator/jottacloud-file-configurator-ui";
import { normalizeFilePath, parseResourceUrl, toResourceUrl } from "../src/resource";

// The configurators never call `ui` from these two methods; it is present only to satisfy the
// context type, and touching it is a bug.
const noUi = new Proxy({}, { get() { throw new Error("must not call the ui capability"); } }) as never;

// The configurator module is transpiled on its own (see its header comment) and cannot import
// ../resource.ts, so this test is what keeps its inlined URL-building logic in sync with the real
// parser that actually mints the capability.
describe("configurator resourceUrl matches resource.ts", () => {
  const cases: Array<{ device?: string; mountpoint?: string; path: string }> = [
    { path: "Events/Guests.xlsx" },
    { device: "Jotta", mountpoint: "Archive", path: "Notes.md" },
    { device: "MyPhone", mountpoint: "Camera Archive", path: "2026/photo.jpg" },
    { path: "Q3 Report (draft).xlsx" },
    { path: "/leading/and/trailing/slashes/file.txt/" },
  ];

  for (const testCase of cases) {
    it(`matches for ${JSON.stringify(testCase)}`, async () => {
      const fromConfigurator = await configuratorSpec.resourceUrl({
        values: { device: testCase.device, mountpoint: testCase.mountpoint, path: testCase.path },
        ui: noUi,
      });
      const fromResource = toResourceUrl(
        normalizeFilePath(testCase.device ?? "", testCase.mountpoint ?? "", testCase.path));
      expect(fromConfigurator).toBe(fromResource);
      // And the built URL parses back to the same file.
      expect(parseResourceUrl(fromConfigurator)).toEqual(
        normalizeFilePath(testCase.device ?? "", testCase.mountpoint ?? "", testCase.path));
    });
  }

  it("isReady requires a non-traversal path", () => {
    expect(configuratorSpec.isReady?.({ values: { path: "Guests.xlsx" } })).toBe(true);
    expect(configuratorSpec.isReady?.({ values: { path: "" } })).toBe(false);
    expect(configuratorSpec.isReady?.({ values: { path: "../secrets.txt" } })).toBe(false);
    expect(configuratorSpec.isReady?.({ values: { path: "a/../b" } })).toBe(false);
  });

  it("isReady rejects a folder the human has browsed into but not picked a file inside", () => {
    expect(configuratorSpec.isReady?.({ values: { path: "Events/" } })).toBe(false);
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

describe("configurator Advanced disclosure", () => {
  const baseValues = { device: "Jotta", mountpoint: "Sync", path: "" };

  it("hides the Device field until Advanced is toggled open", () => {
    const tree = configuratorSpec.render({ values: baseValues, setValues: vi.fn(), clearFields: vi.fn(), ui: noUi });
    expect(fieldLabels(tree)).toEqual(["Mountpoint", "File"]);
  });

  it("shows the Device field once advancedOpen is set", () => {
    const tree = configuratorSpec.render({
      values: { ...baseValues, advancedOpen: "1" }, setValues: vi.fn(), clearFields: vi.fn(), ui: noUi,
    });
    expect(fieldLabels(tree)).toEqual(["Mountpoint", "File", "Device"]);
  });
});
