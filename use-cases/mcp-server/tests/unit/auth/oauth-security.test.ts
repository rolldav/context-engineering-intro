import { describe, expect, it } from "vitest";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { OAuthFlowRecord } from "../../../src/durable-objects/oauth-state-store";
import {
  authorizationErrorResponse,
  consumeConsent,
  consumeUpstreamState,
  createConsent,
  createUpstreamState,
  isClientApproved,
  validateRequestedScopes,
} from "../../../src/auth/oauth-security";

class MemoryOAuthStateStub {
  record: OAuthFlowRecord | undefined;
  expiresAt = 0;
  ttl: number | undefined;

  async put(record: OAuthFlowRecord, ttl: number): Promise<void> {
    this.record = record;
    this.ttl = ttl;
    this.expiresAt = Date.now() + ttl * 1000;
  }

  consume(bindingHash: string): AuthRequest | null {
    if (!this.record || this.expiresAt <= Date.now()) {
      this.record = undefined;
      return null;
    }
    if (this.record.bindingHash !== bindingHash) return null;
    const request = this.record.oauthReqInfo;
    this.record = undefined;
    return request;
  }
}

class MemoryOAuthStateNamespace {
  readonly stubs = new Map<string, MemoryOAuthStateStub>();

  getByName(token: string): MemoryOAuthStateStub {
    let stub = this.stubs.get(token);
    if (!stub) {
      stub = new MemoryOAuthStateStub();
      this.stubs.set(token, stub);
    }
    return stub;
  }
}

const oauthRequest: AuthRequest = {
  responseType: "code",
  clientId: "client-123",
  redirectUri: "https://client.example/callback",
  scope: ["mcp"],
  state: "client-state",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  issuer: "https://server.example/",
};

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0];
}

function cookieName(setCookie: string): string {
  return cookiePair(setCookie).split("=", 1)[0];
}

