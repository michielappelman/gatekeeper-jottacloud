# Jottacloud

Jottacloud is a Cloudflare OS gatekeeper that gives the agent and gadgets access to one folder or
one file in a user's [Jottacloud](https://www.jottacloud.com) storage. The agent can list, read and
search through a folder, convert documents to Markdown, and write new revisions or new files. Every
write waits for the user's approval; reads are recorded.

A user connects an account by pasting a Jottacloud personal login token. There is no OAuth flow and
no deployment-wide secret. A connection never covers the whole account.

## What a connection can do

| Capability | Methods | Needs approval |
|---|---|---|
| Browse a folder (folder binding) | `getScope`, `list` | No (recorded) |
| Read a file | `getMetadata`, `read` | No (recorded) |
| Read a document as text | `readAsMarkdown` | No (recorded) |
| Update a file | `write` (a new revision of an existing file) | Yes, always by a person |
| Create a file (folder binding) | `write` to a path that does not exist yet | Yes, always by a person |

What a connection gets depends on what the user picks when connecting:

- **A folder** (or a whole mountpoint such as Sync or Archive) gives a `JottacloudFolderSession`:
  every file and subfolder below it, including anything added later. Paths are relative to the
  folder and can never leave it.
- **A file** gives a `JottacloudFileSession`: that one file. Its methods take no path, so the
  binding cannot be pointed at anything else.

## Connecting an account

