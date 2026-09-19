# Jottacloud Gatekeeper

Gives an agent read / write / metadata access to **one Jottacloud file or folder** the user chooses,
direct from a Cloudflare Worker — no local `jotta-cli` server in the path. Implements all seven
write-gatekeeper-skill responsibilities that apply here — auth, capability-based API design,
fine-grained resource granting, logging & approvals, caching, simulation, and observer verification
— except hooks (push notifications), which don't apply: Jottacloud gives us no verified push
mechanism to build one on. Caching and simulation are only implemented for the file resource, not
yet the folder one — see [What's not done](#whats-not-done).

```
AI Agent → Cloudflare OS → Jottacloud Gatekeeper → Jottacloud JFS / API
```

## Use in another Cloudflare OS starter

This repository is designed to be consumed as a Git submodule by a
[`cloudflare-os-starter`](https://github.com/cloudflare/cloudflare-os-starter)-style deployment.
It is not an npm package: its `@gadgets/*` dependencies are resolved from the pinned Cloudflare OS
workspace in the consuming starter, which keeps the Gatekeeper Kit ABI aligned with the deployment.

From the root of the starter:

```sh
git submodule add git@github.com:michielappelman/gatekeeper-jottacloud.git packages/gatekeeper-jottacloud
git submodule update --init --recursive
pnpm install
```

The starter must include `packages/*` in `pnpm-workspace.yaml`, and its deploy wrapper must treat
`packages/gatekeeper-jottacloud` as the Jottacloud Worker package. In practice that means:

1. Read this package's `wrangler.jsonc` as the base Jottacloud config.
2. Generate the production config with the deployment's account, Worker name, service bindings,
   `BASE_URL`, and observability settings.
3. Run `vp run -F gatekeeper-jottacloud --no-cache build` before deploying the Worker.
4. Deploy it before the Workshop and Router, which consume its service binding.
5. Pin the submodule commit in the starter and record that commit in the deployment inventory.

The starter's `workers.jottacloud.name` is the deployed Worker identity; it need not be
`gatekeeper-jottacloud`. The public router is the only route: the Jottacloud Worker should have no
public or preview URL. Users authenticate their own Jottacloud account through the Gatekeeper's
connect flow, so no deployment-wide Jottacloud secret is required.

For local development and tests, run them from the consuming starter after the Cloudflare OS
submodule is initialized:

```sh
pnpm --filter gatekeeper-jottacloud test:run
pnpm --filter gatekeeper-jottacloud types:check
```

Keep the Cloudflare OS submodule and this Gatekeeper pinned together. If either changes, run the
Gatekeeper tests, the starter's type checks, and the full starter check before updating the
submodule gitlinks.

## Status: file resource verified live end-to-end; folder resource unit-tested only

Everything in `src/jottacloud/` reproduces a protocol shape cross-checked against **rclone's current
Jottacloud backend source** (`rclone/rclone`, `backend/jottacloud/`, fetched during this work) and is
covered by unit tests with a mocked `fetch`. The **file** resource has been connected to a real
Jottacloud account and used from the deployed Worker: the connect flow, the resource configurator's
live device/mountpoint/folder Autocomplete, a live `getMetadata()`/`read()`, and a live `write()`
have all been exercised for real (Gates 1, 2, 3, and 5 below). Only a live/adversarial check of Gate
6 (cross-resource denial) remains unexercised outside unit tests. The **folder** resource (added
after the file resource went live) reuses the same protocol layer and is unit-tested the same way,
but has not itself been connected to a real account yet — do not treat it as finished until it has.

## Evidence

Jottacloud has no official public developer API (their support has said so directly in their
community forum), so nothing here is a documented contract. Ranked by how much to trust it, per this
project's own evidence hierarchy:

1. **This repository's code and tests** — what's actually running.
2. Jottacloud's own official documentation — silent on this entirely.
3. Behavior reproduced against a real Jottacloud account — **not done in this change**.
4. **rclone's current source** (`backend/jottacloud/{jottacloud.go,api/types.go}`) — what everything
   below is checked against. Endpoints, request/response field names, and constants are quoted
   verbatim from that source, fetched fresh rather than recalled from training data, since this
   protocol is unstable-by-nature and could have changed.
5. Duplicati / JAFS and older forum posts — not consulted; rclone alone already gave a precise,
   internally-consistent picture.

### Verified against rclone's source (not against a live account)

| Fact | Source |
| --- | --- |
| Personal login token is a base64url JSON blob `{username, realm, well_known_link, auth_token}` | `api.LoginToken` |
| Token exchange: `POST <wellKnown.token_endpoint>`, form-encoded, `client_id=jottacli&grant_type=password&password=<auth_token>&scope=openid+offline_access&username=<username>` | `doTokenAuth` |
| Refresh: same endpoint, `grant_type=refresh_token` (lowercase — the uppercase rewrite in rclone is a *legacy*-API-only quirk this gatekeeper does not implement) | `jottacloud.go` |
| Metadata: `GET https://jfs.jottacloud.com/jfs/<username>/<device>/<mountpoint>/<path>`, XML body | `JottaFile` struct, `fileEndpoint` |
| Content: same URL + `?mode=bin`, `Range` header for partial reads | `jottacloud.go` |
| Upload: `POST https://api.jottacloud.com/files/v1/allocate` with `{path: "/jfs/<device>/<mountpoint>/<path>" (no username), bytes, md5, created, modified}`, then `POST` the bytes to the returned `upload_url` | `AllocateFileRequest`/`AllocateFileResponse` |
| Folder listing: same `GET` as file metadata, pointed at a directory — returns a `<folder>`/`<mountPoint>` root with one level of `<folders>/<files>` children instead of a `<file>` root | `Fs.List`, `api.JottaFolder` |
| Device/mountpoint listing: `GET https://jfs.jottacloud.com/jfs/<username>` returns `<devices>`; the same on `.../<username>/<device>` returns `<mountPoints>` — both element-form fields (`<name>`), unlike folder/file's attribute-form `name="..."` | `getDriveInfo`, `api.DriveInfo`/`JottaDevice`/`JottaMountPoint` |
| Retryable statuses: 429, 500, 502, 503, 504, 509 | `retryErrorCodes` |
| XML timestamp format `2006-01-02-T15:04:05Z0700` (RFC3339 with an extra hyphen, no colon in the offset) | `JottaTime`/`jottaTimeFormat` |
| Jottacloud's storage platform is white-labelled by resellers (MediaMarkt Cloud, Elkjøp, Elgiganten, Gigantti, ELKO, Tele2, Telia, Onlime, Phonero, Let's Go Cloud) with their own OAuth/OIDC domain per reseller, but every one of them — including rclone's *own* config paths for each — talks to the same `jfs.jottacloud.com`/`api.jottacloud.com` for file operations; only the login/auth domain differs | `getServices()`, and every `jfsSrv := ...SetRoot(jfsURL)` call site in `jottacloud.go` uses the one hardcoded `jfsURL`/`apiURL` regardless of which reseller was selected |
| The personal-login-token flow (`case "standard"`) never hardcodes a login domain: it fetches `loginToken.WellKnownLink` — a field embedded in the token itself — so it is inherently reseller-agnostic, unlike the interactive `"traditional"` OAuth flow (which needs the reseller picked *before* a token exists, precisely to know which realm to redirect to) | `jottacloud.go`'s `case "standard_token"` (`RootURL: loginToken.WellKnownLink`) vs. `case "traditional"`/`getServices()` |

### Assumptions this code does **not** treat as guarantees

- **Endpoint stability.** All of it is isolated behind `JottacloudBackend` (`src/jottacloud/client.ts`)
  so the protocol layer is replaceable without touching the Gatekeeper/session layer.
- **Continued tolerance of third-party clients.** Same isolation applies.
- **Path as identity.** A file is addressed by `{device, mountpoint, path}` (see `resource.ts`), not
  an immutable ID — Jottacloud does not appear to expose one for arbitrary files.
- **Atomic conditional writes.** Not assumed. `write()` implements *optimistic* concurrency instead
  (see [Concurrency](#concurrency-readme-13)) with a documented race window.
- **Revision restore via this same API.** Not implemented (see [What's not done](#whats-not-done)).
- **Refresh tokens don't expire.** rclone's `TokenJSON.RefreshExpiresIn` field implies they do; a
  dead refresh token surfaces as `AUTH_EXPIRED` → `credentialsExpired()`, prompting a reconnect (a
  fresh personal login token), not a crash.

## Design decisions

- **Two resources, not one: a file and a folder.** `JOTTACLOUD_FILE_RESOURCE` binds one file, exactly
  as before; `JOTTACLOUD_FOLDER_RESOURCE` binds one folder and grants `list()`/`getMetadata()`/
  `read()`/`write()` for every file under it (`JottacloudFolderSession`, `src/types.d.ts`) — deliberately
  the wider of the two options considered (a narrower list-only or list+read-only folder grant was
  also on the table). `getGatekeeperClassFor()` parses the resource URL once per binding either way;
  the file session still takes no path argument at all (never retargetable), while the folder
  session's every method takes a path *relative to the bound folder*, validated by
  `resolveWithinFolder()` (`resource.ts`) so it can never address anything outside that folder — the
  same segment defenses `normalizeFilePath`/`normalizeFolderPath` already apply to a human-typed
  path, applied here to a caller-supplied one instead.
- **The folder resource is its own DO class and resource URL prefix, not a widened file resource.**
  Modeled after `gatekeeper-google`'s `GoogleDriveGatekeeperImpl` (one DO class serving `driveAccount`/
  `sharedDrive`/`driveFile` via a `DriveBindingScope` discriminator) as a reference for the *session
  API shape* — `getScope()`, entries with a relative path standing in for Drive's stable IDs (JFS
  has none — see "Path as identity" above), and syntactic containment validation in place of
  Google's live-lookup-based one (a JFS path's ancestry is visible in the string itself; a Drive ID's
  isn't). It deliberately does **not** follow Google's *DO structure*: merging the file and folder
  bindings into one shared DO class would have meant reshaping the already-live, already-connected
  file binding's internals for a resource type nobody had asked for yet. `JOTTACLOUD_FOLDER_RESOURCE`
  uses a synthetic `jfs-folder` URL prefix rather than the real `jfs` one for the same reason JFS
  gives file and folder paths the identical shape: `getGatekeeperClassFor` needs to route to the
  right DO class from the URL string alone, with no live lookup.
- **Folder listing is one level per call, not recursive.** `list(path?)` returns just `path`'s
  immediate children; the agent walks a subtree itself by calling `list()` again with a returned
  folder entry's `path` — the same shape the resource configurator's own folder browsing already
  uses (`jfs.ts`'s `listFolder`), and simpler than Jottacloud's `mode=liststream` recursive endpoint
  (not implemented; would need a streaming XML parser this gatekeeper doesn't have reason to build
  yet, given personal-account folder sizes).
- **A folder write can create a new file.** Unlike the file resource (always an existing, pre-chosen
  path), `write(path, …)` on a folder session allocates+uploads whether or not `path` already exists
  — Jottacloud's allocate endpoint already works either way, so this needed no new code, just not
  rejecting the case.
- **Auth is a pasted personal login token, not an OAuth redirect.** Jottacloud has no authorize-page
  redirect flow for this; the human copies a one-time token from the Jottacloud web UI into a form
  this Worker serves (mirrors `gatekeeper-homeassistant`'s long-lived-token paste flow), and the
  exchange for an access/refresh token pair happens server-side in that POST handler. The token
  itself is never stored — only the resulting access/refresh tokens are, inside the `UserAccount`
  Durable Object, and the agent never sees any of it (design goal in the original brief: credentials
  live entirely inside the Gatekeeper).
- **Version safety (README.md §14 in the design doc this was built from).** `write()` always uploads
  a new revision to the existing path (allocate + upload); nothing ever deletes-then-recreates, so
  Jottacloud's own revision history stays intact as a manual recovery path.
- **Observer strategy A (private-only).** A bound file is one person's private cloud storage and
  Jottacloud gives no per-observer ACL oracle to check a second account against, so
  `addObserver()` always throws (matches the Gmail-mailbox precedent in `gatekeeper-google`).
- **No white-label reseller picker.** Jottacloud's platform is white-labelled (MediaMarkt Cloud,
  Elkjøp, Telia, and others — see the Evidence table), and rclone's *interactive* OAuth config flow
  does ask which one up front, since it needs to know where to redirect before a token exists. This
  gatekeeper's connect flow doesn't need that: the personal login token a human pastes already
  embeds its issuer's own OIDC well-known link (`decodeLoginToken`/`fetchWellKnown` never assume
  `jottacloud.com`), and every reseller's file operations hit the same `jfs.jottacloud.com`/
  `api.jottacloud.com`. So a reseller's own account works today with zero code changes — the connect
  page just links out to that fact so a MediaMarkt/Elkjøp/Telia user knows to generate their token
  from their own provider's settings page, not jottacloud.com.

### Concurrency (README.md §13)

```
read() / getMetadata()  →  note the md5
   ...time passes, maybe another writer changes the file...
write(newContent, ifMatchMd5: thatMd5)
```

`write()` doesn't upload immediately — like every gatekeeper action, it goes through
`submitAction()`/`applyAction()` (see the write-gatekeeper skill). The re-check against Jottacloud's
*current* metadata happens in `applyAction()` (extracted as the standalone `applyPendingWrite()` for
direct unit coverage), not at submission time, because more time can pass between submit and
approval than between read and submit. A mismatch throws `FILE_CHANGED` instead of overwriting.
Remaining race window: the gap between that check and the upload itself is not atomic (Jottacloud
gives no compare-and-swap primitive we've found), so a change landing in that narrow window would
still be silently overwritten. Documented, not solved — see
[Assumptions](#assumptions-this-code-does-not-treat-as-guarantees).

### Caching and simulation (`src/cache.ts`)

Per the write-gatekeeper skill's Phase 2 guidance, approach 1 ("mutate the cache on submit; on
`rejectAction()`, invalidate or rebuild it"):

- **Caching.** `getMetadata()` and `read()` each check a 30-second TTL cache in the gatekeeper's own
  Durable Object storage before calling Jottacloud, so an agent that reads the same file repeatedly
  within a short window doesn't pay a round trip (or an account-DO call for the access token) each
  time. Content above ~1 MB is not cached (still returned to the caller — see the Durable Object
  storage size caveat below) to keep the binding's own storage bounded.
- **Simulation.** `write()` computes the metadata the file will have once the upload lands — we
  already have the content and its MD5 locally, no Jottacloud call needed — and stores it as the
  *simulated* state. While a write is pending, `getMetadata()`/`read()` return that simulated
  state/content directly rather than the last-confirmed one, so the agent sees its own not-yet-
  approved write immediately and can keep working without waiting on human review.
  `applyAction()` promotes the simulated state into the real cache (from Jottacloud's confirmed
  response) and drops the overlay; `rejectAction()` just drops the overlay, since nothing was ever
  sent to Jottacloud and the last-confirmed cache is still accurate.
- **Gap, documented rather than hidden**: only the single most recently submitted pending write is
  tracked as "simulated." Multiple concurrent pending writes on one file are rare for a personal
  single-file binding, but if they happen, resolving an older one that isn't the latest leaves the
  newer one's simulated view untouched (correct), while its own resolution is what finally clears the
  overlay.
- **Not implemented for the folder resource.** `JottacloudFolderSessionImpl` submits a write for
  approval the same way, but does not cache `list()`/`getMetadata()`/`read()`, and does not simulate
  a pending write's effect: until `applyAction()` actually runs, reading the same path back reflects
  Jottacloud's previous content, not the pending one. A single fixed cache/simulation slot (as the
  file resource uses) doesn't generalize to "many files, one of which might have a pending write" —
  it would need a cache/simulation entry keyed per relative path instead. Deliberately deferred
  rather than done partially; see [What's not done](#whats-not-done).

## Package layout

```
src/
  jottacloud/           # Direct Jottacloud protocol client — the JottacloudBackend abstraction
    auth.ts             # Personal-login-token exchange + refresh
    jfs.ts               # Metadata (XML) + content download + device/mountpoint/folder listing
    upload.ts            # Allocate + upload
    retry.ts             # 429/5xx backoff
    md5.ts                # MD5 (Jottacloud's own hash; not in Web Crypto, uses node:crypto)
    client.ts             # DirectJottacloudBackend, wiring the above together (incl. list())
    errors.ts             # Stable JottacloudErrorCode taxonomy (README.md §15)
    types.ts
  resource.ts            # URL schemes (file + folder), path validation/traversal/containment, SupportedResources
  cache.ts               # Metadata/content caching + write simulation (Phase 2) — file resource only
  configurator/           # Live device/mountpoint/file/folder Autocomplete, backed by jfs.ts's listing calls
  types.d.ts              # Agent-facing JottacloudFileSession + JottacloudFolderSession APIs
  jottacloud.ts            # The Worker: Vendor, UserAccount, GatekeeperUser/Impl, both SessionImpls
__tests__/                 # See "Test coverage" below
```

## Test coverage

`pnpm test:run` (177 tests as of this writing). What's covered vs. not:

- **Protocol shapes** (`jottacloud-auth`, `-jfs`, `-upload`, `-retry`, `-errors`, `-md5`,
  `-client` test files): every request built against rclone's verified shapes, XML parsing, retry/
  backoff, and error-code mapping, all against a mocked `fetch` — no live Jottacloud calls.
- **Security (README.md §12 table)**, in `resource.test.ts` and `folder-session.test.ts`:

  | Test | File resource | Folder resource |
  | --- | --- | --- |
  | `../` traversal in a form-entered/agent-supplied path | DENY (`normalizeFilePath`) | DENY (`normalizeFolderPath` at connect time; `resolveWithinFolder` on every session call) |
  | `../` inside a resource URL | DENY (the WHATWG URL parser collapses it; still rejected on segment count) | Same, via `parseFolderResourceUrl` |
  | Resource substitution | Structurally impossible — no session method takes a path | Not structurally impossible — `list()`/`getMetadata()`/`read()`/`write()` all take a path, so this is instead a **live validation** guarantee: `resolveWithinFolder` rejects any path that would resolve outside the bound folder, tested directly in `folder-session.test.ts` |
  | Different file / cross-resource | Structurally impossible — one DO instance per binding | Same — one DO instance per *folder* binding; substitution within that folder is the "resource substitution" row above, not this one |
  | Wrong host in a resource URL | DENY | DENY (`parseFolderResourceUrl`) |
  | Expired token → `AUTH_EXPIRED`, missing credentials → `AUTH_REQUIRED` | Covered in `jottacloud-auth.test.ts` / `session-security.test.ts` | Covered in `folder-session.test.ts` |

- **Concurrency** (`session-security.test.ts`): `applyPendingWrite` applies on a matching MD5, throws
  `FILE_CHANGED` and skips the upload on a stale one, and writes unconditionally with no
  `ifMatchMd5`. Generic over `JottaFilePath`, so this same coverage already applies to a folder
  write's target file — no separate test needed for that part.
- **Caching and simulation** (`cache.test.ts`, `session-security.test.ts`, file resource only): TTL
  expiry (exact boundary and past it) for both metadata and content, the content-cache size cap, a
  metadata cache revealing a changed MD5 correctly invalidating a still-fresh content cache, a
  pending write's simulated state serving `getMetadata()`/`read()` without touching the backend,
  `clearSimulatedWriteIfLatest`'s "only the latest" semantics, and a full write→simulate→apply→
  promote-to-cache→clear-simulation lifecycle test that exercises the same sequence
  `JottacloudGatekeeperImpl.applyAction()` runs (see the note below on why that DO method itself
  isn't directly unit-tested).
- **Folder session** (`folder-session.test.ts`): `getScope()`; `list()` against the bound folder's own
  root and a subfolder, mapping folders/files and dropping deleted entries; `getMetadata()`/`read()`/
  `write()` resolving a relative path, rejecting an empty one (the folder itself isn't a file), and
  rejecting traversal before ever calling the backend; a write's pending-approval bookkeeping
  (queued, keyed to the resolved file, cleaned up on rejection, increasing action IDs).
- **Folder configurator** (`configurator-browse.test.ts`, `configurator-folder-url.test.ts`):
  `browseFolders` excludes files and injects the "use this folder" pseudo-entry (including the
  `"."` root sentinel — see `jottacloud.ts`'s `browseFolders` doc comment); resource-URL round-trip
  against `resource.ts`; `isReady` accepting an explicit empty selection (the mountpoint root) while
  still requiring *some* selection; the Advanced-disclosure toggle.
- **Not covered**: anything requiring a live Jottacloud account, or the DO-level `ctx.exports`
  machinery (`UserAccount`/`JottacloudGatekeeperImpl`/`JottacloudFolderGatekeeperImpl` are exercised
  through the pure functions/session classes they delegate to, not through Durable Object
  storage/facet plumbing — see [What's not done](#whats-not-done)).

## Decision gates

Using this project's own gating discipline — do not claim a gate passed without actually exercising it:

| Gate | Status |
| --- | --- |
| 1. Authentication (personal login token → OAuth access token) | **Verified live** — connected a real Jottacloud account through the deployed Worker |
| 2. Read (Worker → metadata + content) | **Verified live** — a real session read a chosen file's metadata/content |
| 3. Write (allocate → upload → verify) | **Verified live** — a real session uploaded a new revision through the deployed Worker |
| 4. Version safety (no delete+recreate) | Implemented by construction (write always allocates+uploads to the existing path); consistent with the live write above |
| 5. Cloudflare OS integration (agent uses the normal session interface) | **Verified live** — the resource configurator (device/mountpoint/file Autocomplete) was opened and used in the deployed Workshop UI; a real session connection and read followed |
| 6. Security (cross-resource denial) | Unit-tested (see above); no live/adversarial test against a running deployment |

These gates were walked for the **file** resource. The **folder** resource added afterward reuses the
same protocol layer (Gates 1 and 4 carry over by construction) but has not itself had Gates 2, 3, or
5 exercised live — see [What's not done](#whats-not-done).

## What's not done

- **Live verification of the folder resource.** Connect, list, read, and write have not been
  exercised against a real account through a deployed Worker the way the file resource's have (see
  [Decision gates](#decision-gates)) — only unit-tested with a mocked `fetch`.
- **Live/adversarial check of Gate 6 (cross-resource denial).** Connect, read, write, and the resource
  configurator have all been verified against a real account (see [Decision gates](#decision-gates));
  security has only been unit-tested, not exercised against a running deployment.
- **Caching and simulation for the folder resource.** Implemented for the file resource only — see
  ["Caching and simulation"](#caching-and-simulation-srccachets)'s note on why a single fixed
  cache/simulation slot doesn't generalize to a folder's many files without a per-path key, which
  hasn't been built yet.
- **Revision restore.** Jottacloud supports revisions, but we have no verified direct-API path to
  restore one, so it isn't exposed.
- **Local-sync-folder fallback** (`Cloudflare Tunnel → local jotta-cli sync folder`), for if direct
  access ever stops working. Not built; the `JottacloudBackend` interface exists specifically so a
  `LocalSyncFolderBackend` could be swapped in later without changing `jottacloud.ts`.
- **Richer observer strategies.** Strategy A (private-only) is implemented and is the correct choice
  given Jottacloud provides no per-observer ACL oracle for a personal file — but if that ever changes
  (e.g. a verified Jottacloud sharing API), strategy B (single-unit ACL check) would let a bound file
  be shared with someone who can independently prove they can read it.
- **Configurator UI browsing is one level deep per keystroke**, not a persistent tree view, in both
  the file and folder configurators: the Autocomplete widget the sandbox runtime provides commits a
  value only on selection, so on the file configurator picking a folder re-fills the input with a
  trailing slash and the human must type at least one more character to see inside it again — there
  is no click-to-expand affordance. The folder configurator sidesteps the trailing-slash mechanic
  (every listed folder is directly selectable — see `jottacloud.ts`'s `browseFolders` doc comment)
  but shares the same underlying constraint: descending into a folder to consider one of its own
  subfolders still means typing another character to reopen the list, not a click. Device is tucked
  behind a collapsed "Advanced" toggle on both configurators and defaults to `Jotta` — it's invisible
  in Jottacloud's own apps and virtually every account only has the one. Mountpoint stays visible (it
  does show up as a top-level folder name in Jottacloud's own web UI) and defaults to `Sync`, matching
  where this deployment's real files actually live — `jottacloud/jfs.ts`'s `DEFAULT_MOUNTPOINT` doc
  comment has the reasoning.
- **DO-level integration tests.** `UserAccount`, `JottacloudGatekeeperImpl`, and
  `JottacloudFolderGatekeeperImpl`'s own Durable Object methods aren't exercised end-to-end through
  `ctx.exports`/miniflare; the logic they call (`applyPendingWrite`, the auth/jfs/upload modules,
  `JottacloudFileSessionImpl`/`JottacloudFolderSessionImpl`) is unit-tested directly instead. A
  `__tests__/workerd/*.test.ts` suite exercising the real DOs (see `gatekeeper-google`'s for the
  pattern) is the natural next step once a real account is available to test the connect flow
  against.
