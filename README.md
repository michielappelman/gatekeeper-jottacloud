# Jottacloud Gatekeeper

A Cloudflare Worker that gives an agent scoped access to a user's Jottacloud storage through
Cloudflare OS. A connection grants either one file or one folder; it never grants the whole
account.

```
Agent → Cloudflare OS → Jottacloud Gatekeeper → Jottacloud JFS/API
```

## Resources

| Resource | Scope | Session API |
| --- | --- | --- |
| `JOTTACLOUD_FILE_RESOURCE` | One fixed file | `getMetadata()`, `read()`, `write()` |
| `JOTTACLOUD_FOLDER_RESOURCE` | One folder and its descendants | `getScope()`, `list()`, `getMetadata()`, `read()`, `write()` |

File sessions do not accept a path, so they cannot be retargeted. Folder session paths are relative
to the bound folder, are checked for traversal, and can never escape that folder. `list()` returns
immediate children only; call it again with a returned folder path to descend.

Writes are sent through the normal approval queue. Neither resource has auto-approvable actions,
and bindings are private to the user who connected the Jottacloud account.

## Connect and deploy

This repository is intended to be consumed as a Git submodule by a
[`cloudflare-os-starter`](https://github.com/cloudflare/cloudflare-os-starter)-style deployment.
It is not a standalone npm package: its `@gadgets/*` dependencies come from the consuming
Cloudflare OS workspace.

From the starter root:

```sh
git submodule add git@github.com:michielappelman/gatekeeper-jottacloud.git packages/gatekeeper-jottacloud
git submodule update --init --recursive
pnpm install
```

The starter must include `packages/*` in `pnpm-workspace.yaml`. Its deployment should:

1. Use this package's `wrangler.jsonc` as the base Worker configuration.
2. Set the deployed Worker name, service bindings, `BASE_URL`, and observability settings.
3. Build the package before deploying it.
4. Deploy it before the Workshop and Router, which consume its service binding.
5. Pin the submodule commit in the starter's deployment inventory.

The public Router is the only route. The Jottacloud Worker does not need a public or preview URL,
and no deployment-wide Jottacloud secret is required.

Users connect by pasting a personal Jottacloud login token into the Worker flow. The raw token is
exchanged server-side and is not stored; the resulting credential grant is kept in the account
Durable Object. The same flow supports Jottacloud white-label providers such as MediaMarkt Cloud,
Elkjøp, and Telia because the token carries its own issuer information.

For local development and tests, run from the consuming starter after initializing the submodule:

```sh
pnpm --filter gatekeeper-jottacloud test:run
pnpm --filter gatekeeper-jottacloud types:check
```

Keep the starter and this submodule pinned together. When either changes, run the package tests,
the starter type check, and the full starter check before updating the submodule reference.

## Behavior and security

- A file binding identifies `{device, mountpoint, path}` in its resource URL. A folder binding uses
  the same addressing scheme under the separate `jfs-folder` URL prefix.
- Resource URLs and folder-relative paths reject empty segments, `.` and `..`, wrong hosts, and
  malformed paths.
- A write uploads a new revision to the existing Jottacloud path. It does not delete and recreate
  the file, so Jottacloud's revision history remains available.
- Pass the MD5 from an earlier `getMetadata()` or `read()` as `ifMatchMd5` for optimistic
  concurrency. The check is repeated when an approved write is applied; a mismatch returns
  `FILE_CHANGED`. Jottacloud provides no atomic compare-and-swap operation, so a small race remains
  between the check and upload.
- File metadata and content are cached for 30 seconds. Content larger than 1 MB is not retained in
  the cache. A pending file write is simulated for reads until it is approved or rejected.
- Folder reads and listings are not cached, and pending folder writes are not simulated yet.
- Credential expiry is surfaced as a reconnect request. Revoking a connection removes the local
  credentials; Jottacloud's own device/session controls can be used for any provider-side cleanup.

## Implementation

The direct Jottacloud protocol is isolated behind `JottacloudBackend`. Jottacloud does not publish
a supported public developer API, so the HTTP/XML shapes are cross-checked against rclone's
Jottacloud backend and protected by mocked-fetch tests. Keep protocol changes in `src/jottacloud/`
and session/resource behavior in the surrounding gatekeeper layers.

```text
src/
  jottacloud/           HTTP auth, JFS metadata/content/listing, upload, retry, errors
  resource.ts           Resource URL formats and path/containment validation
  cache.ts              File cache and pending-write simulation
  configurator/         Live device, mountpoint, file, and folder selection UIs
  types.d.ts            Agent-facing file and folder session interfaces
  jottacloud.ts         Worker entrypoint, Durable Objects, connect flow, and sessions
__tests__/               Protocol, resource, session, configurator, and cache tests
```

Important implementation boundaries:

- `JottacloudGatekeeperImpl` owns one file binding; `JottacloudFolderGatekeeperImpl` owns one
  folder binding.
- `UserAccount` owns credentials and token refresh. Credentials never reach the agent session.
- `DirectJottacloudBackend` is the production backend. `JottacloudBackend` is the seam used by
  session tests and future protocol changes.
- The configurator lists devices, mountpoints, and one directory level at a time through JFS.

## Testing and status

Run `pnpm test:run` for the package test suite and `pnpm types:check` for TypeScript checks. Tests
cover authentication and refresh handling, JFS/XML parsing, upload and retry behavior, resource
URL validation, folder containment, approval bookkeeping, optimistic concurrency, caching, and
configurator behavior. Protocol tests use mocked `fetch`; they do not require a Jottacloud account.

The file resource has been exercised against a real account through a deployed Worker, including
connect, configure, read, and write. The folder resource currently has unit coverage only.

Known gaps:

- Live verification of folder connect, list, read, write, and configurator behavior.
- A live/adversarial deployment test for cross-resource denial.
- Folder-specific caching and pending-write simulation.
- Direct revision restore; use Jottacloud's own revision history to recover an older version.
- End-to-end Durable Object tests through the Cloudflare `ctx.exports` plumbing.
