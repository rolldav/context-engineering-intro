// import { env } from "cloudflare:workers";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { Octokit } from "octokit";
import type { Props, ExtendedEnv } from "../types";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl } from "./upstream-oauth";
import {
	authorizationErrorResponse,
	consumeConsent,
	consumeUpstreamState,
	createConsent,
	createUpstreamState,
	isClientApproved,
	renderConsent,
	validateRequestedScopes,
} from "./oauth-security";
const app = new Hono<{ Bindings: ExtendedEnv }>();

function isValidGitHubLogin(login: string): boolean {
	return (
		login.length >= 1 &&
		login.length <= 39 &&
		/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(login) &&
		!login.includes("--")
	);
}

/**
 * Convert a deployment-owned allowlist into an application permission claim.
 * A missing, empty, or malformed setting fails closed and grants no write access.
 */
export function permissionsForGitHubLogin(
	login: string,
	configuredLogins: string | undefined,
): Props["permissions"] {
	if (!isValidGitHubLogin(login) || !configuredLogins?.trim()) return [];
	const entries = configuredLogins.split(",").map((entry) => entry.trim());
	if (entries.some((entry) => !isValidGitHubLogin(entry))) return [];
	const normalizedLogin = login.toLowerCase();
	return entries.some((entry) => entry.toLowerCase() === normalizedLogin) ? ["database:write"] : [];
}

app.get("/authorize", async (c) => {
	let oauthReqInfo: AuthRequest;
	try {
		oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
		validateRequestedScopes(oauthReqInfo);
	} catch (error) {
		return authorizationErrorResponse(error);
	}
	const { clientId } = oauthReqInfo;

	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		return redirectToGithub(c.req.raw, oauthReqInfo, c.env);
	}

	const consent = await createConsent(c.env.OAUTH_STATE, oauthReqInfo);
	const response = renderConsent(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		description: "This is a demo MCP Remote Server using GitHub for authentication.",
		serverName: "Cloudflare GitHub MCP Server",
		token: consent.token,
	});
	response.headers.append("Set-Cookie", consent.setCookie);
	return response;
});

app.post("/authorize", async (c) => {
	const consent = await consumeConsent(c.req.raw, c.env.OAUTH_STATE, c.env.COOKIE_ENCRYPTION_KEY);
	if (!consent) return c.text("Invalid or expired consent", 400);
	return redirectToGithub(c.req.raw, consent.oauthReqInfo, c.env, consent.setCookies);
});

async function redirectToGithub(request: Request, oauthReqInfo: AuthRequest, env: ExtendedEnv, setCookies: string[] = []) {
	const upstreamState = await createUpstreamState(env.OAUTH_STATE, oauthReqInfo);
	const headers = new Headers({
		location: getUpstreamAuthorizeUrl({
			client_id: env.GITHUB_CLIENT_ID,
			redirect_uri: new URL("/callback", request.url).href,
			scope: "read:user",
			state: upstreamState.state,
			upstream_url: "https://github.com/login/oauth/authorize",
		}),
	});
	for (const cookie of [...setCookies, upstreamState.setCookie]) headers.append("Set-Cookie", cookie);
	return new Response(null, {
		headers,
		status: 302,
	});
}

/**
 * OAuth Callback Endpoint
 *
 * This route handles the callback from GitHub after user authentication.
 * It exchanges the temporary code for an access token, uses that credential
 * transiently to load the GitHub identity, then stores only minimal user metadata
 * in the client token props. It ends by redirecting the client back to _its_ callback URL.
 */
app.get("/callback", async (c) => {
	const flow = await consumeUpstreamState(c.req.raw, c.env.OAUTH_STATE, c.req.query("state") ?? "");
	if (!flow) return c.text("Invalid or expired state", 400);
	if (c.req.query("error")) {
		return new Response("GitHub authorization was not completed", {
			status: 400,
			headers: { "Set-Cookie": flow.clearCookie },
		});
	}
	const { oauthReqInfo } = flow;

	// Exchange the code for an access token
	const [accessToken, errResponse] = await fetchUpstreamAuthToken({
		client_id: c.env.GITHUB_CLIENT_ID,
		client_secret: c.env.GITHUB_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/callback", c.req.url).href,
		upstream_url: "https://github.com/login/oauth/access_token",
	});
	if (errResponse) {
		errResponse.headers.append("Set-Cookie", flow.clearCookie);
		return errResponse;
	}

	// Fetch the user info from GitHub
	const user = await new Octokit({ auth: accessToken }).rest.users.getAuthenticated();
	const { login, name, email } = user.data;

	// Return back to the MCP client a new token
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: {
			label: name,
		},
		// These minimal identity props are available through getMcpAuthContext().
		props: {
			email: email ?? undefined,
			login,
			name: name ?? login,
			permissions: permissionsForGitHubLogin(login, c.env.DATABASE_WRITE_GITHUB_LOGINS),
		} as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: login,
	});

	return new Response(null, {
		status: 302,
		headers: { Location: redirectTo, "Set-Cookie": flow.clearCookie },
	});
});

export { app as GitHubHandler };