1. Sign in at [jottacloud.com](https://www.jottacloud.com/web/secure), open your account's
   security settings, and generate a **personal login token**. A token is usable once.
2. Paste it into the gatekeeper's connect form.
3. Choose what to connect in the picker (see below).

On connect, `UserAccount` exchanges the login token for an access and refresh token at the token's
own issuer, then discards the login token. Only the resulting grant is stored, in the `UserAccount`
Durable Object, and it never reaches an agent-facing object. Access tokens are refreshed
automatically; if the refresh token is rejected, the Workshop is told through
`GatekeeperConnectCallback.credentialsExpired()` and the user reconnects with a new login token.

**White-label providers.** The token carries its own issuer, so the same flow works for Jottacloud's
resellers (MediaMarkt Cloud, Elkjøp, Elgiganten, Telia Sky, Tele2 Cloud and others). Generate the
token from your provider's account settings instead of jottacloud.com.

## Choosing what to connect

Both resource types share one connect card, titled Jottacloud, and one picker:

- **Top level:** the mountpoints of the built-in `Jotta` device, the one Jottacloud's own web and
  mobile apps use (typically Sync and Archive).
- **Other devices:** separately registered desktop or backup clients, under "Other devices". It
  only appears when the account has any.
- **Folders and files** below each mountpoint, folders first.

A mountpoint or folder connects as a folder, a file as a file. The account itself cannot be chosen.
The search box filters the open folder by name. It also takes a pasted path such as
`Sync/Events/Guests.xlsx` (on the `Jotta` device) or a resource URL, and jumps to what it names.
When an agent asks for a specific file or folder, the picker opens on it; if it no longer exists,
nothing is selected.

## Agent API

The full contract lives in [`src/types.d.ts`](src/types.d.ts). A folder binding is suggested as
`JOTTACLOUD_FOLDER`, a file binding as `JOTTACLOUD_FILE`.

```js
export default async function(self, env) {
  // list() is one level deep: pass a folder entry's path back in to descend.
  const entries = await env.JOTTACLOUD_FOLDER.list("Reports");
  const latest = entries
    .filter((e) => !e.isFolder && e.name.endsWith(".xlsx"))
    .sort((a, b) => b.modifiedAt - a.modifiedAt)[0];

  // HTML, PDF, Word, Excel, OpenDocument and Numbers files convert to Markdown.
  const { markdown } = await env.JOTTACLOUD_FOLDER.readAsMarkdown(latest.path);

  // Pass the MD5 you read to refuse the write if the file changed in the meantime.
  const notes = "Reports/summary.md";
  const { md5 } = await env.JOTTACLOUD_FOLDER.getMetadata(notes);
  await env.JOTTACLOUD_FOLDER.write(notes, new TextEncoder().encode(markdown).buffer, md5);
}
```

A file binding has the same reads and `write(content, ifMatchMd5?)`, without the path argument.

Errors carry a stable `code`, such as `RESOURCE_NOT_FOUND`, `INVALID_RESOURCE` (a path that would
leave the folder), `FILE_CHANGED`, `UNSUPPORTED_FOR_MARKDOWN` or `TOO_LARGE_FOR_MARKDOWN` (over
10 MiB).

## How a write runs

1. `write()` validates the path against the binding, stores the content, and submits the action to
   the session's `ApprovalQueue`. It returns once the action is queued, not once it is uploaded.
2. The approval shows the file's path, its size, and whether the write is conditional on an MD5.
3. On a file binding, reads reflect the pending write until it is approved or rejected. On a folder
   binding they keep showing the current content.
4. On approval, the gatekeeper re-checks `ifMatchMd5` against the file's live state and uploads a
   new revision to the same path. A mismatch fails with `FILE_CHANGED` and uploads nothing.

There is no auto-approval: `getAutoApprovableActions()` is empty, so every write waits for a person.
An upload adds a revision instead of replacing the file, so Jottacloud's version history keeps the
previous content. Approved writes are not reverted through the gatekeeper; restore an older
revision in Jottacloud instead.

## Security

- **Token isolation.** The login token is used once and never stored. The access and refresh
  tokens live only in `UserAccount`; sessions never hold them.
- **Capability boundary.** A binding's device, mountpoint and path live in its resource URL, which
  `src/resource.ts` parses strictly: wrong hosts, empty segments, `.` and `..` are refused. Every
  folder-session path goes through `resolveWithinFolder()`, so an agent cannot reach outside the
  bound folder. File URLs use `/jfs/` and folder URLs `/jfs-folder/`, so the right Durable Object is
  chosen from the URL alone, without a lookup.
- **The picker.** Node ids are the resource URLs that bind them. The configurator returns the chosen
  id unchanged, and the same strict parsers decide what gets bound.
- **Observers.** Bindings are private to the person who connected them: Jottacloud has no
  per-user permission to check a second account against, so `addObserver()` always throws.
- **Concurrency.** Jottacloud has no atomic compare-and-swap, so a small race remains between the
  `ifMatchMd5` check and the upload.

## Why talk to JFS directly

Jottacloud publishes no supported developer API. The gatekeeper speaks its JFS HTTP/XML protocol
directly, with the shapes cross-checked against
[rclone's Jottacloud backend](https://github.com/rclone/rclone/tree/master/backend/jottacloud).
That protocol code is isolated in `src/jottacloud/`, behind the `JottacloudBackend` interface, and
covered by mocked-fetch tests. Upstream failures map to stable `JottacloudErrorCode` values, so
session code never branches on raw response bodies.

```text
src/
  jottacloud/     Auth, JFS metadata/content/listing, upload, retry, errors
  resource.ts     Resource URL formats and path containment
  cache.ts        File cache and pending-write simulation
  markdown.ts     Markdown conversion through Workers AI
  configurator/   The folder-or-file picker and its RPC types
  types.d.ts      Agent-facing session interfaces
  jottacloud.ts   Worker entrypoint, Durable Objects, connect flow, sessions, picker RPC
```

## Deployment

This repository is consumed as a Git submodule by a
[`cloudflare-os-starter`](https://github.com/cloudflare/cloudflare-os-starter)-style deployment. It
is not an npm package: its `@gadgets/*` dependencies resolve from the Cloudflare OS workspace pinned
in the starter, which keeps the Gatekeeper Kit ABI aligned with the deployment.

From the root of the starter:

```sh
git submodule add https://github.com/michielappelman/gatekeeper-jottacloud.git packages/gatekeeper-jottacloud
git submodule update --init --recursive
pnpm install
```

The starter must include `packages/*` in `pnpm-workspace.yaml`, and its deploy wrapper must treat
`packages/gatekeeper-jottacloud` as the Jottacloud Worker package:

1. Use this package's `wrangler.jsonc` as the base config. It is generated from
   `cloudflare.config.ts`: edit that, then run `pnpm configs:generate` from the starter root.
2. Generate the production config with the deployment's account, Worker name, service bindings,
   `BASE_URL`, and observability settings.
3. Run `vp run -F gatekeeper-jottacloud --no-cache build` before deploying the Worker.
4. Deploy it before the Workshop and Router, which consume its service binding.
5. Pin the submodule commit in the starter and record it in the deployment inventory.

What the Worker needs:

- **Bindings.** `WORKERS_AI` (Workers AI, for `readAsMarkdown()`), and SQLite-backed Durable
  Objects. Compatibility flags `nodejs_compat` and `allow_irrevocable_stub_storage`.
- **`BASE_URL`.** The public URL the router serves the gatekeeper on, for example
  `https://os.example.com/gatekeeper/jottacloud`, used for the connect form.
- **No secrets.** Each user pastes their own login token.
- **Routing.** The public router is the only route: the Worker needs no `workers.dev` or preview
  URL.

### Development

Run tests and type checks from the consuming starter once the Cloudflare OS submodule is
initialized:

```sh
pnpm --filter gatekeeper-jottacloud test:run
pnpm --filter gatekeeper-jottacloud types:check
```

Tests use mocked `fetch` and need no Jottacloud account. Keep the Cloudflare OS submodule and this
gatekeeper pinned together: if either changes, run the gatekeeper tests, the starter's type checks,
and the full starter check before updating the submodule gitlinks. Implementation invariants for
contributors and agents are in [AGENTS.md](AGENTS.md).

## Known limits

- **Folder bindings are untested live.** File bindings have been exercised end to end against a
  real account (connect, pick, read, write); folder bindings and the picker have unit coverage only.
- **Folders are not cached.** File metadata and content are cached for 30 seconds (content over
  1 MB is not kept); folder listings and reads always go to Jottacloud, and a pending folder write
  is not shown to later reads.
- **No search.** JFS has no server-side search: the picker filters one folder at a time, and the
  agent descends with `list()`.
- **No revision restore.** Recover an older version in Jottacloud's own revision history.
- **Token rotation is a reconnect.** A rejected refresh token needs a new personal login token.
- **Not an identity provider.** `getAuthenticatedEmail()` returns `null`.
- **Untrusted content.** File contents come from wherever the files came from. An agent that reads
  them can meet a prompt injection.

## License

[MIT](LICENSE)
