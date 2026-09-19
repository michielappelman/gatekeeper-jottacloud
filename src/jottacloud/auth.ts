/**
 * Personal-login-token authentication for Jottacloud. Jottacloud publishes no developer API or
 * auth docs, so the wire format is kept isolated and covered by request-shape tests.
 *
 * Flow: a human copies a "personal login token" out of the Jottacloud web UI. It's a base64url JSON
 * blob naming a well-known/OIDC discovery URL and a one-time auth token. We fetch the discovery
 * document to find the token endpoint, then exchange the auth token for an OAuth-style access +
 * refresh token pair via a `grant_type=password` request. All of it happens server-side in the
 * connect flow — there is no browser redirect to Jottacloud, since the login token itself already
 * proves possession of the account.
 */

import { JottacloudError } from "./errors";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";

/** rclone's `defaultClientID`. Public: every Jottacloud client (including Jottacloud's own apps and
 * rclone) authenticates with this value; it is not a per-deployment secret. */
export const CLIENT_ID = "jottacli";

const AUTH_SCOPE = "openid offline_access";

export type LoginToken = {
  username: string;
  wellKnownLink: string;
  authToken: string;
};

export type WellKnown = {
  tokenEndpoint: string;
};

export type TokenGrant = {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds from now until the access token expires, per the token response's `expires_in`. */
  expiresInMs: number;
};

/**
 * Decodes the base64url personal-login-token blob a human pastes into the connect form.
 *
 * The wire shape (rclone's `api.LoginToken`) is
 * `{ username, realm, well_known_link, auth_token }`; `realm` is not needed here.
 */
export function decodeLoginToken(base64url: string): LoginToken {
  let json: string;
  try {
    const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
    json = atob(padded);
  } catch (error) {
    throw new JottacloudError(
      "INVALID_RESOURCE", "That doesn't look like a Jottacloud personal login token.", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new JottacloudError(
      "INVALID_RESOURCE", "That doesn't look like a Jottacloud personal login token.", { cause: error });
  }
  const record = parsed as Record<string, unknown>;
  const username = record.username;
  const wellKnownLink = record.well_known_link;
  const authToken = record.auth_token;
  if (typeof username !== "string" || typeof wellKnownLink !== "string" ||
      typeof authToken !== "string" || !username || !wellKnownLink || !authToken) {
    throw new JottacloudError(
      "INVALID_RESOURCE", "That personal login token is missing required fields.");
  }
  return { username, wellKnownLink, authToken };
}

async function readTokenEndpoint(response: Response): Promise<string> {
  if (!response.ok) {
    throw new JottacloudError(
      "AUTH_REQUIRED",
      `Could not read Jottacloud's authentication configuration (status ${response.status}).`);
  }
  let body: { token_endpoint?: unknown };
  try {
    body = JSON.parse(await readTextCapped(response)) as { token_endpoint?: unknown };
  } catch (error) {
    throw new JottacloudError(
      "AUTH_REQUIRED", "Jottacloud's authentication configuration could not be parsed.", { cause: error });
  }
  if (typeof body.token_endpoint !== "string" || !body.token_endpoint) {
    throw new JottacloudError(
      "AUTH_REQUIRED", "Jottacloud's authentication configuration did not include a token endpoint.");
  }
  return body.token_endpoint;
}

/** Fetches the OIDC discovery document named by a login token, returning its token endpoint. */
export async function fetchWellKnown(
  wellKnownLink: string, fetchImpl: typeof fetch = fetch): Promise<WellKnown> {
  const response = await fetchImpl(wellKnownLink, { method: "GET" });
  return { tokenEndpoint: await readTokenEndpoint(response) };
}

async function readTokenGrant(response: Response, context: string): Promise<TokenGrant> {
  if (!response.ok) {
    const isAuthRejection = response.status === 400 || response.status === 401;
    throw new JottacloudError(
      isAuthRejection ? "AUTH_REQUIRED" : "UPSTREAM_UNAVAILABLE",
      `Jottacloud rejected ${context} (status ${response.status}).`);
  }
  let body: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  try {
    body = JSON.parse(await readTextCapped(response)) as typeof body;
  } catch (error) {
    throw new JottacloudError(
      "AUTH_REQUIRED", `Jottacloud's response to ${context} could not be parsed.`, { cause: error });
  }
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string" ||
      typeof body.expires_in !== "number") {
    throw new JottacloudError("AUTH_REQUIRED", `Jottacloud's response to ${context} was malformed.`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresInMs: body.expires_in * 1000,
  };
}

/**
 * Exchanges a decoded personal login token for an access/refresh token pair.
 *
 * Verbatim request shape from rclone's `doTokenAuth`: `POST <wellKnown.tokenEndpoint>`,
 * `Content-Type: application/x-www-form-urlencoded`, body
 * `client_id=jottacli&grant_type=password&password=<authToken>&scope=openid+offline_access&username=<username>`.
 */
export async function exchangeLoginToken(
  loginToken: LoginToken, fetchImpl: typeof fetch = fetch,
): Promise<TokenGrant & { tokenEndpoint: string }> {
  const wellKnown = await fetchWellKnown(loginToken.wellKnownLink, fetchImpl);
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "password",
    password: loginToken.authToken,
    scope: AUTH_SCOPE,
    username: loginToken.username,
  });
  const response = await fetchImpl(wellKnown.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const grant = await readTokenGrant(response, "the personal login token");
  return { ...grant, tokenEndpoint: wellKnown.tokenEndpoint };
}

/**
 * Refreshes an access token against the same OIDC token endpoint discovered at connect time.
 * Standard `grant_type=refresh_token`; unlike rclone's *legacy* API path, the modern OIDC endpoint
 * takes the grant type lowercase.
 */
export async function refreshAccessToken(
  tokenEndpoint: string, refreshToken: string, fetchImpl: typeof fetch = fetch,
): Promise<TokenGrant> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return readTokenGrant(response, "the refresh token");
}
