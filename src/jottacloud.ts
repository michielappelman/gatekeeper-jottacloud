import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  stripTrailingSlashes,
  type AccountDescription,
  type ApprovalQueue,
  type ConnectHandoff,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  connectHandoffPageHtml,
  errorPageHtml,
  escapeHtml,
  htmlResponse,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import {
  CredentialCoordinator,
  CredentialsExpiredError,
} from "@gadgets/gatekeeper-kit/credentials";
import { notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import {
  constantTimeEqual,
  CONNECT_TIMEOUT_MS,
  generateNonce,
  INITIATION_NONCE_LIFETIME_MS,
  isLiveNonce,
  NONCE_BYTES,
  type TimedNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  clearSimulatedWriteIfLatest,
  getCachedContent,
  getCachedMarkdown,
  getCachedMetadata,
  getSimulatedWrite,
  putCachedContent,
  putCachedMarkdown,
  putCachedMetadata,
  setSimulatedWrite,
  simulateWriteMetadata,
} from "./cache";
import { decodeLoginToken, exchangeLoginToken, refreshAccessToken } from "./jottacloud/auth";
import { DirectJottacloudBackend, JottacloudError, type JottacloudBackend } from "./jottacloud/client";
import { assertMarkdownConvertible, convertToMarkdown } from "./markdown";
import {
  DEFAULT_DEVICE,
  listDevices as fetchJottaDevices,
  listFolder as fetchJottaFolder,
  listMountpoints as fetchJottaMountpoints,
  type FolderListEntry,
  type JottaDeviceEntry,
  type JottaMountpointEntry,
} from "./jottacloud/jfs";
import { md5Hex } from "./jottacloud/md5";
import type { FileMetadata, JottaFilePath } from "./jottacloud/types";
import {
  isFolderResourceUrl,
  JOTTACLOUD_FILE_RESOURCE,
  JOTTACLOUD_FOLDER_RESOURCE,
  normalizeFolderPath,
  parseFolderResourceUrl,
  parseResourceUrl,
  resolveWithinFolder,
  SUPPORTED_RESOURCES,
  toFolderResourceUrl,
  toResourceUrl,
} from "./resource";
import type {
  JottacloudConfiguratorRpc,
  JottacloudNode,
  JottacloudNodeAncestor,
  JottacloudNodePage,
} from "./configurator/jottacloud-configurator-types";
import type {
  JottacloudFileMetadata,
  JottacloudFileSession,
  JottacloudFolderEntry,
  JottacloudFolderScope,
  JottacloudFolderSession,
  JottacloudMarkdownContent,
} from "./types";
import TYPES_CODE from "./types.txt";
import JOTTACLOUD_CONFIGURATOR_HTML from "./generated/jottacloud-configurator-ui.txt";

type Env = Cloudflare.Env & {
  BASE_URL?: string;
};

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/jottacloud");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// Jottacloud brand mark (simplified cloud glyph), inlined so the gatekeeper needs no hosted asset.
const JOTTACLOUD_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\
<path d="M6.5 19a4.5 4.5 0 0 1-.4-8.98A6 6 0 0 1 17.6 8.06 4.5 4.5 0 0 1 17 19H6.5z" fill="#1a86c7"/>\
</svg>`;
const JOTTACLOUD_LOGO_URL = `data:image/svg+xml;utf8,${encodeURIComponent(JOTTACLOUD_LOGO_SVG)}`;

function errorMessage(error: unknown): string {
  if (error instanceof JottacloudError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// HTML for the connect flow. The human copies a one-time personal login token out of the
// Jottacloud web UI and pastes it here; the whole exchange happens server-side in this POST handler.

const CONNECT_FORM_HTML = (params: { actionUrl: string; error?: string }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect Jottacloud</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; margin: 0; min-height: 100vh; display: flex; justify-content: center; align-items: center; }
  .card { background: white; padding: 2rem; max-width: 540px; width: 100%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  h1 { margin-top: 0; font-size: 1.4rem; color: #1a86c7; }
  label { display: block; font-weight: 600; margin-top: 1rem; margin-bottom: 0.25rem; color: #333; }
  textarea { width: 100%; box-sizing: border-box; padding: 0.5rem; font-size: 0.85rem; border: 1px solid #ccc; border-radius: 4px; font-family: ui-monospace, monospace; resize: vertical; }
  details { margin-top: 1rem; font-size: 0.9rem; color: #555; }
  summary { cursor: pointer; color: #1a86c7; }
  details ol { padding-left: 1.25rem; }
  button { margin-top: 1.5rem; padding: 0.6rem 1.5rem; background: #1a86c7; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #156ba1; }
  .error { background: #ffebee; color: #c62828; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; }
  .hint { font-size: 0.85rem; color: #666; margin-top: 0.25rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect Jottacloud</h1>
    <p>Paste a Jottacloud personal login token. Cloudflare OS uses it once, to obtain its own access token — it never stores or exposes the login token itself.</p>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="${escapeHtml(params.actionUrl)}">
      <label for="loginToken">Personal login token</label>
      <textarea id="loginToken" name="loginToken" rows="4" required placeholder="eyJ1c2VybmFtZSI6Li4u" autofocus></textarea>

      <details>
        <summary>How to create a personal login token</summary>
        <ol>
          <li>Open <a href="https://www.jottacloud.com/web/secure" target="_blank" rel="noopener">jottacloud.com</a> and sign in.</li>
          <li>Go to your account security settings.</li>
          <li>Generate a personal login token for a new device/app.</li>
          <li>Copy the token and paste it above. It is only usable once.</li>
        </ol>
      </details>

      <details>
        <summary>Using MediaMarkt Cloud, Elkjøp, Telia, or another white-label version?</summary>
        <p class="hint">Jottacloud's storage platform is white-labelled by several resellers
          (MediaMarkt Cloud, Elkjøp Cloud, Elgiganten Cloud, Gigantti Cloud, ELKO Cloud, Tele2
          Cloud, Telia Sky/Cloud, Onlime, Phonero Sky, Let's Go Cloud, and others). This
          connection works the same way for all of them — generate your personal login token from
          your own provider's account settings page instead of jottacloud.com, then paste it above.</p>
      </details>

      <button type="submit">Connect</button>
    </form>
  </div>
</body>
</html>`;

// ---------------------------------------------------------------------------
// fetch handler: serves the connect form and accepts its POST

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Connect URL: /<doId>/<nonce>
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      const doId = path[0];
      const nonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));

      if (req.method === "GET") {
        const valid = await stub.verifyNonceWithoutConsuming(nonce);
        if (!valid) return htmlResponse(errorPageHtml("Link expired", "Start the connection again."));
        return htmlResponse(CONNECT_FORM_HTML({ actionUrl: req.url }));
      }

      if (req.method === "POST") {
        let formData: FormData;
        try {
          formData = await req.formData();
        } catch {
          return new Response("Invalid form submission.", { status: 400 });
        }
        const loginToken = String(formData.get("loginToken") ?? "").trim();
        if (!loginToken) {
          return htmlResponse(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: "A personal login token is required." }), 400);
        }

        const result = await stub.completeConnection(nonce, loginToken);
        if (result.kind === "invalid_nonce") {
          return htmlResponse(errorPageHtml("Link expired", "Start the connection again."));
        }
        if (result.kind === "error") {
          return htmlResponse(CONNECT_FORM_HTML({ actionUrl: req.url, error: result.message }), 400);
        }
        return htmlResponse(connectHandoffPageHtml(result.handoff));
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Jottacloud",
      url: "https://www.jottacloud.com",
      logo: { url: JOTTACLOUD_LOGO_URL },
      color: "#eaf5fc",
      tagline: "Read and update one file you choose in Jottacloud",
      description:
          "Connect a Jottacloud personal login token so Cloudflare OS can read, update, and read " +
          "metadata for a single file you choose — never your whole Jottacloud account. Every " +
          "update uploads a new revision, so Jottacloud's own version history stays intact. Also " +
          "works with Jottacloud's white-label resellers (MediaMarkt Cloud, Elkjøp, Telia, and others).",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, nonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — stores the OAuth-style access/refresh token pair obtained from the personal
