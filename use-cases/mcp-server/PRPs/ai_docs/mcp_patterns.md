# MCP Server Development Patterns

This project uses the Cloudflare Agents SDK stateless MCP handler and MCP SDK v2. Do not copy the deprecated `McpAgent`, Durable Object transport, `server.tool()`, or `/sse` patterns into new work.

## Required versions and imports

Pin the versions required by the installed Agents release:

```json
{
  "agents": "0.20.1",
  "@modelcontextprotocol/client": "2.0.0",
  "@modelcontextprotocol/sdk": "1.30.0",
  "@modelcontextprotocol/server": "2.0.0",
  "zod": "4.4.3"
}
```

`@modelcontextprotocol/sdk` 1.30.0 remains an exact peer of Agents 0.20.1, but Worker server code imports `McpServer` from `@modelcontextprotocol/server`.

## Stateless authenticated server

```typescript
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";

const PropsSchema = z.object({
  login: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email().optional(),
}).strict();

function createServer(env: Env, props: Props) {
  const server = new McpServer({ name: "Example", version: "1.0.0" });
  registerAllTools(server, env, props);
  return server;
}

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const parsed = PropsSchema.safeParse(ctx.props);
    if (!parsed.success) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    }

    return createMcpHandler(() => {
      const authenticated = PropsSchema.parse(getMcpAuthContext()?.props);
      return createServer(env, authenticated);
    }, {
      legacy: "stateless",
      route: "/mcp",
    })(request, env, ctx);
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GitHubHandler,
  scopesSupported: ["mcp"],
  tokenEndpoint: "/token",
});
```

The OAuth provider validates bearer tokens and passes decrypted claims through `ExecutionContext.props`. Validate `ctx.props` before invoking `createMcpHandler`; only read `getMcpAuthContext()` inside its factory, after ALS is established. Create a fresh server per request. Never log tokens, claims, raw SQL, or query results.

## Tool registration

```typescript
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const QuerySchema = z.object({
  sql: z.string().min(1).describe("A read-only SQL query"),
});

export function registerDatabaseTools(server: McpServer, env: Env, props: Props): void {
  server.registerTool(
    "queryDatabase",
    {
      description: "Run a validated read-only SQL query.",
      inputSchema: QuerySchema,
    },
    async ({ sql }) => {
      const validation = validateReadOnlySqlQuery(sql);
      if (!validation.isValid) {
        return createErrorResponse("Write operations are not allowed");
      }
      return withReadOnlyDatabase(env.READ_ONLY_DATABASE_URL, async (db) => ({
        content: [{ type: "text", text: JSON.stringify(await db.unsafe(sql)) }],
      }));
    },
  );

  if (props.permissions.includes("database:write")) {
    server.registerTool(
      "executeDatabase",
      { description: "Run a validated privileged SQL statement.", inputSchema: QuerySchema },
      async ({ sql }) => executePrivilegedSql(env, props, sql),
    );
  }
}
```

Pass `env` and validated `props` through function arguments. Do not store request-scoped identity in module globals.

`READ_ONLY_DATABASE_URL` is mandatory for list/query tools and must identify a PostgreSQL read-only role. Queries also run in a `READ ONLY` transaction. `DATABASE_URL` is reserved for an explicitly authorized destructive tool. The `database:write` claim is issued only from deployment-owned policy and is rechecked inside the destructive handler. Missing configuration is read-only. Require the `mcp` OAuth scope; do not accept an empty scope.

## OAuth state and credentials

- `OAUTH_KV` is retained for provider grants and tokens.
- Application consent and upstream state live only in the `OAUTH_STATE` SQLite Durable Object.
- Each state value is opaque, bound to a distinct signed `__Host` cookie, expires after 600 seconds, and is atomically consumed once.
- GitHub access tokens are transient. Use them only to fetch identity; never persist them in `Props`.
- `Props` contains minimal identity metadata only.

## Wrangler migrations

The historical migration must remain even after the legacy MCP Durable Object binding is removed:

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["MyMCP"] },
  { "tag": "v2", "new_sqlite_classes": ["OAuthStateStore"] }
],
"durable_objects": {
  "bindings": [
    { "name": "OAUTH_STATE", "class_name": "OAuthStateStore" }
  ]
}
```

Do not add `deleted_classes` merely because the binding disappeared: the v1 migration is deployment history and must remain intact for a local-only migration plan.

## Transport contract

- `/mcp` is the only protected protocol endpoint.
- It uses Streamable HTTP through `createMcpHandler`.
- The handler retains stateless compatibility for supported 2025 clients.
- `/sse` is not served. SSE was the legacy HTTP+SSE transport and is deprecated.

## Validation gates

Run all of these before claiming completion:

```bash
npm ci
npm ls --all
npm audit
npm run type-check
npm run test:run
npm run cf-typegen -- --check
npx wrangler deploy --dry-run
git diff --check
```

Tests must discriminate at least: unauthenticated 401, `tools/list`, `tools/call`, regular versus privileged tool visibility, concurrent principal isolation, `/sse` absence, and unsupported HTTP methods.
