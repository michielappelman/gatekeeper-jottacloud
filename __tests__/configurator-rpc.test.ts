import { describe, expect, it } from "vitest";
import { JottacloudConfiguratorUI } from "../src/jottacloud";
import { JottacloudError } from "../src/jottacloud/client";
import { normalizeFilePath, normalizeFolderPath, toFolderResourceUrl, toResourceUrl } from "../src/resource";

// Real recorded shape (rclone's backend/jottacloud/api/types.go doc comments): name/display_name
// come back with an xml:space="preserve" attribute, not a bare tag.
const DEVICES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<user>
  <devices>
    <device><name xml:space="preserve">Jotta</name><display_name xml:space="preserve">Jotta</display_name><type>JOTTA</type><size>100</size></device>
    <device><name xml:space="preserve">Chromebook</name><display_name xml:space="preserve">My Chromebook</display_name><type>CHROME</type><size>0</size></device>
  </devices>
</user>`;

const MOUNTPOINTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<device>
  <mountPoints>
    <mountPoint><name xml:space="preserve">Archive</name><size>100</size></mountPoint>
    <mountPoint><name xml:space="preserve">Sync</name><size>0</size></mountPoint>
  </mountPoints>
</device>`;

const ROOT_FOLDER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mountPoint name="Archive">
  <folders>
    <folder name="Events"/>
    <folder name="Trashed" deleted="true"/>
  </folders>
  <files>
    <file name="Notes.md">
      <currentRevision>
        <state>COMPLETED</state>
        <created>2026-09-01-T10:00:00+0200</created>
        <modified>2026-09-18-T12:34:56+0200</modified>
        <size>42</size>
        <mime>text/markdown</mime>
        <md5>abc123</md5>
      </currentRevision>
    </file>
  </files>
</mountPoint>`;

const EVENTS_FOLDER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<folder name="Events">
  <folders></folders>
  <files>
    <file name="Guests.xlsx">
      <currentRevision>
        <state>COMPLETED</state>
        <created>2026-09-01-T10:00:00+0200</created>
        <modified>2026-09-18-T12:34:56+0200</modified>
        <size>12345</size>
        <mime>application/vnd.openxmlformats-officedocument.spreadsheetml.sheet</mime>
        <md5>d41d8cd98f00b204e9800998ecf8427e</md5>
      </currentRevision>
    </file>
  </files>
</folder>`;

function fakeAccount() {
  return { getUsername: async () => "alice", getAccessToken: async () => "token-1" } as never;
}

const ACCOUNT_URL = "https://jfs.jottacloud.com/jfs/alice";

/** Answers each JFS GET from `routes` by URL, 404 for any other, and records what was asked. */
function jfs(routes: Record<string, string | number>) {
  const requested: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const route = routes[url];
    if (typeof route === "number") return new Response("error", { status: route });
    return route === undefined ? new Response("not found", { status: 404 }) : new Response(route, { status: 200 });
  };
  return { requested, ui: new JottacloudConfiguratorUI(fakeAccount(), fetchImpl as typeof fetch) };
}

const folderId = (mountpoint: string, path = "", device = "") =>
  toFolderResourceUrl(normalizeFolderPath(device, mountpoint, path));
const fileId = (mountpoint: string, path: string, device = "") =>
  toResourceUrl(normalizeFilePath(device, mountpoint, path));

const ARCHIVE = { id: folderId("Archive"), title: "Archive", kind: "mountpoint" };
const EVENTS = { id: folderId("Archive", "Events"), title: "Events", kind: "folder" };

