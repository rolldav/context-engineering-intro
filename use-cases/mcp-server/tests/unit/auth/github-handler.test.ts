import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { OAuthFlowRecord } from "../../../src/durable-objects/oauth-state-store";

const getAuthenticated = vi.hoisted(() => vi.fn());
vi.mock("octokit", () => ({
  Octokit: class MockOctokit {
    readonly rest = { users: { getAuthenticated } };
  },
}));

import { GitHubHandler, permissionsForGitHubLogin } from "../../../src/auth/github-handler";

class MemoryOAuthStateStub {
  record: OAuthFlowRecord | undefined;

  async put(record: OAuthFlowRecord, ttl: number): Promise<void> {
    expect(ttl).toBe(600);
    this.record = record;
  }

  consume(bindingHash: string): AuthRequest | null {
    if (!this.record || this.record.bindingHash !== bindingHash) return null;
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

  clear(): void {
    this.stubs.clear();
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

function cookieByPrefix(setCookie: string, prefix: string): string {
  return setCookie.match(new RegExp(`${prefix}[^=;,]*=[^;,]+`))?.[0] ?? "";
}

function cookieName(cookie: string): string {
  return cookie.split("=", 1)[0];
}

function consentToken(responseBody: string): string {
  return responseBody.match(/name="consent_token" value="([^"]+)"/)?.[1] ?? "";
}

describe("GitHub OAuth handler", () => {
  const completeAuthorization = vi.fn();
  const stateStore = new MemoryOAuthStateNamespace();
  const env = {
    OAUTH_KV: {},
    OAUTH_STATE: stateStore,
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    COOKIE_ENCRYPTION_KEY: "cookie-secret",
    DATABASE_WRITE_GITHUB_LOGINS: undefined as string | undefined,
    OAUTH_PROVIDER: {
      parseAuthRequest: vi.fn(),
      lookupClient: vi.fn(),
      completeAuthorization,
    },
  };

  beforeEach(() => {
    stateStore.clear();
    vi.clearAllMocks();
    env.DATABASE_WRITE_GITHUB_LOGINS = undefined;
    env.OAUTH_PROVIDER.parseAuthRequest.mockResolvedValue(oauthRequest);
    env.OAUTH_PROVIDER.lookupClient.mockResolvedValue({
      clientId: oauthRequest.clientId,
      clientName: "Test client",
      redirectUris: [oauthRequest.redirectUri],
      tokenEndpointAuthMethod: "none",
    });
    completeAuthorization.mockImplementation(async ({ request }: { request: AuthRequest }) => ({
      redirectTo: `${request.redirectUri}?code=provider-code&state=${request.state}`,
    }));
    getAuthenticated.mockResolvedValue({
      data: { login: "alice", name: "Alice", email: "alice@example.com" },
    });
    global.fetch = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ access_token: "github-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;
  });

  it("uses one-time consent and upstream state without persisting the GitHub token", async () => {
    const authorize = await GitHubHandler.fetch(new Request("https://server.example/authorize?response_type=code"), env as any);
    expect(authorize.status).toBe(200);
    const token = consentToken(await authorize.text());
    expect(token).toBeTruthy();

    const form = new FormData();
    form.set("consent_token", token);
    const approved = await GitHubHandler.fetch(
      new Request("https://server.example/authorize", {
        method: "POST",
        body: form,
        headers: {
          Cookie: cookieByPrefix(authorize.headers.get("Set-Cookie") ?? "", "__Host-mcp-consent-"),
        },
      }),
      env as any,
    );
    expect(approved.status).toBe(302);
    const githubLocation = new URL(approved.headers.get("Location") as string);
    const state = githubLocation.searchParams.get("state") as string;
    expect(githubLocation.searchParams.get("scope")).toBe("read:user");
    expect(githubLocation.searchParams.get("scope")).not.toContain("user:email");
    expect(state).not.toContain(oauthRequest.clientId);

    const stateCookie = cookieByPrefix(approved.headers.get("Set-Cookie") ?? "", "__Host-mcp-upstream-");
    const callbackRequest = new Request(`https://server.example/callback?code=github-code&state=${state}`, {
      headers: { Cookie: stateCookie },
    });
    const callback = await GitHubHandler.fetch(callbackRequest, env as any);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toContain("provider-code");
    expect(completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        props: { login: "alice", name: "Alice", email: "alice@example.com", permissions: [] },
        scope: ["mcp"],
      }),
    );
    expect(completeAuthorization.mock.calls[0][0].props).not.toHaveProperty("accessToken");

    const replay = await GitHubHandler.fetch(callbackRequest.clone(), env as any);
    expect(replay.status).toBe(400);
  });

  it("derives write permission only from a valid deployment-owned allowlist", async () => {
    expect(permissionsForGitHubLogin("alice", undefined)).toEqual([]);
    expect(permissionsForGitHubLogin("alice", "bad--login,alice")).toEqual([]);
    expect(permissionsForGitHubLogin("alice", "bob")).toEqual([]);
    expect(permissionsForGitHubLogin("alice", "bob,ALICE")).toEqual(["database:write"]);

    env.DATABASE_WRITE_GITHUB_LOGINS = "alice";
    const authorize = await GitHubHandler.fetch(new Request("https://server.example/authorize"), env as any);
    const form = new FormData();
    form.set("consent_token", consentToken(await authorize.text()));
    const approved = await GitHubHandler.fetch(
      new Request("https://server.example/authorize", {
        method: "POST",
        body: form,
        headers: { Cookie: cookieByPrefix(authorize.headers.get("Set-Cookie") ?? "", "__Host-mcp-consent-") },
      }),
      env as any,
    );
    const location = new URL(approved.headers.get("Location") as string);
    const callback = await GitHubHandler.fetch(
      new Request(`https://server.example/callback?code=github-code&state=${location.searchParams.get("state")}`, {
        headers: { Cookie: cookieByPrefix(approved.headers.get("Set-Cookie") ?? "", "__Host-mcp-upstream-") },
      }),
      env as any,
    );

    expect(callback.status).toBe(302);
    expect(completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ props: expect.objectContaining({ permissions: ["database:write"] }) }),
    );
  });

  it("keeps two flows independent when callbacks finish in reverse order", async () => {
    const secondRequest = { ...oauthRequest, clientId: "client-456", state: "client-state-456" };
    env.OAUTH_PROVIDER.parseAuthRequest.mockResolvedValueOnce(oauthRequest).mockResolvedValueOnce(secondRequest);

    const firstAuthorize = await GitHubHandler.fetch(new Request("https://server.example/authorize"), env as any);
    const secondAuthorize = await GitHubHandler.fetch(new Request("https://server.example/authorize"), env as any);
    const firstConsentCookie = cookieByPrefix(firstAuthorize.headers.get("Set-Cookie") ?? "", "__Host-mcp-consent-");
    const secondConsentCookie = cookieByPrefix(secondAuthorize.headers.get("Set-Cookie") ?? "", "__Host-mcp-consent-");
    expect(cookieName(firstConsentCookie)).not.toBe(cookieName(secondConsentCookie));

    const approve = async (response: Response, consentCookie: string) => {
      const form = new FormData();
      form.set("consent_token", consentToken(await response.text()));
      return GitHubHandler.fetch(
        new Request("https://server.example/authorize", { method: "POST", body: form, headers: { Cookie: consentCookie } }),
        env as any,
      );
    };

    const secondApproved = await approve(secondAuthorize, secondConsentCookie);
    const firstApproved = await approve(firstAuthorize, firstConsentCookie);
    const secondLocation = new URL(secondApproved.headers.get("Location") as string);
    const firstLocation = new URL(firstApproved.headers.get("Location") as string);
    const secondUpstreamCookie = cookieByPrefix(secondApproved.headers.get("Set-Cookie") ?? "", "__Host-mcp-upstream-");
    const firstUpstreamCookie = cookieByPrefix(firstApproved.headers.get("Set-Cookie") ?? "", "__Host-mcp-upstream-");
    expect(cookieName(firstUpstreamCookie)).not.toBe(cookieName(secondUpstreamCookie));

    const cookieJar = `${firstUpstreamCookie}; ${secondUpstreamCookie}`;
    const secondCallbackRequest = new Request(
      `https://server.example/callback?code=second-code&state=${secondLocation.searchParams.get("state")}`,
      { headers: { Cookie: cookieJar } },
    );
    const firstCallbackRequest = new Request(
      `https://server.example/callback?code=first-code&state=${firstLocation.searchParams.get("state")}`,
      { headers: { Cookie: cookieJar } },
    );
    const secondCallback = await GitHubHandler.fetch(secondCallbackRequest, env as any);
    const firstCallback = await GitHubHandler.fetch(firstCallbackRequest, env as any);

    expect(secondCallback.status).toBe(302);
    expect(firstCallback.status).toBe(302);
    expect(secondCallback.headers.get("Set-Cookie")).toContain(`${cookieName(secondUpstreamCookie)}=`);
    expect(secondCallback.headers.get("Set-Cookie")).not.toContain(`${cookieName(firstUpstreamCookie)}=`);
    expect(firstCallback.headers.get("Set-Cookie")).toContain(`${cookieName(firstUpstreamCookie)}=`);
    expect((await GitHubHandler.fetch(secondCallbackRequest.clone(), env as any)).status).toBe(400);
    expect((await GitHubHandler.fetch(firstCallbackRequest.clone(), env as any)).status).toBe(400);
    expect(completeAuthorization).toHaveBeenCalledTimes(2);
  });
});
