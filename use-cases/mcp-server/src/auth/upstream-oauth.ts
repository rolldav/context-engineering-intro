import type { UpstreamAuthorizeParams, UpstreamTokenParams } from "../types";

export function getUpstreamAuthorizeUrl({ upstream_url, client_id, scope, redirect_uri, state }: UpstreamAuthorizeParams): string {
	const upstream = new URL(upstream_url);
	upstream.searchParams.set("client_id", client_id);
	upstream.searchParams.set("redirect_uri", redirect_uri);
	upstream.searchParams.set("scope", scope);
	if (state) upstream.searchParams.set("state", state);
	upstream.searchParams.set("response_type", "code");
	return upstream.href;
}

export async function fetchUpstreamAuthToken({
	client_id,
	client_secret,
	code,
	redirect_uri,
	upstream_url,
}: UpstreamTokenParams): Promise<[string, null] | [null, Response]> {
	if (!code) return [null, new Response("Missing code", { status: 400 })];
	const response = await fetch(upstream_url, {
		body: new URLSearchParams({ client_id, client_secret, code, redirect_uri }).toString(),
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		method: "POST",
	});
	if (!response.ok) return [null, new Response("Upstream authorization failed", { status: 502 })];
	const body = (await response.json()) as { access_token?: unknown };
	if (typeof body.access_token !== "string" || !body.access_token) {
		return [null, new Response("Upstream authorization failed", { status: 502 })];
	}
	return [body.access_token, null];
}
