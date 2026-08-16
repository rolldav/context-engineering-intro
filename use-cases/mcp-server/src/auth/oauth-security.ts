import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import type { OAuthStateStore } from "../durable-objects/oauth-state-store";

const APPROVED_COOKIE = "__Host-mcp-approved-clients";
const FLOW_TTL_SECONDS = 600;
const APPROVAL_TTL_SECONDS = 31_536_000;
const ALLOWED_SCOPES = new Set(["mcp"]);

type AuthorizationErrorLike = Error & {
	code: string;
	description: string;
	redirectUri?: string;
	state?: string;
	issuer?: string;
};

class LocalAuthorizationError extends Error implements AuthorizationErrorLike {
	readonly code = "invalid_scope";
	constructor(
		readonly description: string,
		readonly redirectUri: string,
		readonly state: string,
		readonly issuer?: string,
	) {
		super(description);
		this.name = "AuthorizationError";
	}
}

type StoredFlow = {
	oauthReqInfo: AuthRequest;
	bindingHash: string;
};

type OAuthStateNamespace = DurableObjectNamespace<OAuthStateStore>;

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64Url(bytes);
}

async function digest(value: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return base64Url(new Uint8Array(hash));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	if (!secret) throw new Error("COOKIE_ENCRYPTION_KEY is required");
	return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(secret: string, payload: string): Promise<string> {
	const bytes = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload));
	return base64Url(new Uint8Array(bytes));
}

async function signatureIsValid(secret: string, payload: string, signature: string): Promise<boolean> {
	try {
		return crypto.subtle.verify("HMAC", await hmacKey(secret), decodeBase64Url(signature), new TextEncoder().encode(payload));
	} catch {
		return false;
	}
}

function getCookie(request: Request, name: string): string | null {
	for (const item of (request.headers.get("Cookie") ?? "").split(";")) {
		const [cookieName, ...parts] = item.trim().split("=");
		if (cookieName === name) return parts.join("=");
	}
	return null;
}

