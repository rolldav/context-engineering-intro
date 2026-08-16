import * as Sentry from "@sentry/cloudflare";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { registerDatabaseToolsWithSentry } from "../examples/database-tools-sentry";
import { GitHubHandler } from "./auth/github-handler";
import { PropsSchema, type ExtendedEnv } from "./types";

export { OAuthStateStore } from "./durable-objects/oauth-state-store";

const SentryMcpApiHandler = {
	async fetch(request: Request, env: ExtendedEnv, ctx: ExecutionContext): Promise<Response> {
		const result = PropsSchema.safeParse(ctx.props);
		if (!result.success) {
			return new Response("Unauthorized", {
				headers: { "cache-control": "no-store" },
				status: 401,
			});
		}

		const handler = createMcpHandler(
			() => {
				const authenticated = PropsSchema.safeParse(getMcpAuthContext()?.props);
				if (!authenticated.success) throw new TypeError("Missing authenticated MCP application props");
				const server = new McpServer({
					name: "PostgreSQL Database MCP Server",
					version: "1.0.0",
				});
				registerDatabaseToolsWithSentry(server, env, authenticated.data);
				return server;
			},
			{
				legacy: "stateless",
				route: "/mcp",
			},
		);

		return handler(request, env, ctx);
	},
};

const provider = new OAuthProvider<ExtendedEnv>({
	apiHandler: SentryMcpApiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler,
	scopesSupported: ["mcp"],
	tokenEndpoint: "/token",
});

export default Sentry.withSentry<ExtendedEnv>(
	(env) => ({
		dsn: env.SENTRY_DSN,
		tracesSampleRate: 1,
	}),
	provider,
);
