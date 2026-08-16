import * as Sentry from "@sentry/cloudflare";
import type { McpServer } from "@modelcontextprotocol/server";
import {
	type ExtendedEnv,
	type Props,
	canWriteDatabase,
	ListTablesSchema,
	QueryDatabaseSchema,
	ExecuteDatabaseSchema,
	createErrorResponse,
} from "../src/types";
import {
	isWriteOperation,
	validateReadOnlySqlQuery,
	validateSqlQuery,
} from "../src/database/security";
import { withDatabase, withReadOnlyDatabase } from "../src/database/utils";
import { databaseErrorSignal } from "../src/database/error-signal";

// Emit only an allowlisted generic signal. Never send the original error:
// PostgresError fields may contain SQL, parameters, row data or identities.
function handleError(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
	const signal = databaseErrorSignal(error);
	const eventId = Sentry.captureMessage("database_operation_failed", {
		level: "error",
		tags: {
			"db.error.category": signal.category,
			"db.error.code": signal.code,
		},
	});

	const errorMessage = [
		"**Error**",
		"There was a problem with your request.",
		"Please report the following to the support team:",
		`**Event ID**: ${eventId}`,
	].join("\n\n");

	return {
		isError: true,
		content: [
			{
				type: "text",
				text: errorMessage,
			},
		],
	};
}

export function registerDatabaseToolsWithSentry(server: McpServer, env: ExtendedEnv, props: Props): void {
	// Tool 1: List Tables - Available to all authenticated users
	server.registerTool(
		"listTables",
		{
			description: "Get a list of all tables in the database along with their column information. Use this first to understand the database structure before querying.",
			inputSchema: ListTablesSchema,
		},
		async () => {
			return await Sentry.startNewTrace(async () => {
				return await Sentry.startSpan(
					{
						name: "mcp.tool/listTables",
						attributes: {
							"mcp.tool.name": "listTables",
						},
					},
					async (span) => {
						try {
							return await withReadOnlyDatabase(env.READ_ONLY_DATABASE_URL, async (db) => {
								// Single query to get all table and column information (using your working query)
								const columns = await db.unsafe(`
								SELECT 
									table_name, 
									column_name, 
									data_type, 
									is_nullable,
									column_default
								FROM information_schema.columns 
								WHERE table_schema = 'public' 
								ORDER BY table_name, ordinal_position
							`);

								// Group columns by table
								const tableMap = new Map();
								for (const col of columns) {
									// Use snake_case property names as returned by the SQL query
									if (!tableMap.has(col.table_name)) {
										tableMap.set(col.table_name, {
											name: col.table_name,
											schema: "public",
											columns: [],
										});
									}
									tableMap.get(col.table_name).columns.push({
										name: col.column_name,
										type: col.data_type,
										nullable: col.is_nullable === "YES",
										default: col.column_default,
									});
								}

								const tableInfo = Array.from(tableMap.values());

								return {
									content: [
										{
											type: "text",
											text: `**Database Tables and Schema**\n\n${JSON.stringify(tableInfo, null, 2)}\n\n**Total tables found:** ${tableInfo.length}\n\n**Note:** Use the \`queryDatabase\` tool to run SELECT queries, or \`executeDatabase\` tool for write operations (if you have write access).`,
										},
									],
								};
							});
						} catch (error) {
							span.setStatus({ code: 2 }); // error
							return handleError(error);
						}
					},
				);
			});
		},
	);

	// Tool 2: Query Database - Available to all authenticated users (read-only)
	server.registerTool(
		"queryDatabase",
		{
			description: "Execute a read-only SQL query against the PostgreSQL database. This tool only allows SELECT statements and other read operations. All authenticated users can use this tool.",
			inputSchema: QueryDatabaseSchema,
		},
		async ({ sql }) => {
			return await Sentry.startNewTrace(async () => {
				return await Sentry.startSpan(
					{
						name: "mcp.tool/queryDatabase",
						attributes: {
							"mcp.tool.name": "queryDatabase",
							"mcp.sql.operation_class": "read",
						},
					},
					async (span) => {
						try {
							// Validate the SQL query
							const validation = validateReadOnlySqlQuery(sql);
							if (!validation.isValid) {
								return createErrorResponse(`Invalid SQL query: ${validation.error}`);
							}

							// Check if it's a write operation
							if (isWriteOperation(sql)) {
								return createErrorResponse(
									"Write operations are not allowed with this tool. Use `executeDatabase` only when the deployment has granted database:write permission.",
								);
							}

							return await withReadOnlyDatabase(env.READ_ONLY_DATABASE_URL, async (db) => {
								const results = await db.unsafe(sql);

								return {
									content: [
										{
											type: "text",
											text: `**Query Results**\n\`\`\`sql\n${sql}\n\`\`\`\n\n**Results:**\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n\n**Rows returned:** ${Array.isArray(results) ? results.length : 1}`,
										},
									],
								};
							});
						} catch (error) {
							span.setStatus({ code: 2 }); // error
							return handleError(error);
						}
					},
				);
			});
		},
	);

	// Tool 3: Execute Database - explicit trusted permission claim required
	if (canWriteDatabase(props)) {
		server.registerTool(
			"executeDatabase",
			{
				description: "Execute any SQL statement against the PostgreSQL database, including INSERT, UPDATE, DELETE, and DDL operations. This requires the deployment-issued database:write permission. **USE WITH CAUTION** - this can modify or delete data.",
				inputSchema: ExecuteDatabaseSchema,
			},
			async ({ sql }) => {
				return await Sentry.startNewTrace(async () => {
					return await Sentry.startSpan(
						{
							name: "mcp.tool/executeDatabase",
							attributes: {
								"mcp.tool.name": "executeDatabase",
								"mcp.sql.operation_class": isWriteOperation(sql) ? "write" : "read",
							},
						},
						async (span) => {
							try {
								if (!canWriteDatabase(props)) {
									return createErrorResponse("Database write permission is required");
								}
								// Validate the SQL query
								const validation = validateSqlQuery(sql);
								if (!validation.isValid) {
									return createErrorResponse(`Invalid SQL statement: ${validation.error}`);
								}

								return await withDatabase(env.DATABASE_URL, async (db) => {
									const results = await db.unsafe(sql);

									const isWrite = isWriteOperation(sql);
									const operationType = isWrite ? "Write Operation" : "Read Operation";

									return {
										content: [
											{
												type: "text",
												text: `**${operationType} Executed Successfully**\n\`\`\`sql\n${sql}\n\`\`\`\n\n**Results:**\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n\n${isWrite ? "**⚠️ Database was modified**" : `**Rows returned:** ${Array.isArray(results) ? results.length : 1}`}\n\n**Executed by:** ${props.login} (${props.name})`,
											},
										],
									};
								});
							} catch (error) {
								span.setStatus({ code: 2 }); // error
								return handleError(error);
							}
						},
					);
				});
			},
		);
	}
}