// login token, and refreshes it as needed.

type StoredGrant = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  tokenEndpoint: string;
  username: string;
};

type StoredNonce = TimedNonce & {
  reconnect?: true;
  /** Set while a submission is being validated against Jottacloud, so a concurrent submission
   * cannot pass the same nonce; cleared again when validation fails so the user can resubmit. */
  connecting?: true;
};

type CompleteConnectionResult =
  | { kind: "ok"; handoff: ConnectHandoff }
  | { kind: "invalid_nonce" }
  | { kind: "error"; message: string };

export class UserAccount extends DurableObject<Env> {
  #credentials = new CredentialCoordinator<StoredGrant>(this.ctx.storage.kv, {
    expiresAt: grant => grant.accessTokenExpiresAt,
    legacyKeys: ["grant"],
    upgrade: kv => kv.get<StoredGrant>("grant"),
    vendorId: "jottacloud",
  });

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    if (!this.#credentials.stored()) {
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
    });
  }

  async prepareReconnect(nonce: string): Promise<void> {
    this.ctx.storage.kv.put("expiredNotified", false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      reconnect: true,
    });
  }

  /** Validates the nonce without consuming it, for the GET preview of the form. */
  async verifyNonceWithoutConsuming(nonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    return !stored?.connecting && isLiveNonce(stored, nonce, Date.now());
  }

  #releaseNonceClaim(nonce: string): void {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (stored && constantTimeEqual(stored.value, nonce)) {
      this.ctx.storage.kv.put<StoredNonce>("nonce", { ...stored, connecting: undefined });
    }
  }

  async completeConnection(nonce: string, loginTokenBase64: string): Promise<CompleteConnectionResult> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.connecting || !isLiveNonce(stored, nonce, Date.now())) {
      return { kind: "invalid_nonce" };
    }
    // Claim the nonce before the first await: the input gate does not cover the outbound exchange,
    // so a second submission arriving meanwhile would otherwise validate the same nonce twice.
    this.ctx.storage.kv.put<StoredNonce>("nonce", { ...stored, connecting: true });

    let grant: StoredGrant;
    try {
      const loginToken = decodeLoginToken(loginTokenBase64);
      const exchanged = await exchangeLoginToken(loginToken);
      grant = {
        accessToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken,
        accessTokenExpiresAt: Date.now() + exchanged.expiresInMs,
        tokenEndpoint: exchanged.tokenEndpoint,
        username: loginToken.username,
      };
    } catch (error) {
      this.#releaseNonceClaim(nonce);
      return { kind: "error", message: errorMessage(error) };
    }

    this.ctx.storage.kv.delete("nonce");
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      return { kind: "error", message: "Took too long to complete authorization. Please try again." };
    }

    let handoff: ConnectHandoff;
    if (stored.reconnect) {
      // The reconnect URL is a bearer capability, so the new grant is only staged until the
      // Workshop confirms the browser that finished the flow is the owner's.
      const stageId = stageCredentials(this.ctx.storage.kv, grant, Date.now());
      handoff = await callback.reconnectComplete(stageId);
    } else {
      this.#writeGrant(grant);
      try {
        const props: JottacloudGatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.JottacloudGatekeeperUserImpl({ props }));
      } catch (err) {
        this.ctx.storage.kv.delete("grant");
        throw err;
      }
    }
    await this.ctx.storage.deleteAlarm();
    return { kind: "ok", handoff };
  }

  /** Makes the grant staged under `stageId` by a reconnect flow live. */
  async commitReconnect(stageId: string): Promise<void> {
    const grant = commitStagedCredentials<StoredGrant>(this.ctx.storage.kv, Date.now(), stageId);
    if (!grant) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    this.#writeGrant(grant);
  }

  #writeGrant(grant: StoredGrant): void {
    this.#credentials.connect(grant);
  }

  async getIdentity(): Promise<{ username: string } | undefined> {
    const grant = this.#credentials.stored();
    return grant ? { username: grant.username } : undefined;
  }

  async getUsername(): Promise<string> {
    const grant = this.#credentials.stored();
    if (!grant) throw new JottacloudError("AUTH_REQUIRED", "Jottacloud is not connected.");
    return grant.username;
  }

  async getAccessToken(): Promise<string> {
    if (!this.#credentials.stored()) {
      throw new JottacloudError("AUTH_REQUIRED", "Jottacloud is not connected.");
    }
    const { creds } = await this.#credentials.snapshot(async grant => {
      try {
        const refreshed = await refreshAccessToken(grant.tokenEndpoint, grant.refreshToken);
        return {
          ...grant,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          accessTokenExpiresAt: Date.now() + refreshed.expiresInMs,
        };
      } catch (error) {
        if (error instanceof JottacloudError && error.code === "AUTH_REQUIRED") {
          throw new CredentialsExpiredError(
            "Jottacloud's refresh token was rejected.", { cause: error });
        }
        throw error;
      }
    }, { notify: () => this.#notifyCredentialsExpired() });
    return creds.accessToken;
  }

  async #notifyCredentialsExpired(): Promise<void> {
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    await notifyCredentialsExpiredOnce(this.ctx.storage.kv, callback, "jottacloud");
  }

  async alarm(): Promise<void> {
    if (!this.#credentials.stored()) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    // Dropping local credentials prevents any further use from this Gatekeeper. The user can also
    // revoke the device from Jottacloud's own device/session list.
    this.#credentials.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// GatekeeperUserImpl — maps a bound resource URL to a JottacloudGatekeeperImpl DO

type JottacloudGatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class JottacloudGatekeeperUserImpl extends WorkerEntrypoint<Env, JottacloudGatekeeperUserImplProps>
    implements GatekeeperUser {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<AccountDescription> {
    const identity = await this.#userAccount().getIdentity();
    return {
      displayName: identity?.username ?? "Jottacloud Account",
      uniqueName: identity?.username,
      avatar: { url: JOTTACLOUD_LOGO_URL },
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const userObjectId = this.ctx.props.userObjectId;
    if (isFolderResourceUrl(url)) {
      const folder = parseFolderResourceUrl(url);
      const props: JottacloudFolderGatekeeperImplProps = { userObjectId, ...folder };
      return {
        class: this.ctx.exports.JottacloudFolderGatekeeperImpl({ props }),
        resource: JOTTACLOUD_FOLDER_RESOURCE,
      };
    }
    const file = parseResourceUrl(url);
    const props: JottacloudGatekeeperImplProps = { userObjectId, ...file };
    return { class: this.ctx.exports.JottacloudGatekeeperImpl({ props }), resource: JOTTACLOUD_FILE_RESOURCE };
  }

  /** One picker for the folder card, which the file type is grouped under. */
  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== JOTTACLOUD_FOLDER_RESOURCE.urlPattern &&
        resourceUrlPattern !== JOTTACLOUD_FILE_RESOURCE.urlPattern) {
      throw new Error(`Unsupported Jottacloud resource configurator type: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: JOTTACLOUD_CONFIGURATOR_HTML,
      ui: new RpcStub(new JottacloudConfiguratorUI(this.#userAccount())),
    };
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const nonce = generateNonce();
    await this.#userAccount().prepareReconnect(nonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#userAccount().commitReconnect(stageId);
  }

  /** Jottacloud is not offered as a sign-in identity provider. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** A personal login token already grants full account authority; there is no narrower OAuth
   * scope to request per resource type, so there is nothing to expand here. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** The verifier is not used for this private-only account connection, but the overseer still
   * expects one when opening a collaborator context. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.JottacloudVerifier({});
  }
}

@validateRpc()
export class JottacloudVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Resource configurator — the picker's live device/mountpoint/folder listing for the sandboxed
// iframe, backed directly by JFS (bypassing `JottacloudBackend`: this is a connect-time UI
// convenience, not part of the swappable session-backend contract those methods exist for).

const ROOT_NODE_ID = "jottacloud";
const DEVICES_NODE_ID = "devices";
const DEVICE_NODE_PREFIX = "device:";
const NODE_PAGE_SIZE = 100;

/**
 * Devices other than the default one. Nobody sees "device" in Jottacloud's own apps, which always
 * use the built-in "Jotta" device, so its mountpoints are the top level and any others (separately
 * registered desktop or backup clients) wait one level down.
 */
const DEVICES_GROUP: JottacloudNodeAncestor = { id: DEVICES_NODE_ID, title: "Other devices", kind: "group" };

const deviceNodeId = (device: string) => DEVICE_NODE_PREFIX + encodeURIComponent(device);

/** The grouping and device above a device's mountpoints, or nothing for the default device's. */
function deviceTrail(device: string): JottacloudNodeAncestor[] {
  return device === DEFAULT_DEVICE ? [] : [DEVICES_GROUP, { id: deviceNodeId(device), title: device, kind: "device" }];
}

/** Every ancestor of what is in `folder`, from its device down to the folder itself. */
function trailInto(folder: JottaFilePath): JottacloudNodeAncestor[] {
  const segments = folder.path ? folder.path.split("/") : [];
  return [
    ...deviceTrail(folder.device),
    { id: toFolderResourceUrl({ ...folder, path: "" }), title: folder.mountpoint, kind: "mountpoint" },
    ...segments.map((name, index): JottacloudNodeAncestor => ({
      id: toFolderResourceUrl({ ...folder, path: segments.slice(0, index + 1).join("/") }),
      title: name,
      kind: "folder",
    })),
  ];
}

/** A name a resource URL can carry: the parsers refuse an empty, ".", ".." or slashed segment. */
const isBindableName = (name: string) => name !== "" && name !== "." && name !== ".." && !name.includes("/");

function mountpointNode(device: string, mountpoint: JottaMountpointEntry): JottacloudNode {
  return {
    id: toFolderResourceUrl({ device, mountpoint: mountpoint.name, path: "" }),
    title: mountpoint.name,
    kind: "mountpoint",
    size: mountpoint.sizeBytes,
    path: deviceTrail(device),
  };
}

function entryNode(parent: JottaFilePath, entry: FolderListEntry): JottacloudNode {
  const location = { ...parent, path: parent.path ? `${parent.path}/${entry.name}` : entry.name };
  const path = trailInto(parent);
  if (entry.kind === "folder") return { id: toFolderResourceUrl(location), title: entry.name, kind: "folder", path };
  return {
    id: toResourceUrl(location),
    title: entry.name,
    kind: "file",
    size: entry.size,
    mimeType: entry.mimeType || undefined,
    modifiedTime: Number.isNaN(entry.modifiedAt.getTime()) ? undefined : entry.modifiedAt.toISOString(),
    path,
  };
}

/** The folder above `location` and the name `location` has in it. */
function splitParent(location: JottaFilePath): { parent: JottaFilePath; name: string } {
  const slash = location.path.lastIndexOf("/");
  return {
    parent: { ...location, path: slash >= 0 ? location.path.slice(0, slash) : "" },
    name: location.path.slice(slash + 1),
  };
}

const isNotFound = (error: unknown) => error instanceof JottacloudError && error.code === "RESOURCE_NOT_FOUND";
const isInvalidResource = (error: unknown) => error instanceof JottacloudError && error.code === "INVALID_RESOURCE";

@validateRpc()
export class JottacloudConfiguratorUI extends RpcTarget implements JottacloudConfiguratorRpc {
  #account: DurableObjectStub<UserAccount>;
  #fetchImpl: typeof fetch;

  constructor(account: DurableObjectStub<UserAccount>, fetchImpl: typeof fetch = fetch) {
    super();
    this.#account = account;
    this.#fetchImpl = fetchImpl;
  }

  async listNodes(parentId: string, query: string, cursor: string | null): Promise<JottacloudNodePage> {
    const trimmed = query.trim();
    // No name holds a slash, so a query with one is a path or a resource URL, not a filter.
    if (trimmed.includes("/")) {
      const node = await this.#lookUp(trimmed);
      return { nodes: node ? [node] : [] };
    }
    const needle = trimmed.toLowerCase();
    const nodes = (await this.#children(parentId))
      .filter(node => !needle || node.title.toLowerCase().includes(needle));
    // A JFS listing is never paged, so neither is the read behind it: a cursor is an offset into it.
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`Invalid cursor: ${cursor}`);
    const end = offset + NODE_PAGE_SIZE;
    return { nodes: nodes.slice(offset, end), nextCursor: end < nodes.length ? String(end) : undefined };
  }

  async getNode(id: string): Promise<JottacloudNode | null> {
    try {
      if (isFolderResourceUrl(id)) {
        const folder = parseFolderResourceUrl(id);
        return folder.path ? await this.#find(folder, "folder") : await this.#mountpoint(folder);
      }
      return await this.#find(parseResourceUrl(id), "file");
    } catch (error) {
      if (isInvalidResource(error)) return null;
      throw error;
    }
  }

  async #children(parentId: string): Promise<JottacloudNode[]> {
    if (parentId === ROOT_NODE_ID) {
      const [mountpoints, devices] = await Promise.all([this.#mountpoints(DEFAULT_DEVICE), this.#devices()]);
      const nodes = mountpoints.map(mountpoint => mountpointNode(DEFAULT_DEVICE, mountpoint));
      if (devices.some(device => device.name !== DEFAULT_DEVICE)) nodes.push({ ...DEVICES_GROUP, path: [] });
      return nodes;
    }
    if (parentId === DEVICES_NODE_ID) {
      return (await this.#devices())
        .filter(device => device.name !== DEFAULT_DEVICE)
        .map(device => ({
          id: deviceNodeId(device.name),
          title: device.displayName || device.name,
          kind: "device",
          size: device.sizeBytes,
          path: [DEVICES_GROUP],
        }));
    }
    if (parentId.startsWith(DEVICE_NODE_PREFIX)) {
      const device = decodeURIComponent(parentId.slice(DEVICE_NODE_PREFIX.length));
      return (await this.#mountpoints(device)).map(mountpoint => mountpointNode(device, mountpoint));
    }
    // Anything else must be a mountpoint's or folder's id; parsing refuses a file's or a forged one.
    const folder = parseFolderResourceUrl(parentId);
    const entries = await fetchJottaFolder(
      folder, await this.#account.getUsername(), () => this.#account.getAccessToken(), this.#fetchImpl);
    return entries
      .filter(entry => !entry.deleted && isBindableName(entry.name))
      .toSorted((a, b) => (a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name)))
      .map(entry => entryNode(folder, entry));
  }

  /** The node a pasted resource URL or `<mountpoint>/<path>` (on the default device) names. */
  async #lookUp(text: string): Promise<JottacloudNode | null> {
    try {
      if (/^https:\/\//i.test(text)) {
        const canonical = isFolderResourceUrl(text)
          ? toFolderResourceUrl(parseFolderResourceUrl(text))
          : toResourceUrl(parseResourceUrl(text));
        return await this.getNode(canonical);
      }
      const [mountpoint, ...segments] = text.split("/").filter(Boolean);
      if (!mountpoint) return null;
      const location = normalizeFolderPath(DEFAULT_DEVICE, mountpoint, segments.join("/"));
      return location.path ? await this.#find(location) : await this.#mountpoint(location);
    } catch (error) {
      if (isInvalidResource(error)) return null;
      throw error;
    }
  }

  /** The folder or file at `location`, read from its parent's listing, which says which it is. */
  async #find(location: JottaFilePath, kind?: FolderListEntry["kind"]): Promise<JottacloudNode | null> {
    const { parent, name } = splitParent(location);
    let entries: FolderListEntry[];
    try {
      entries = await fetchJottaFolder(
        parent, await this.#account.getUsername(), () => this.#account.getAccessToken(), this.#fetchImpl);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const entry = entries.find(candidate =>
      candidate.name === name && !candidate.deleted && (kind === undefined || candidate.kind === kind));
    return entry ? entryNode(parent, entry) : null;
  }

  async #mountpoint(location: JottaFilePath): Promise<JottacloudNode | null> {
    const mountpoint = (await this.#mountpoints(location.device)).find(({ name }) => name === location.mountpoint);
    return mountpoint ? mountpointNode(location.device, mountpoint) : null;
  }

  /** A device's mountpoints, bindable by name, or none for a device the account does not have. */
  async #mountpoints(device: string): Promise<JottaMountpointEntry[]> {
    try {
      const mountpoints = await fetchJottaMountpoints(
        await this.#account.getUsername(), device, () => this.#account.getAccessToken(), this.#fetchImpl);
      return mountpoints.filter(({ name }) => isBindableName(name));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async #devices(): Promise<JottaDeviceEntry[]> {
    const devices = await fetchJottaDevices(
      await this.#account.getUsername(), () => this.#account.getAccessToken(), this.#fetchImpl);
    return devices.filter(({ name }) => isBindableName(name));
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl DO — one Jottacloud file bound to one Gadget.

type JottacloudGatekeeperImplProps = JottaFilePath & {
  userObjectId: string;
};

export type PendingWrite = {
  content: ArrayBuffer;
  ifMatchMd5?: string;
};

/**
 * Applies a deferred write, re-checking `ifMatchMd5` against the file's live state (more time may
 * have passed since the write was submitted than the caller expected). Exported standalone
 * (independent of the DO's `ctx`) so this concurrency check has direct unit coverage.
 * Returns the confirmed post-write metadata, which the caller promotes into the real cache.
 */
export async function applyPendingWrite(
  backend: JottacloudBackend, username: string, file: JottaFilePath, pending: PendingWrite,
): Promise<FileMetadata> {
  if (pending.ifMatchMd5 !== undefined) {
    const current = await backend.getMetadata(username, file);
    if (current.md5 !== pending.ifMatchMd5) {
      throw new JottacloudError(
        "FILE_CHANGED",
        "The file changed in Jottacloud since this write was requested; it was not applied. " +
        "Read the file again, reconcile, and retry.");
    }
  }
  return backend.write(username, file, pending.content);
}

function toAgentMetadata(metadata: FileMetadata): JottacloudFileMetadata {
  return {
    name: metadata.name,
    size: metadata.size,
    md5: metadata.md5,
    mimeType: metadata.mimeType,
    createdAt: metadata.createdAt,
    modifiedAt: metadata.modifiedAt,
  };
}

@validateRpc()
export class JottacloudGatekeeperImpl extends DurableObject<Env, JottacloudGatekeeperImplProps>
    implements Gatekeeper<JottacloudFileSession> {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #file(): JottaFilePath {
    const { device, mountpoint, path } = this.ctx.props;
    return { device, mountpoint, path };
  }

  #backend(): DirectJottacloudBackend {
    const account = this.#userAccount();
    return new DirectJottacloudBackend(() => account.getAccessToken());
  }

  async describe(): Promise<ResourceDescription> {
    const file = this.#file();
    return {
      url: toResourceUrl(file),
      title: file.path.split("/").pop() ?? file.path,
      snippet: `Read, update, and read metadata for ${file.path} in Jottacloud (${file.device}/${file.mountpoint}).`,
      suggestedBindingName: "JOTTACLOUD_FILE",
      tsType: "JottacloudFileSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<JottacloudFileSession> {
    const account = this.#userAccount();
    return new JottacloudFileSessionImpl(
      approvalQueue.dup(), account, () => account.getUsername(), this.#backend(), this.#file(),
      this.ctx.storage.kv, this.env.WORKERS_AI);
  }

  /** Approved: perform the deferred upload, re-checking `ifMatchMd5` against the file's live state
   * (more time may have passed since submission than the caller expected), then promote the
   * confirmed result into the real cache and drop the simulation overlay it was serving from. */
  async applyAction(actionId: number): Promise<void> {
    const key = `write:pending:${actionId}`;
    const pending = this.ctx.storage.kv.get<PendingWrite>(key);
    if (!pending) throw new Error(`Unknown pending Jottacloud write: ${actionId}`);
    this.ctx.storage.kv.delete(key);

    const username = await this.#userAccount().getUsername();
    const metadata = await applyPendingWrite(this.#backend(), username, this.#file(), pending);

    const now = Date.now();
    putCachedMetadata(this.ctx.storage.kv, metadata, now);
    putCachedContent(this.ctx.storage.kv, metadata.md5, pending.content, now);
    clearSimulatedWriteIfLatest(this.ctx.storage.kv, actionId);
  }

  /** Rejected: discard the queued write and its simulated view. Nothing was ever sent to
   * Jottacloud, so the real cache (if any) is still accurate and needs no rollback of its own. */
  async rejectAction(actionId: number): Promise<void> {
    this.ctx.storage.kv.delete(`write:pending:${actionId}`);
    clearSimulatedWriteIfLatest(this.ctx.storage.kv, actionId);
  }

  async revertAction(_actionId: number): Promise<{ message: string; canRetry: boolean }> {
    return {
      message:
          "This write can't be reverted automatically. Use Jottacloud's own revision history on " +
          "this file to restore the previous version.",
      canRetry: false,
    };
  }

  /**
   * Bindings are private to the account owner. Jottacloud does not provide a verified per-observer
   * authorization check for this integration, so collaborators may not observe this binding.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "This Jottacloud file cannot be shared with other users: it may only be observed by the " +
      "person who connected it.");
  }

  async removeObserver(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// SessionImpl — the RPC interface exposed to the Gadget

@validateRpc()
export class JottacloudFileSessionImpl extends RpcTarget implements JottacloudFileSession {
  #approvalQueue: RpcStub<ApprovalQueue>;
  #getUsername: () => Promise<string>;
  #backend: DirectJottacloudBackend;
  #file: JottaFilePath;
  #kv: DurableObjectStorage["kv"];
  #ai: Ai;

  constructor(
      approvalQueue: RpcStub<ApprovalQueue>, account: DurableObjectStub<UserAccount>,
      getUsername: () => Promise<string>, backend: DirectJottacloudBackend, file: JottaFilePath,
      kv: DurableObjectStorage["kv"], ai: Ai) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#getUsername = getUsername;
    this.#backend = backend;
    this.#file = file;
    this.#kv = kv;
    this.#ai = ai;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  async #call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof JottacloudError && error.code === "AUTH_EXPIRED") {
        throw new Error(
          "Jottacloud's credentials have expired or been revoked. Please reconnect the account.",
          { cause: error });
      }
      throw error;
    }
  }

  /**
   * Prefers, in order: a not-yet-approved write's simulated result (so the caller sees its own
   * pending write immediately — write-gatekeeper skill "Simulation"), a fresh-enough cached read, or
   * else the real Jottacloud call. Observation still runs on every path, since all three reveal data
   * to the caller.
   */
  async getMetadata(): Promise<JottacloudFileMetadata> {
    const now = Date.now();
    const simulated = getSimulatedWrite(this.#kv);
    if (simulated) {
      await this.#approvalQueue.authorizeObservation({
        title: "Read Jottacloud file metadata",
        description: `Read metadata for ${this.#file.path} (reflecting an update awaiting approval).`,
      });
      return toAgentMetadata(simulated.metadata);
    }

    const cached = getCachedMetadata(this.#kv, now);
    if (cached) {
      await this.#approvalQueue.authorizeObservation({
        title: "Read Jottacloud file metadata",
        description: `Read metadata for ${this.#file.path} (cached).`,
      });
      return toAgentMetadata(cached);
    }

    const username = await this.#getUsername();
    const metadata = await this.#call(() => this.#backend.getMetadata(username, this.#file));
    putCachedMetadata(this.#kv, metadata, now);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Jottacloud file metadata",
      description: `Read metadata for ${this.#file.path}.`,
    });
    return toAgentMetadata(metadata);
  }

  async read(): Promise<ArrayBuffer> {
    const now = Date.now();
    const simulated = getSimulatedWrite(this.#kv);
    if (simulated) {
      const pending = this.#kv.get<PendingWrite>(`write:pending:${simulated.actionId}`);
      if (pending) {
        await this.#approvalQueue.authorizeObservation({
          title: "Read Jottacloud file",
          description:
              `Downloaded the content of ${this.#file.path} (${pending.content.byteLength} bytes, ` +
              `reflecting an update awaiting approval).`,
        });
        return pending.content;
      }
    }

    // A fresh content cache is trusted on its own TTL; a fresher metadata cache that disagrees on
    // MD5 means the file changed since the content was cached, so it wins and the content is
    // treated as stale even though its own TTL hasn't lapsed yet.
    const cachedMetadata = getCachedMetadata(this.#kv, now);
    const cachedContent = getCachedContent(this.#kv, now);
    if (cachedContent && (!cachedMetadata || cachedMetadata.md5 === cachedContent.md5)) {
      await this.#approvalQueue.authorizeObservation({
        title: "Read Jottacloud file",
        description: `Downloaded the content of ${this.#file.path} (${cachedContent.content.byteLength} bytes, cached).`,
      });
      return cachedContent.content;
    }

    const username = await this.#getUsername();
    const content = await this.#call(() => this.#backend.read(username, this.#file));
    putCachedContent(this.#kv, md5Hex(content), content, now);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Jottacloud file",
      description: `Downloaded the current content of ${this.#file.path} (${content.byteLength} bytes).`,
    });
    return content;
  }

  /**
   * Reuses `getMetadata()` (for `mimeType`/`size`, and its own simulation/caching/observation) and
   * `read()` (same, for content) rather than duplicating their simulated/cached/live precedence.
   * On a Markdown cache hit at the current content's MD5, `read()` is skipped entirely -- no raw
   * content is downloaded just to serve an already-converted result.
   */
  async readAsMarkdown(): Promise<JottacloudMarkdownContent> {
    const metadata = await this.getMetadata();
    assertMarkdownConvertible(metadata.mimeType, metadata.size);

    const now = Date.now();
    const cachedMarkdown = getCachedMarkdown(this.#kv, now);
    if (cachedMarkdown && cachedMarkdown.md5 === metadata.md5) {
      await this.#approvalQueue.authorizeObservation({
        title: "Read Jottacloud file as Markdown",
        description: `Converted the content of ${this.#file.path} to Markdown (cached).`,
      });
      return { markdown: cachedMarkdown.markdown, sourceMimeType: cachedMarkdown.sourceMimeType };
    }

    const content = await this.read();
    const markdown = await convertToMarkdown(this.#ai, metadata.name, metadata.mimeType, content);
    putCachedMarkdown(this.#kv, { md5: metadata.md5, markdown, sourceMimeType: metadata.mimeType }, now);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Jottacloud file as Markdown",
      description: `Converted the content of ${this.#file.path} to Markdown.`,
    });
    return { markdown, sourceMimeType: metadata.mimeType };
  }

  async write(content: ArrayBuffer, ifMatchMd5?: string): Promise<void> {
    const now = Date.now();
    const actionId = this.#kv.get<number>("write:nextId") ?? 1;
    this.#kv.put("write:nextId", actionId + 1);
    this.#kv.put<PendingWrite>(`write:pending:${actionId}`, { content, ifMatchMd5 });

    // Simulate: until approved and applied, getMetadata()/read() reflect this write directly.
    const previous = getSimulatedWrite(this.#kv)?.metadata ?? getCachedMetadata(this.#kv, now);
    const simulatedMetadata = simulateWriteMetadata(previous, this.#file, content, md5Hex(content), new Date(now));
    setSimulatedWrite(this.#kv, { actionId, metadata: simulatedMetadata });

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: "Update Jottacloud file",
        description:
            `Upload a new revision of ${this.#file.path} (${content.byteLength} bytes)` +
            (ifMatchMd5 ? `, only if it has not changed since it was last read.` : "."),
        // A successful upload is a new Jottacloud revision; reverting it isn't automatic (see
        // revertAction), so this is surfaced to the approver rather than promised as reversible.
        implementsRevert: false,
      });
    } catch (error) {
      clearSimulatedWriteIfLatest(this.#kv, actionId);
      this.#kv.delete(`write:pending:${actionId}`);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// FolderGatekeeperImpl DO — one Jottacloud folder bound to one Gadget.

type JottacloudFolderGatekeeperImplProps = JottaFilePath & {
  userObjectId: string;
};

export type PendingFolderWrite = PendingWrite & {
  /** Which file within the bound folder this write targets — the folder session's `write(path, …)`
   * takes a path per call, unlike the single-file session where it's always the one bound file. */
  file: JottaFilePath;
};

@validateRpc()
export class JottacloudFolderGatekeeperImpl extends DurableObject<Env, JottacloudFolderGatekeeperImplProps>
    implements Gatekeeper<JottacloudFolderSession> {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  #folder(): JottaFilePath {
    const { device, mountpoint, path } = this.ctx.props;
    return { device, mountpoint, path };
  }

  #backend(): DirectJottacloudBackend {
    const account = this.#userAccount();
    return new DirectJottacloudBackend(() => account.getAccessToken());
  }

  async describe(): Promise<ResourceDescription> {
    const folder = this.#folder();
    const label = folder.path || `${folder.mountpoint} (root)`;
    return {
      url: toFolderResourceUrl(folder),
      title: label,
      snippet: `List, read, and write files within ${label} in Jottacloud (${folder.device}/${folder.mountpoint}).`,
      suggestedBindingName: "JOTTACLOUD_FOLDER",
      tsType: "JottacloudFolderSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<JottacloudFolderSession> {
    const account = this.#userAccount();
    return new JottacloudFolderSessionImpl(
      approvalQueue.dup(), () => account.getUsername(), this.#backend(), this.#folder(),
      this.ctx.storage.kv, this.env.WORKERS_AI);
  }

  /** Approved: perform the deferred upload, re-checking `ifMatchMd5` against the target file's live
   * state (the same check used by the single-file gatekeeper, applied to the targeted file). There
   * is no cache/simulation overlay to promote or clear here. */
  async applyAction(actionId: number): Promise<void> {
    const key = `write:pending:${actionId}`;
    const pending = this.ctx.storage.kv.get<PendingFolderWrite>(key);
    if (!pending) throw new Error(`Unknown pending Jottacloud folder write: ${actionId}`);
    this.ctx.storage.kv.delete(key);

    const username = await this.#userAccount().getUsername();
    await applyPendingWrite(this.#backend(), username, pending.file, pending);
  }

  /** Rejected: discard the queued write. Nothing was ever sent to Jottacloud. */
  async rejectAction(actionId: number): Promise<void> {
    this.ctx.storage.kv.delete(`write:pending:${actionId}`);
  }

  async revertAction(_actionId: number): Promise<{ message: string; canRetry: boolean }> {
    return {
      message:
          "This write can't be reverted automatically. Use Jottacloud's own revision history on " +
          "this file to restore the previous version.",
      canRetry: false,
    };
  }

  /** Folder bindings are private to the account owner. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "This Jottacloud folder cannot be shared with other users: it may only be observed by the " +
      "person who connected it.");
  }

  async removeObserver(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// FolderSessionImpl — the RPC interface exposed to the Gadget for a folder binding

@validateRpc()
export class JottacloudFolderSessionImpl extends RpcTarget implements JottacloudFolderSession {
  #approvalQueue: RpcStub<ApprovalQueue>;
  #getUsername: () => Promise<string>;
  #backend: DirectJottacloudBackend;
  #folder: JottaFilePath;
  #kv: DurableObjectStorage["kv"];
  #ai: Ai;

  constructor(
      approvalQueue: RpcStub<ApprovalQueue>, getUsername: () => Promise<string>,
      backend: DirectJottacloudBackend, folder: JottaFilePath, kv: DurableObjectStorage["kv"],
      ai: Ai) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#getUsername = getUsername;
    this.#backend = backend;
    this.#folder = folder;
    this.#kv = kv;
    this.#ai = ai;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  async #call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof JottacloudError && error.code === "AUTH_EXPIRED") {
        throw new Error(
          "Jottacloud's credentials have expired or been revoked. Please reconnect the account.",
          { cause: error });
      }
      throw error;
    }
  }

  async getScope(): Promise<JottacloudFolderScope> {
    return { device: this.#folder.device, mountpoint: this.#folder.mountpoint, path: this.#folder.path };
  }

  async list(path?: string): Promise<JottacloudFolderEntry[]> {
    const target = resolveWithinFolder(this.#folder, path ?? "");
    const username = await this.#getUsername();
    const entries = await this.#call(() => this.#backend.list(username, target));
    await this.#approvalQueue.authorizeObservation({
      title: "List Jottacloud folder",
      description: `List the contents of ${target.path || "the bound folder's root"}.`,
    });
    return entries
      .filter(entry => !entry.deleted)
      .map(entry => {
        const entryPath = target.path ? `${target.path}/${entry.name}` : entry.name;
        if (entry.kind === "folder") {
          return { path: entryPath, name: entry.name, isFolder: true };
        }
        return {
          path: entryPath, name: entry.name, isFolder: false,
          size: entry.size, mimeType: entry.mimeType, md5: entry.md5, modifiedAt: entry.modifiedAt,
        };
      });
  }

  /**
   * Resolves `path` within the bound folder, rejecting the folder's own root: `getMetadata()`,
   * `read()`, and `write()` always address a file, never the folder itself — use `list()` for that.
   *
   * Checks the *caller-supplied* path for triviality, not the resolved result: for a folder bound
   * to a non-root path (e.g. "Documents"), an empty `path` argument resolves to "Documents" itself
   * via `resolveWithinFolder` (its own root, same as an empty argument does for a root-bound
   * folder) — which has a non-empty `.path`, so checking the *result* would only catch this for a
   * root-bound folder and silently treat "the bound folder itself" as a file everywhere else.
   */
  #resolveFile(path: string): JottaFilePath {
    const trimmed = (path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!trimmed) {
      throw new JottacloudError("INVALID_RESOURCE", "A file path within the folder is required.");
    }
    return resolveWithinFolder(this.#folder, path);
  }

  async getMetadata(path: string): Promise<JottacloudFileMetadata> {
    const file = this.#resolveFile(path);
    const username = await this.#getUsername();
    const metadata = await this.#call(() => this.#backend.getMetadata(username, file));
    await this.#approvalQueue.authorizeObservation({
      title: "Read Jottacloud file metadata",
      description: `Read metadata for ${file.path}.`,
    });
    return toAgentMetadata(metadata);
  }

  async read(path: string): Promise<ArrayBuffer> {
    const file = this.#resolveFile(path);
    const username = await this.#getUsername();
    const content = await this.#call(() => this.#backend.read(username, file));
    await this.#approvalQueue.authorizeObservation({
      title: "Read Jottacloud file",
      description: `Downloaded the current content of ${file.path} (${content.byteLength} bytes).`,
    });
    return content;
  }

  /** Reuses `getMetadata()`/`read()` the same way `JottacloudFileSession.readAsMarkdown()` does.
   * The folder resource has no cache of its own (see `src/cache.ts`), so unlike the file
   * resource's version, there is no Markdown-cache short-circuit here. */
  async readAsMarkdown(path: string): Promise<JottacloudMarkdownContent> {
    const file = this.#resolveFile(path);
    const metadata = await this.getMetadata(path);
    assertMarkdownConvertible(metadata.mimeType, metadata.size);
    const content = await this.read(path);
    const markdown = await convertToMarkdown(this.#ai, metadata.name, metadata.mimeType, content);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Jottacloud file as Markdown",
      description: `Converted the content of ${file.path} to Markdown.`,
    });
    return { markdown, sourceMimeType: metadata.mimeType };
  }

  /**
   * Unlike `JottacloudFileSession.write()`, this does not simulate: a folder can hold many files,
   * so simulating would mean tracking a pending overlay per path rather than one fixed slot, and
   * no caching exists yet on this session either for it to interact with. Until the write is
   * approved and applied, `read()`/`getMetadata()` on this same path keep reflecting Jottacloud's
   * previous content, not this pending write.
   */
  async write(path: string, content: ArrayBuffer, ifMatchMd5?: string): Promise<void> {
    const file = this.#resolveFile(path);
    const actionId = this.#kv.get<number>("write:nextId") ?? 1;
    this.#kv.put("write:nextId", actionId + 1);
    this.#kv.put<PendingFolderWrite>(`write:pending:${actionId}`, { file, content, ifMatchMd5 });

    try {
      await this.#approvalQueue.submitAction(actionId, {
        title: "Write Jottacloud file",
        description:
            `Upload ${file.path} (${content.byteLength} bytes)` +
            (ifMatchMd5 ? `, only if it has not changed since it was last read.` : "."),
        implementsRevert: false,
      });
    } catch (error) {
      this.#kv.delete(`write:pending:${actionId}`);
      throw error;
    }
  }
}
