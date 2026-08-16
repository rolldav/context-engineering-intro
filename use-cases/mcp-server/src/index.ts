import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { GitHubHandler } from "./auth/github-handler";
import { registerAllTools } from "./tools/register-tools";
import { PropsSchema, type ExtendedEnv, type Props } from "./types";

export { OAuthStateStore } from "./durable-objects/oauth-state-store";

export function readAuthenticatedProps(value: unknown = getMcpAuthContext()?.props): Props | null {
	const result = PropsSchema.safeParse(value);
	return result.success ? result.data : null;
}

export function createMcpServer(env: ExtendedEnv, props: Props): McpServer {
	const server = new McpServer({
		name: "PostgreSQL Database MCP Server",
		version: "1.0.0",
	});
	registerAllTools(server, env, props);
	return server;
}

export function createAuthenticatedMcpHandler(env: ExtendedEnv) {
	return createMcpHandler(() => {
		const props = readAuthenticatedProps();
		if (!props) throw new TypeError("Missing authenticated MCP application props");
		return createMcpServer(env, props);
	}, {
		legacy: "stateless",
		route: "/mcp",
	});
}

export const McpApiHandler = {
	async fetch(request: Request, env: ExtendedEnv, ctx: ExecutionContext): Promise<Response> {
		const props = readAuthenticatedProps(ctx.props);
		if (!props) {
			return new Response("Unauthorized", {
				headers: { "cache-control": "no-store" },
				status: 401,
			});
		}
		return createAuthenticatedMcpHandler(env)(request, env, ctx);
	},
};

export default new OAuthProvider<ExtendedEnv>({
	apiHandler: McpApiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler,
	scopesSupported: ["mcp"],
	tokenEndpoint: "/token",
});
