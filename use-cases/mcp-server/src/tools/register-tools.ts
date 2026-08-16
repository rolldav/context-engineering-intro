import type { McpServer } from "@modelcontextprotocol/server";
import { registerDatabaseTools } from "../../examples/database-tools";
import type { ExtendedEnv, Props } from "../types";

/** Register all MCP tools for one isolated authenticated request. */
export function registerAllTools(server: McpServer, env: ExtendedEnv, props: Props): void {
	registerDatabaseTools(server, env, props);
}
