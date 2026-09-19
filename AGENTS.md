# Agent guide

## What this repository is

`gatekeeper-jottacloud` is a Cloudflare Worker package for Cloudflare OS. It gives an agent a
scoped, approval-controlled connection to a user's Jottacloud storage:

- `JOTTACLOUD_FILE_RESOURCE` binds exactly one file.
- `JOTTACLOUD_FOLDER_RESOURCE` binds one folder and descendants.

This package is normally a Git submodule under `cloudflare-os-starter/packages/`. It is not a
standalone npm package: `@gadgets/*` dependencies resolve from the consuming Cloudflare OS
workspace.

Read [README.md](README.md) for deployment and user-facing behavior. Use this file for the
implementation constraints that are easy to miss.

## Related repositories

- [Cloudflare OS starter](https://github.com/cloudflare/cloudflare-os-starter): the consuming
  workspace and deployment host. In this workspace it is normally available at
  `../cloudflare-os-starter/`.
- [`@gadgets/gatekeeper-kit`](../cloudflare-os-starter/cloudflare-os/packages/gatekeeper-kit/): the
  shared Gatekeeper library used for connect pages, credential staging/refresh, nonces, and other
  Worker plumbing. Read its `AGENTS.md`, `README.md`, and `USAGE.md` before changing those
  integrations.
- [rclone's Jottacloud backend](https://github.com/rclone/rclone/tree/master/backend/jottacloud):
  the protocol reference for the undocumented Jottacloud HTTP/XML shapes. Keep that dependency
  isolated in `src/jottacloud/` and verify changes with mocked-fetch tests.

## Start here

1. Check `git status` before editing and preserve unrelated worktree changes.
2. Read `src/types.d.ts` for the agent-facing session contract.
3. Read `src/resource.ts` for resource URL formats and path-containment rules.
4. Read the relevant session implementation in `src/jottacloud.ts`.
5. Read the focused tests before changing protocol or security behavior.

The important code paths are:

```text
src/jottacloud.ts       Worker entrypoint, UserAccount, gatekeeper DOs, sessions, configurators
src/resource.ts         File/folder resource URLs and traversal/containment validation
src/jottacloud/auth.ts  Personal login-token exchange and token refresh
src/jottacloud/jfs.ts   JFS metadata, content, and directory/device/mountpoint listing
src/jottacloud/upload.ts Allocate + upload new revisions
src/jottacloud/client.ts JottacloudBackend and production DirectJottacloudBackend
src/cache.ts            File-only cache and pending-write simulation
src/configurator/       Source UI and RPC types; generated UI lives in src/generated/
__tests__/              Mocked protocol, resource, session, cache, and configurator tests
```

## Non-negotiable invariants

- A file session has no path argument. Never add a way for it to retarget another file.
- Folder session paths are relative to the bound folder. All paths must go through
  `resolveWithinFolder()`; never concatenate an agent-supplied path directly into a JFS path.
- Reject empty segments, `.`, `..`, malformed URLs, and wrong hosts. Keep both resource URL parsers
  strict.
- File URLs use `/jfs/`; folder URLs use the synthetic `/jfs-folder/` prefix so the Worker can
  select the correct Durable Object without a live lookup. Treat these URL patterns as permanent
  deployed identity; changing them breaks existing bindings.
- `UserAccount` owns access/refresh credentials. The raw pasted personal login token must not be
  persisted or exposed to an agent session.
- Reads authorize observation through the approval queue. Writes are queued for approval and must
  not become auto-approvable accidentally.
- Writes allocate/upload a new revision at the existing path. Do not implement delete-and-recreate.
- `ifMatchMd5` is checked when an approved write is applied, not only when it is submitted. A stale
  MD5 must raise `FILE_CHANGED` and skip the upload.
- Bindings are private to the connecting account; observer sharing is intentionally rejected.

## Protocol boundary

Jottacloud has no supported public developer API. Keep undocumented HTTP/XML details inside
`src/jottacloud/`, behind `JottacloudBackend` where possible. The current shapes are cross-checked
against rclone's Jottacloud backend and covered by mocked-fetch tests.

When changing protocol code:

- Update the focused tests in `__tests__/jottacloud-*.test.ts`.
- Preserve URL segment encoding, Jottacloud's XML timestamp parsing, retryable statuses, and the
  distinction between JFS reads and the upload allocation endpoint.
- Keep stable `JottacloudErrorCode` mapping in `src/jottacloud/errors.ts`; session code should not
  branch on raw upstream response bodies.

## Caching and approval behavior

Only the file resource currently caches and simulates:

- Metadata and content use a 30-second TTL.
- Content over 1 MB is returned but not retained in Durable Object storage.
- A pending file write is the simulated read view until it is applied or rejected.
- Folder reads/listings are uncached; pending folder writes continue to show the previous remote
  content until approval applies the upload.

If extending folder caching or simulation, use a per-path design. Do not copy the file resource's
single simulation slot across all files in a folder.

## Development and verification

Run commands from the consuming starter after the submodule and Cloudflare OS workspace are
initialized:

```sh
pnpm --filter gatekeeper-jottacloud test:run
pnpm --filter gatekeeper-jottacloud types:check
```

The package scripts are also available directly:

```sh
pnpm test:run
pnpm types:check
pnpm deploy
```

The configurator UI source is under `src/configurator/`; generated `.txt` assets under
`src/generated/` should be regenerated by the package build, not edited by hand. Deployment uses
`wrangler.jsonc`, the Cap'n Web validation build, `nodejs_compat`, and Durable Objects.

Tests use mocked `fetch` and do not need Jottacloud credentials. The file resource has been tested
through a deployed Worker; the folder resource currently has unit coverage only. Known gaps are
live folder verification, a live cross-resource denial test, folder caching/simulation, direct
revision restore, and full Durable Object `ctx.exports` integration tests.

If the local package manager or workspace links are unavailable, report that explicitly rather than
claiming tests passed. At minimum run `git diff --check` and inspect the final diff.