describe("JottacloudConfiguratorUI.listNodes", () => {
  it("lists the default device's mountpoints, then other devices as one grouping", async () => {
    const { ui } = jfs({ [ACCOUNT_URL]: DEVICES_XML, [`${ACCOUNT_URL}/Jotta`]: MOUNTPOINTS_XML });
    expect(await ui.listNodes("jottacloud", "", null)).toEqual({
      nodes: [
        { ...ARCHIVE, size: 100, path: [] },
        { id: folderId("Sync"), title: "Sync", kind: "mountpoint", size: 0, path: [] },
        { id: "devices", title: "Other devices", kind: "group", path: [] },
      ],
      nextCursor: undefined,
    });
  });

  it("leaves the grouping out for an account with only the default device", async () => {
    const onlyJotta = DEVICES_XML.replace(/<device><name xml:space="preserve">Chromebook[\s\S]*?<\/device>/, "");
    const { ui } = jfs({ [ACCOUNT_URL]: onlyJotta, [`${ACCOUNT_URL}/Jotta`]: MOUNTPOINTS_XML });
    expect((await ui.listNodes("jottacloud", "", null)).nodes.map(node => node.id))
      .toEqual([folderId("Archive"), folderId("Sync")]);
  });

  it("lists other devices, and a device's mountpoints below it", async () => {
    const { ui } = jfs({ [ACCOUNT_URL]: DEVICES_XML, [`${ACCOUNT_URL}/Chromebook`]: MOUNTPOINTS_XML });
    const devices = await ui.listNodes("devices", "", null);
    const group = { id: "devices", title: "Other devices", kind: "group" };
    expect(devices.nodes).toEqual([
      { id: "device:Chromebook", title: "My Chromebook", kind: "device", size: 0, path: [group] },
    ]);

    const mountpoints = await ui.listNodes("device:Chromebook", "", null);
    expect(mountpoints.nodes[0]).toEqual({
      id: folderId("Archive", "", "Chromebook"), title: "Archive", kind: "mountpoint", size: 100,
      path: [group, { id: "device:Chromebook", title: "Chromebook", kind: "device" }],
    });
  });

  it("lists a mountpoint's folders before its files, without deleted entries", async () => {
    const { ui, requested } = jfs({ [`${ACCOUNT_URL}/Jotta/Archive`]: ROOT_FOLDER_XML });
    expect((await ui.listNodes(folderId("Archive"), "", null)).nodes).toEqual([
      { ...EVENTS, path: [ARCHIVE] },
      {
        id: fileId("Archive", "Notes.md"), title: "Notes.md", kind: "file", size: 42, mimeType: "text/markdown",
        modifiedTime: "2026-09-18T10:34:56.000Z", path: [ARCHIVE],
      },
    ]);
    expect(requested).toEqual([`${ACCOUNT_URL}/Jotta/Archive`]);
  });

  it("gives a folder's entries their whole path", async () => {
    const { ui } = jfs({ [`${ACCOUNT_URL}/Jotta/Archive/Events`]: EVENTS_FOLDER_XML });
    const [guests] = (await ui.listNodes(EVENTS.id, "", null)).nodes;
    expect(guests).toMatchObject({ id: fileId("Archive", "Events/Guests.xlsx"), path: [ARCHIVE, EVENTS] });
  });

  it("filters the open location by name", async () => {
    const { ui } = jfs({ [`${ACCOUNT_URL}/Jotta/Archive`]: ROOT_FOLDER_XML });
    expect((await ui.listNodes(folderId("Archive"), " NOTES ", null)).nodes.map(node => node.title)).toEqual(["Notes.md"]);
    expect((await ui.listNodes(folderId("Archive"), "zzz", null)).nodes).toEqual([]);
  });

  it("pages a long listing by offset", async () => {
    const many = Array.from({ length: 150 }, (_, index) => `<folder name="f${String(index).padStart(3, "0")}"/>`).join("");
    const { ui } = jfs({ [`${ACCOUNT_URL}/Jotta/Archive`]: `<mountPoint><folders>${many}</folders><files></files></mountPoint>` });
    const first = await ui.listNodes(folderId("Archive"), "", null);
    expect(first.nodes).toHaveLength(100);
    expect(first.nextCursor).toBe("100");
    const second = await ui.listNodes(folderId("Archive"), "", first.nextCursor!);
    expect(second.nodes.map(node => node.title)).toEqual(Array.from({ length: 50 }, (_, index) => `f${100 + index}`));
    expect(second.nextCursor).toBeUndefined();
    await expect(ui.listNodes(folderId("Archive"), "", "-1")).rejects.toThrow("Invalid cursor");
  });

  it("looks a pasted path up on the default device", async () => {
    const { ui } = jfs({
      [`${ACCOUNT_URL}/Jotta/Archive/Events`]: EVENTS_FOLDER_XML,
      [`${ACCOUNT_URL}/Jotta/Archive`]: ROOT_FOLDER_XML,
      [`${ACCOUNT_URL}/Jotta`]: MOUNTPOINTS_XML,
    });
    expect((await ui.listNodes("jottacloud", "/Archive/Events/Guests.xlsx", null)).nodes.map(node => node.id))
      .toEqual([fileId("Archive", "Events/Guests.xlsx")]);
    expect((await ui.listNodes("jottacloud", "Archive/Events/", null)).nodes.map(node => node.id)).toEqual([EVENTS.id]);
    expect((await ui.listNodes("jottacloud", "Archive/", null)).nodes.map(node => node.id)).toEqual([ARCHIVE.id]);
    expect((await ui.listNodes("jottacloud", "Archive/Nope/x", null)).nodes).toEqual([]);
    expect((await ui.listNodes("jottacloud", "Archive/../Sync", null)).nodes).toEqual([]);
  });

  it("looks a pasted resource URL up, however it is encoded", async () => {
    const { ui } = jfs({ [`${ACCOUNT_URL}/Jotta/Archive`]: ROOT_FOLDER_XML });
    const page = await ui.listNodes(folderId("Archive"), "https://jfs.jottacloud.com/jfs-folder/Jotta/Archive/Events/", null);
    expect(page.nodes.map(node => node.id)).toEqual([EVENTS.id]);
  });

  it("refuses to list a file or a forged id", async () => {
    const { ui } = jfs({});
    await expect(ui.listNodes(fileId("Archive", "Notes.md"), "", null)).rejects.toBeInstanceOf(JottacloudError);
    await expect(ui.listNodes("https://jfs.jottacloud.com/jfs-folder/Jotta/Archive/..", "", null))
      .rejects.toMatchObject({ code: "INVALID_RESOURCE" });
  });

  it("propagates a JFS failure for the picker to offer Retry", async () => {
    const { ui } = jfs({ [`${ACCOUNT_URL}/Jotta/Archive`]: 401 });
    await expect(ui.listNodes(folderId("Archive"), "", null)).rejects.toBeInstanceOf(JottacloudError);
  });
});

