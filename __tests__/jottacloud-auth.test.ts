import { describe, expect, it } from "vitest";
import {
  CLIENT_ID,
  decodeLoginToken,
  exchangeLoginToken,
  fetchWellKnown,
  refreshAccessToken,
} from "../src/jottacloud/auth";
import { JottacloudError } from "../src/jottacloud/errors";

function encodeLoginToken(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const VALID_PAYLOAD = {
  username: "alice",
  realm: "jottacloud",
  well_known_link: "https://id.jottacloud.com/.well-known/openid-configuration",
  auth_token: "one-time-token",
};

describe("decodeLoginToken", () => {
  it("decodes a well-formed base64url personal login token", () => {
    const token = decodeLoginToken(encodeLoginToken(VALID_PAYLOAD));
    expect(token).toEqual({
      username: "alice",
      wellKnownLink: "https://id.jottacloud.com/.well-known/openid-configuration",
      authToken: "one-time-token",
    });
  });

  it("rejects non-base64 input", () => {
    expect(() => decodeLoginToken("not base64!!")).toThrow(JottacloudError);
  });

  it("rejects base64 that isn't JSON", () => {
    expect(() => decodeLoginToken(btoa("not json"))).toThrow(JottacloudError);
  });

  it("rejects a token missing required fields", () => {
    expect(() => decodeLoginToken(encodeLoginToken({ username: "alice" }))).toThrow(/missing required fields/);
  });

  for (const field of ["username", "well_known_link", "auth_token"]) {
    it(`rejects a token with an empty ${field}`, () => {
      expect(() => decodeLoginToken(encodeLoginToken({ ...VALID_PAYLOAD, [field]: "" })))
        .toThrow(/missing required fields/);
    });
  }
});

describe("fetchWellKnown", () => {
  it("returns the token endpoint from a well-known document", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ token_endpoint: "https://id.jottacloud.com/token" }), { status: 200 });
    await expect(fetchWellKnown("https://id.jottacloud.com/.well-known/openid-configuration", fetchImpl))
      .resolves.toEqual({ tokenEndpoint: "https://id.jottacloud.com/token" });
  });

  it("throws AUTH_REQUIRED when the document has no token_endpoint", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({}), { status: 200 });
    await expect(fetchWellKnown("https://id.jottacloud.com/.well-known/openid-configuration", fetchImpl))
      .rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("throws AUTH_REQUIRED on a non-ok response", async () => {
    const fetchImpl = async () => new Response("nope", { status: 500 });
    await expect(fetchWellKnown("https://id.jottacloud.com/.well-known/openid-configuration", fetchImpl))
      .rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});

describe("exchangeLoginToken", () => {
  it("sends the exact rclone-verified password-grant request", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init: init ?? {} });
      if (url === VALID_PAYLOAD.well_known_link) {
        return new Response(JSON.stringify({ token_endpoint: "https://id.jottacloud.com/token" }), { status: 200 });
      }
      if (url === "https://id.jottacloud.com/token") {
        return new Response(
          JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const grant = await exchangeLoginToken(decodeLoginToken(encodeLoginToken(VALID_PAYLOAD)), fetchImpl as typeof fetch);
    expect(grant).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresInMs: 3600_000,
      tokenEndpoint: "https://id.jottacloud.com/token",
    });

    const tokenRequest = requests[1];
    expect(tokenRequest.init.method).toBe("POST");
    expect((tokenRequest.init.headers as Record<string, string>)["Content-Type"])
      .toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(tokenRequest.init.body as string);
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("grant_type")).toBe("password");
    expect(body.get("password")).toBe("one-time-token");
    expect(body.get("scope")).toBe("openid offline_access");
    expect(body.get("username")).toBe("alice");
  });

  it("throws AUTH_REQUIRED when Jottacloud rejects the login token", async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      if (String(input) === VALID_PAYLOAD.well_known_link) {
        return new Response(JSON.stringify({ token_endpoint: "https://id.jottacloud.com/token" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    };
    await expect(
      exchangeLoginToken(decodeLoginToken(encodeLoginToken(VALID_PAYLOAD)), fetchImpl as typeof fetch),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});

describe("refreshAccessToken", () => {
  it("sends a standard grant_type=refresh_token request", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ access_token: "at2", refresh_token: "rt2", expires_in: 1800 }), { status: 200 });
    };
    const grant = await refreshAccessToken("https://id.jottacloud.com/token", "old-refresh", fetchImpl as typeof fetch);
    expect(grant).toEqual({ accessToken: "at2", refreshToken: "rt2", expiresInMs: 1_800_000 });
    const body = new URLSearchParams(captured?.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh");
    expect(body.get("client_id")).toBe(CLIENT_ID);
  });

  it("throws AUTH_REQUIRED when the refresh token is rejected", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
    await expect(refreshAccessToken("https://id.jottacloud.com/token", "old-refresh", fetchImpl as typeof fetch))
      .rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("throws UPSTREAM_UNAVAILABLE on a server error", async () => {
    const fetchImpl = async () => new Response("boom", { status: 503 });
    await expect(refreshAccessToken("https://id.jottacloud.com/token", "old-refresh", fetchImpl as typeof fetch))
      .rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
});
