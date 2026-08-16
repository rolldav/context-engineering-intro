---
name: "MCP Server PRP Template"
description: "Production-ready stateless MCP SDK v2 server on Cloudflare Workers with OAuth."
---

## Goal

Build a stateless Streamable HTTP MCP server that:

- exposes `[TOOLS AND RESOURCES]` at `/mcp`;
- protects the endpoint with `@cloudflare/workers-oauth-provider`;
- validates application props from `getMcpAuthContext()` and fails closed;
- isolates permissions and tool registration per request;
- stores one-time consent/upstream OAuth state in the `OAUTH_STATE` SQLite Durable Object;
- keeps upstream provider credentials transient;
- passes local type, test, dependency, Wrangler typegen, dry-run, and diff gates.

## Mandatory references

```yaml
- file: PRPs/ai_docs/mcp_patterns.md
  why: Current SDK v2, OAuth, transport, Durable Object, and validation contract
- file: src/index.ts
  why: Canonical createMcpHandler and OAuthProvider composition
- file: src/tools/register-tools.ts
  why: Central per-request tool registry
- file: examples/database-tools.ts
  why: registerTool, Zod, database, and permission patterns
- file: src/auth/github-handler.ts
  why: GitHub identity flow with transient access token
- file: src/auth/oauth-security.ts
  why: Consent, per-flow cookie, and upstream state validation
- file: src/durable-objects/oauth-state-store.ts
  why: Atomic one-time OAuth state with SQLite and TTL
- file: wrangler.jsonc
  why: Current binding and immutable migration history
- url: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
  why: createMcpHandler and getMcpAuthContext API
- url: https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/
  why: Stateful-to-stateless migration contract
```

## Versions

Use the exact peer set from the current repository. For Agents 0.20.1:

```json
{
  "agents": "0.20.1",
  "@modelcontextprotocol/client": "2.0.0",
  "@modelcontextprotocol/sdk": "1.30.0",
  "@modelcontextprotocol/server": "2.0.0",
  "zod": "4.4.3"
}
```

Do not remove SDK 1.30.0 while Agents declares it as an exact peer. Server implementation code uses `@modelcontextprotocol/server`.

## Architecture invariants

1. `McpAgent` is deprecated and must not be introduced.
2. Create a fresh `McpServer` from a factory for every request.
3. Use `server.registerTool()`, not legacy `server.tool()`.
4. `/mcp` is the only protocol route. Do not add a legacy `/sse` transport.
5. Validate OAuth Provider `ExecutionContext.props` before invoking `createMcpHandler`; only read `getMcpAuthContext()` inside its factory after ALS is established. Invalid claims return HTTP 401 with `cache-control: no-store`.
6. Pass validated `env` and `props` explicitly into tool registration. Never use module-level request identity.
7. Tool visibility may enforce authorization, but every destructive tool handler must also validate its inputs and authorization assumptions.
8. Never log or return OAuth access tokens or `AuthInfo.extra.props`.

## Implementation pattern

```typescript
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";

function createServer(env: ExtendedEnv, props: Props) {
  const server = new McpServer({ name: "[SERVER NAME]", version: "1.0.0" });
  registerAllTools(server, env, props);
  return server;
}

const apiHandler = {
  async fetch(request: Request, env: ExtendedEnv, ctx: ExecutionContext) {
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

export default new OAuthProvider<ExtendedEnv>({
  apiRoute: "/mcp",
  apiHandler,
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GitHubHandler,
  scopesSupported: ["mcp"],
  tokenEndpoint: "/token",
});
```

## Tool pattern

```typescript
const InputSchema = z.object({
  value: z.string().min(1).describe("Value to process"),
});

export function registerFeatureTools(server: McpServer, env: ExtendedEnv, props: Props): void {
  server.registerTool(
    "featureTool",
    { description: "[PRECISE TOOL DESCRIPTION]", inputSchema: InputSchema },
    async ({ value }) => {
      try {
        const result = await performOperation(env, props, value);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return createErrorResponse(formatSafeError(error));
      }
    },
  );
}
```

## OAuth storage contract

- Keep `OAUTH_KV` for provider grants and tokens.
- Store application consent and upstream state only in `OAUTH_STATE`.
- Use opaque identifiers, a 600-second TTL, atomic one-time consume, and a distinct signed `__Host` cookie per flow.
- Store only minimal GitHub identity in `Props`; never store the GitHub access token.

Wrangler must retain historical migrations even when their binding is removed:

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

Do not add `deleted_classes` during a local-only migration unless an independently approved deployment plan explicitly retires the remote class.

## Task sequence

1. Inventory the current imports, routes, bindings, OAuth props, and tools.
2. Lock current behavior with tests if coverage is absent.
3. Update the exact dependency peer set and regenerate the lockfile with `npm install`.
4. Replace the stateful class with `createMcpHandler` and a per-request server factory.
5. Migrate every tool to `registerTool` and Zod object schemas.
6. Remove the `MCP_OBJECT` binding while retaining migration v1 and OAuth state migration v2.
7. Generate `worker-configuration.d.ts` with Wrangler; never hand-maintain it.
8. Update code examples and PRP guidance so generators cannot restore the old architecture.
9. Run the complete validation matrix below.
10. Stop before commit, push, deployment, secrets, real OAuth, or remote mutation unless separately authorized.

## Discriminating tests

Tests must prove:

- missing or malformed application props return HTTP 401 and `no-store`;
- `tools/list` returns only tools authorized for that principal;
- `tools/call` validates arguments and preserves read/write boundaries;
- simultaneous regular and privileged requests do not share props or tool surface;
- `/sse` is absent;
- unsupported methods are rejected;
- OAuth state remains atomic, one-time, TTL-bound, and resistant to forged/replayed state.

## Validation matrix

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

Record each command's exit code separately. A successful dry-run proves local bundling/configuration only; it is not a deployment or production acceptance test.

## Anti-patterns

- `McpAgent`, `.serve()`, `.serveSSE()`, `/sse`, or `MCP_OBJECT` as current configuration
- `server.tool()` or imports from `@modelcontextprotocol/sdk/server/mcp.js` in current server code
- OAuth application state in KV
- provider access tokens inside `Props`
- module-global request identity or a shared mutable `McpServer`
- `as any` on environment, auth, or tool handler boundaries
- deleting historical migrations to make the config appear clean
- claiming production success from unit tests or Wrangler dry-run