describe("JottacloudConfiguratorUI.getNode", () => {
  const { ui } = jfs({
    [`${ACCOUNT_URL}/Jotta`]: MOUNTPOINTS_XML,
    [`${ACCOUNT_URL}/Jotta/Archive`]: ROOT_FOLDER_XML,
    [`${ACCOUNT_URL}/Jotta/Archive/Events`]: EVENTS_FOLDER_XML,
  });

  it("finds a mountpoint, folder and file with their paths", async () => {
    expect(await ui.getNode(ARCHIVE.id)).toEqual({ ...ARCHIVE, size: 100, path: [] });
    expect(await ui.getNode(EVENTS.id)).toEqual({ ...EVENTS, path: [ARCHIVE] });
    expect(await ui.getNode(fileId("Archive", "Events/Guests.xlsx")))
      .toMatchObject({ kind: "file", title: "Guests.xlsx", path: [ARCHIVE, EVENTS] });
  });

  it("finds nothing that is missing, deleted, or of the other kind", async () => {
    expect(await ui.getNode(folderId("Nope"))).toBeNull();
    expect(await ui.getNode(folderId("Archive", "Trashed"))).toBeNull();
    expect(await ui.getNode(folderId("Archive", "Nope/Deeper"))).toBeNull();
    expect(await ui.getNode(folderId("Archive", "Notes.md"))).toBeNull();
    expect(await ui.getNode(fileId("Archive", "Events"))).toBeNull();
  });

  it("finds nothing for an id that is no resource URL", async () => {
    expect(await ui.getNode("devices")).toBeNull();
    expect(await ui.getNode("https://jfs.jottacloud.com/jfs/Jotta/Archive/../x")).toBeNull();
  });
});
