import { describe, expect, it } from "vitest";
import { JottacloudFileConfiguratorUI, JottacloudFolderConfiguratorUI } from "../src/jottacloud";
import { JottacloudError } from "../src/jottacloud/client";

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

describe("JottacloudFileConfiguratorUI.listDevices", () => {
  it("lists every device when the query is empty", async () => {
    const fetchImpl = async () => new Response(DEVICES_XML, { status: 200 });
    const ui = new JottacloudFileConfiguratorUI(fakeAccount(), fetchImpl as typeof fetch);
    expect(await ui.listDevices("")).toEqual([
      { value: "Jotta", title: "Jotta", subtitle: "JOTTA", meta: "100 B" },
      { value: "Chromebook", title: "My Chromebook", subtitle: "CHROME", meta: undefined },
    ]);
  });

  it("filters by query across name/displayName/type", async () => {
    const fetchImpl = async () => new Response(DEVICES_XML, { status: 200 });
    const ui = new JottacloudFileConfiguratorUI(fakeAccount(), fetchImpl as typeof fetch);
    const options = await ui.listDevices("chrome");
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe("Chromebook");
  });
});

describe("JottacloudFileConfiguratorUI.listMountpoints", () => {
  it("defaults to the 'Jotta' device when none is given", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(MOUNTPOINTS_XML, { status: 200 });
    };
    const ui = new JottacloudFileConfiguratorUI(fakeAccount(), fetchImpl as typeof fetch);
    const options = await ui.listMountpoints(null, "");
    expect(capturedUrl).toBe("https://jfs.jottacloud.com/jfs/alice/Jotta");
    expect(options).toEqual([
      { value: "Archive", title: "Archive", meta: "100 B" },
      { value: "Sync", title: "Sync", meta: undefined },
    ]);
  });
});

describe("JottacloudFileConfiguratorUI.browse", () => {
  it("lists the mountpoint root for an empty query, folders before files, deleted entries dropped", async () => {
    const fetchImpl = async () => new Response(ROOT_FOLDER_XML, { status: 200 });
    const ui = new JottacloudFileConfiguratorUI(fakeAccount(), fetchImpl as typeof fetch);
    const options = await ui.browse(undefined, undefined, "");
    expect(options).toEqual([
      { value: "Events/", title: "Events/", meta: "folder" },
      { value: "Notes.md", title: "Notes.md", subtitle: "text/markdown", meta: "42 B" },
    ]);
  });

  it("resolves a typed 'dir/prefix' query against the right directory and filters by prefix", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(EVENTS_FOLDER_XML, { status: 200 });
    };
    const ui = new JottacloudFileConfiguratorUI(fakeAccount(), fetchImpl as typeof fetch);
    const options = await ui.browse("Jotta", "Archive", "Events/Gue");
    expect(capturedUrl).toBe("https://jfs.jottacloud.com/jfs/alice/Jotta/Archive/Events");
    expect(options).toEqual([
      { value: "Events/Guests.xlsx", title: "Events/Guests.xlsx", subtitle: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", meta: "12.1 KB" },
    ]);
  });

  it("filters out entries that don't match the typed prefix", async () => {
    const fetchImpl = async () => new Response(ROOT_FOLDER_XML, { status: 200 });
    const ui = new JottacloudFileConfiguratorUI(fakeAccount(), fetchImpl as typeof fetch);
    expect(await ui.browse(undefined, undefined, "zzz")).toEqual([]);
  });

  it("treats a directory that doesn't exist as no matches, not an error", async () => {
    const fetchImpl = async () => new Response("not found", { status: 404 });
    const ui = new JottacloudFileConfiguratorUI(fakeAccount(), fetchImpl as typeof fetch);
    await expect(ui.browse(undefined, undefined, "Nope/thing")).resolves.toEqual([]);
  });

  it("propagates a non-404 error instead of swallowing it", async () => {
    const fetchImpl = async () => new Response("unauthorized", { status: 401 });
    const ui = new JottacloudFileConfiguratorUI(fakeAccount(), fetchImpl as typeof fetch);
    await expect(ui.browse(undefined, undefined, "")).rejects.toBeInstanceOf(JottacloudError);
  });
});

describe("JottacloudFolderConfiguratorUI.browseFolders", () => {
  it("lists only folders (never files), with a 'use this' pseudo-entry for the current directory first", async () => {
    const fetchImpl = async () => new Response(ROOT_FOLDER_XML, { status: 200 });
    const ui = new JottacloudFolderConfiguratorUI(fakeAccount(), fetchImpl as typeof fetch);
    const options = await ui.browseFolders(undefined, undefined, "");
    expect(options).toEqual([
      { value: ".", title: "Use the whole Sync mountpoint", meta: "select" },
      { value: "Events", title: "Events", meta: "folder" },
    ]);
  });

  it("uses the real dirPath (not the '.' sentinel) for the 'use this' entry below the root", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(EVENTS_FOLDER_XML, { status: 200 });
    };
    const ui = new JottacloudFolderConfiguratorUI(fakeAccount(), fetchImpl as typeof fetch);
    const options = await ui.browseFolders("Jotta", "Archive", "Events/");
    expect(capturedUrl).toBe("https://jfs.jottacloud.com/jfs/alice/Jotta/Archive/Events");
    expect(options).toEqual([{ value: "Events", title: 'Use "Events"', meta: "select" }]);
  });

  it("drops the 'use this' pseudo-entry once the human is typing a name to filter by", async () => {
    const fetchImpl = async () => new Response(ROOT_FOLDER_XML, { status: 200 });
    const ui = new JottacloudFolderConfiguratorUI(fakeAccount(), fetchImpl as typeof fetch);
    const options = await ui.browseFolders(undefined, undefined, "Eve");
    expect(options).toEqual([{ value: "Events", title: "Events", meta: "folder" }]);
  });

  it("still lists devices/mountpoints, inherited unchanged from JottacloudFileConfiguratorUI", async () => {
    const fetchImpl = async () => new Response(DEVICES_XML, { status: 200 });
    const ui = new JottacloudFolderConfiguratorUI(fakeAccount(), fetchImpl as typeof fetch);
    const options = await ui.listDevices("");
    expect(options).toHaveLength(2);
  });
});