describe("OAuth flow security", () => {
  it("stores opaque upstream state for 600 seconds and consumes it once", async () => {
    const stateStore = new MemoryOAuthStateNamespace();
    const flow = await createUpstreamState(stateStore as never, oauthRequest);
    expect(flow.state).not.toContain(oauthRequest.clientId);
    expect(stateStore.getByName(flow.state).ttl).toBe(600);
    const request = new Request(`https://server.example/callback?state=${flow.state}`, {
      headers: { Cookie: cookiePair(flow.setCookie) },
    });
    const consumed = await consumeUpstreamState(request, stateStore as never, flow.state);
    expect(consumed?.oauthReqInfo).toEqual(oauthRequest);
    expect(await consumeUpstreamState(request, stateStore as never, flow.state)).toBeNull();
  });

  it("rejects a state whose binding cookie does not match without consuming it", async () => {
    const stateStore = new MemoryOAuthStateNamespace();
    const flow = await createUpstreamState(stateStore as never, oauthRequest);
    const wrong = new Request("https://server.example/callback", {
      headers: { Cookie: `${cookieName(flow.setCookie)}=wrong` },
    });
    expect(await consumeUpstreamState(wrong, stateStore as never, flow.state)).toBeNull();
    expect(stateStore.getByName(flow.state).record).toBeDefined();
  });

  it("keeps parallel flows independent and accepts callbacks in reverse order", async () => {
    const stateStore = new MemoryOAuthStateNamespace();
    const first = await createUpstreamState(stateStore as never, oauthRequest);
    const secondRequest = { ...oauthRequest, clientId: "client-456", state: "second-client-state" };
    const second = await createUpstreamState(stateStore as never, secondRequest);
    expect(cookieName(first.setCookie)).not.toBe(cookieName(second.setCookie));

    const cookieJar = `${cookiePair(first.setCookie)}; ${cookiePair(second.setCookie)}`;
    const secondResult = await consumeUpstreamState(
      new Request("https://server.example/callback", { headers: { Cookie: cookieJar } }),
      stateStore as never,
      second.state,
    );
    const firstResult = await consumeUpstreamState(
      new Request("https://server.example/callback", { headers: { Cookie: cookieJar } }),
      stateStore as never,
      first.state,
    );
    expect(secondResult?.oauthReqInfo).toEqual(secondRequest);
    expect(firstResult?.oauthReqInfo).toEqual(oauthRequest);
  });

  it("allows exactly one of two concurrent consumers", async () => {
    const stateStore = new MemoryOAuthStateNamespace();
    const flow = await createUpstreamState(stateStore as never, oauthRequest);
    const request = new Request("https://server.example/callback", {
      headers: { Cookie: cookiePair(flow.setCookie) },
    });
    const results = await Promise.all([
      consumeUpstreamState(request, stateStore as never, flow.state),
      consumeUpstreamState(request, stateStore as never, flow.state),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
  });

  it("rejects expired state", async () => {
    const stateStore = new MemoryOAuthStateNamespace();
    const flow = await createUpstreamState(stateStore as never, oauthRequest);
    stateStore.getByName(flow.state).expiresAt = Date.now() - 1;
    const request = new Request("https://server.example/callback", {
      headers: { Cookie: cookiePair(flow.setCookie) },
    });
    expect(await consumeUpstreamState(request, stateStore as never, flow.state)).toBeNull();
  });

  it("requires one-time consent and produces an authenticated approved-client cookie", async () => {
    const stateStore = new MemoryOAuthStateNamespace();
    const consent = await createConsent(stateStore as never, oauthRequest);
    const form = new FormData();
    form.set("consent_token", consent.token);
    const request = new Request("https://server.example/authorize", {
      method: "POST",
      body: form,
      headers: { Cookie: cookiePair(consent.setCookie) },
    });
    const replay = request.clone();
    const approved = await consumeConsent(request, stateStore as never, "cookie-secret");
    expect(approved?.oauthReqInfo).toEqual(oauthRequest);
    expect(await consumeConsent(replay, stateStore as never, "cookie-secret")).toBeNull();
    const approvedCookie = approved?.setCookies.find((cookie) => cookie.startsWith("__Host-mcp-approved-clients="))?.split(";", 1)[0];
    const followup = new Request("https://server.example/authorize", {
      headers: { Cookie: approvedCookie ?? "" },
    });
    expect(await isClientApproved(followup, oauthRequest.clientId, "cookie-secret")).toBe(true);
    expect(await isClientApproved(followup, oauthRequest.clientId, "wrong-secret")).toBe(false);
  });

  it("rejects scopes outside the server whitelist", () => {
    expect(() => validateRequestedScopes({ ...oauthRequest, scope: ["mcp", "admin"] })).toThrow("Unsupported scope: admin");
  });

  it("rejects an authorization request without the required mcp scope", () => {
    expect(() => validateRequestedScopes({ ...oauthRequest, scope: [] })).toThrow("Required scope is missing: mcp");
  });

  it("redirects AuthorizationError only after a verified redirect URI is present", () => {
    const safe = authorizationErrorResponse(
      Object.assign(new Error("Unsupported scope"), {
        name: "AuthorizationError",
        code: "invalid_scope",
        description: "Unsupported scope",
        redirectUri: oauthRequest.redirectUri,
        state: oauthRequest.state,
        issuer: oauthRequest.issuer,
      }),
    );
    expect(safe.status).toBe(302);
    const redirect = new URL(safe.headers.get("Location") as string);
    expect(redirect.searchParams.get("state")).toBe(oauthRequest.state);
    expect(redirect.searchParams.get("iss")).toBe(oauthRequest.issuer);

    const local = authorizationErrorResponse(
      Object.assign(new Error("Invalid client"), {
        name: "AuthorizationError",
        code: "invalid_request",
        description: "Invalid client",
      }),
    );
    expect(local.status).toBe(400);
    expect(local.headers.get("Location")).toBeNull();
  });
});