function setCookie(name: string, value: string, maxAge: number): string {
	return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function createFlow(
	stateStore: OAuthStateNamespace,
	prefix: "consent" | "upstream",
	oauthReqInfo: AuthRequest,
): Promise<{ token: string; cookieName: string; binding: string }> {
	const token = randomToken();
	const binding = randomToken();
	const cookieName = await flowCookieName(prefix, token);
	await stateStore.getByName(token).put({ oauthReqInfo, bindingHash: await digest(binding) } satisfies StoredFlow, FLOW_TTL_SECONDS);
	return { token, cookieName, binding };
}

async function consumeFlow(
	request: Request,
	stateStore: OAuthStateNamespace,
	prefix: "consent" | "upstream",
	token: string,
): Promise<AuthRequest | null> {
	if (!token) return null;
	const cookieName = await flowCookieName(prefix, token);
	const cookie = getCookie(request, cookieName);
	if (!cookie) return null;
	return stateStore.getByName(token).consume(await digest(cookie));
}

export async function flowCookieName(prefix: "consent" | "upstream", token: string): Promise<string> {
	const id = (await digest(`${prefix}:${token}`)).slice(0, 22);
	return `__Host-mcp-${prefix}-${id}`;
}

export function validateRequestedScopes(request: AuthRequest): void {
	if (!request.scope.includes("mcp")) {
		throw new LocalAuthorizationError("Required scope is missing: mcp", request.redirectUri, request.state, request.issuer);
	}
	const invalid = request.scope.find((scope) => !ALLOWED_SCOPES.has(scope));
	if (!invalid) return;
	throw new LocalAuthorizationError(`Unsupported scope: ${invalid}`, request.redirectUri, request.state, request.issuer);
}

export function authorizationErrorResponse(error: unknown): Response {
	if (!isAuthorizationError(error)) {
		return new Response("Invalid authorization request", { status: 400 });
	}
	if (!error.redirectUri) return new Response(error.description, { status: 400 });
	const redirect = new URL(error.redirectUri);
	redirect.searchParams.set("error", error.code);
	redirect.searchParams.set("error_description", error.description);
	if (error.state) redirect.searchParams.set("state", error.state);
	if (error.issuer) redirect.searchParams.set("iss", error.issuer);
	return Response.redirect(redirect.href, 302);
}

function isAuthorizationError(error: unknown): error is AuthorizationErrorLike {
	return (
		error instanceof Error &&
		error.name === "AuthorizationError" &&
		typeof (error as Partial<AuthorizationErrorLike>).code === "string" &&
		typeof (error as Partial<AuthorizationErrorLike>).description === "string"
	);
}

export async function createConsent(stateStore: OAuthStateNamespace, oauthReqInfo: AuthRequest): Promise<{ token: string; setCookie: string }> {
	const flow = await createFlow(stateStore, "consent", oauthReqInfo);
	return {
		token: flow.token,
		setCookie: setCookie(flow.cookieName, flow.binding, FLOW_TTL_SECONDS),
	};
}

export async function consumeConsent(
	request: Request,
	stateStore: OAuthStateNamespace,
	cookieSecret: string,
): Promise<{ oauthReqInfo: AuthRequest; setCookies: string[] } | null> {
	if (request.method !== "POST") return null;
	const form = await request.formData();
	const token = form.get("consent_token");
	if (typeof token !== "string") return null;
	const cookieName = await flowCookieName("consent", token);
	const oauthReqInfo = await consumeFlow(request, stateStore, "consent", token);
	if (!oauthReqInfo) return null;
	const existing = (await approvedClients(request, cookieSecret)) ?? [];
	const payload = base64Url(new TextEncoder().encode(JSON.stringify(Array.from(new Set([...existing, oauthReqInfo.clientId])))));
	const signature = await sign(cookieSecret, payload);
	return {
		oauthReqInfo,
		setCookies: [setCookie(cookieName, "", 0), setCookie(APPROVED_COOKIE, `${payload}.${signature}`, APPROVAL_TTL_SECONDS)],
	};
}

async function approvedClients(request: Request, secret: string): Promise<string[] | null> {
	const value = getCookie(request, APPROVED_COOKIE);
	const separator = value?.lastIndexOf(".") ?? -1;
	if (!value || separator < 1) return null;
	const payload = value.slice(0, separator);
	if (!(await signatureIsValid(secret, payload, value.slice(separator + 1)))) return null;
	try {
		const clients = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
		return Array.isArray(clients) && clients.every((client) => typeof client === "string") ? clients : null;
	} catch {
		return null;
	}
}

export async function isClientApproved(request: Request, clientId: string, secret: string): Promise<boolean> {
	return (await approvedClients(request, secret))?.includes(clientId) ?? false;
}

export async function createUpstreamState(stateStore: OAuthStateNamespace, oauthReqInfo: AuthRequest): Promise<{ state: string; setCookie: string }> {
	const flow = await createFlow(stateStore, "upstream", oauthReqInfo);
	return {
		state: flow.token,
		setCookie: setCookie(flow.cookieName, flow.binding, FLOW_TTL_SECONDS),
	};
}

export async function consumeUpstreamState(
	request: Request,
	stateStore: OAuthStateNamespace,
	state: string,
): Promise<{ oauthReqInfo: AuthRequest; clearCookie: string } | null> {
	const cookieName = await flowCookieName("upstream", state);
	const oauthReqInfo = await consumeFlow(request, stateStore, "upstream", state);
	return oauthReqInfo ? { oauthReqInfo, clearCookie: setCookie(cookieName, "", 0) } : null;
}

export function renderConsent(
	request: Request,
	options: { client: ClientInfo | null; serverName: string; description: string; token: string },
): Response {
	const clientName = escapeHtml(options.client?.clientName ?? "Unknown MCP Client");
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${clientName} | Authorization</title></head><body><main><h1>${escapeHtml(options.serverName)}</h1><p>${escapeHtml(options.description)}</p><h2>${clientName} is requesting access</h2><form method="post" action="${escapeHtml(new URL(request.url).pathname)}"><input type="hidden" name="consent_token" value="${escapeHtml(options.token)}"><button type="submit">Approve</button></form></main></body></html>`;
	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		},
	});
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
