import { z } from "zod";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { OAuthStateStore } from "./durable-objects/oauth-state-store";

export const PermissionSchema = z.enum(["database:write"]);
export const PropsSchema = z
  .object({
    login: z.string().min(1),
    name: z.string().min(1),
    email: z.string().email().optional(),
    permissions: z.array(PermissionSchema).default([]),
  })
  .strict();

// Trusted application context encrypted into the OAuth access token.
export type Props = z.infer<typeof PropsSchema>;

export function canWriteDatabase(props: Props): boolean {
  return props.permissions.includes("database:write");
}

// Extended environment with OAuth provider
export type ExtendedEnv = Env & {
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_KV: KVNamespace;
  OAUTH_STATE: DurableObjectNamespace<OAuthStateStore>;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  DATABASE_WRITE_GITHUB_LOGINS?: string;
  COOKIE_ENCRYPTION_KEY: string;
  DATABASE_URL: string;
  READ_ONLY_DATABASE_URL: string;
  SENTRY_DSN?: string;
};

// OAuth URL construction parameters
export interface UpstreamAuthorizeParams {
  upstream_url: string;
  client_id: string;
  scope: string;
  redirect_uri: string;
  state?: string;
}

// OAuth token exchange parameters
export interface UpstreamTokenParams {
  code: string | undefined;
  upstream_url: string;
  client_secret: string;
  redirect_uri: string;
  client_id: string;
}

// MCP tool schemas using Zod
export const ListTablesSchema = z.object({});

export const QueryDatabaseSchema = z.object({
  sql: z.string().min(1, "SQL query cannot be empty").describe("SQL query to execute (SELECT queries only)"),
});

export const ExecuteDatabaseSchema = z.object({
  sql: z.string().min(1, "SQL command cannot be empty").describe("SQL command to execute (INSERT, UPDATE, DELETE, CREATE, etc.)"),
});

// MCP response types
export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpResponse {
  content: McpTextContent[];
  isError?: boolean;
}

// Standard response creators
export function createSuccessResponse(message: string, data?: any): McpResponse {
  let text = `**Success**\n\n${message}`;
  if (data !== undefined) {
    text += `\n\n**Result:**\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  }
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

export function createErrorResponse(message: string, details?: any): McpResponse {
  let text = `**Error**\n\n${message}`;
  if (details !== undefined) {
    text += `\n\n**Details:**\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\``;
  }
  return {
    isError: true,
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

// Database operation result type
export interface DatabaseOperationResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  duration?: number;
}

// SQL validation result
export interface SqlValidationResult {
  isValid: boolean;
  error?: string;
}

// Re-export external types that are used throughout
export type { OAuthHelpers };
