# MCP Server with GitHub OAuth

This directory is an executable Cloudflare Workers template. Its current architecture is a stateless MCP SDK v2 server protected by the Workers OAuth Provider. Treat repository code and `PRPs/ai_docs/mcp_patterns.md` as canonical; do not restore deprecated `McpAgent` examples.

## Core rules

- Prefer small, typed, testable functions.
- Never commit `.dev.vars`, credentials, access tokens, or database URLs.
- Never store GitHub access tokens in OAuth `Props`.
- Never store consent or upstream OAuth state in KV; use `OAUTH_STATE`.
- Never reuse a mutable `McpServer` or request identity across requests.
- No commit, push, deployment, secret mutation, or real OAuth test without explicit authorization.

## Commands

```bash
npm ci
npm run dev
npm run type-check
npm run test:run
npm run cf-typegen
npm run cf-typegen -- --check
npx wrangler deploy --dry-run
```

Wrangler is project-local and pinned. For login callback problems on this Mac, keep the project `.npmrc` Node network-family options and use the explicit IPv4 callback host documented in the incident closeout; do not weaken firewall rules.

## Architecture

```text
src/
├── index.ts                         OAuthProvider + stateless /mcp handler
├── index_sentry.ts                  equivalent entry point with Sentry
├── types.ts                         strict Props schema and environment types
├── auth/
│   ├── github-handler.ts            consent and GitHub identity flow
│   ├── oauth-security.ts            state/cookie validation
│   └── upstream-oauth.ts            upstream URL and token exchange
├── durable-objects/
│   └── oauth-state-store.ts         atomic one-time SQLite state
├── database/                        SQL validation and connection helpers
└── tools/
    └── register-tools.ts            central per-request tool registry
examples/
├── database-tools.ts                SDK v2 database tools
└── database-tools-sentry.ts         instrumented SDK v2 tools
```

### Protocol server

The Worker imports:

```typescript
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
```

The OAuth provider protects only `/mcp`. The handler validates application props before constructing a fresh server:

```typescript
const apiHandler = {
  async fetch(request: Request, env: ExtendedEnv, ctx: ExecutionContext) {
    // workers-oauth-provider supplies decrypted application claims here.
    const parsed = PropsSchema.safeParse(ctx.props);
    if (!parsed.success) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "cache-control": "no-store" },
      });
    }

    return createMcpHandler(() => {
      const authenticated = PropsSchema.parse(getMcpAuthContext()?.props);
      return createMcpServer(env, authenticated);
    }, {
      legacy: "stateless",
      route: "/mcp",
    })(request, env, ctx);
  },
};
```

`legacy: "stateless"` is compatibility for supported 2025 Streamable HTTP clients. It is not the deprecated HTTP+SSE transport. `/sse` is intentionally absent.

### OAuth composition

```typescript
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

The provider validates the bearer token and supplies trusted claims in `ctx.props`. Validate those claims before entering the MCP handler; `createMcpHandler` then establishes `getMcpAuthContext()` for the server factory. Never read ALS before calling the handler. Standard SDK v2 `AuthInfo` may be available in tool callback context; never log or return its token fields.

## Tool registration

Use `server.registerTool()` with a Zod object schema:

```typescript
const QuerySchema = z.object({
  sql: z.string().min(1).describe("A read-only SQL query"),
});

server.registerTool(
  "queryDatabase",
  {
    description: "Execute a validated read-only PostgreSQL query.",
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
```

Registration functions accept `(server, env, props)`. Privileged tools require the trusted `database:write` permission claim, derived from the deployment-owned `DATABASE_WRITE_GITHUB_LOGINS` setting during OAuth authorization. Missing or malformed configuration grants no write access. A fresh server per request prevents concurrent principals from sharing a tool surface.

Current tools:

- `listTables`: authenticated users;
- `queryDatabase`: authenticated users, read-only;
- `executeDatabase`: explicit `database:write` claim only, rechecked in the handler.

`queryDatabase` requires a separate `READ_ONLY_DATABASE_URL` credential for a PostgreSQL read-only role and executes inside a `READ ONLY` transaction; it never falls back to `DATABASE_URL`. Lexical validation is defense in depth. Never attach raw SQL, query parameters, PostgreSQL error objects/messages/details, identity, email, application claims, tokens, or query results to console, breadcrumbs, traces, exceptions, or other telemetry. Emit only an allowlisted generic category/code signal and a generated event ID.

## OAuth security

The Worker acts as both an OAuth authorization server for MCP clients and an OAuth client of GitHub.

1. `/authorize` parses the provider request and requires the `mcp` scope; an empty scope is rejected.
2. Unapproved clients receive an escaped consent page.
3. Consent state is stored in `OAUTH_STATE`, bound to a distinct signed `__Host` cookie, and atomically consumed.
4. The upstream GitHub state uses an independent record and cookie.
5. `/callback` consumes state once, exchanges the code, fetches GitHub identity, and immediately discards the upstream access token.
6. `completeAuthorization()` receives minimal identity props only.

`Props` contract:

```typescript
type Props = {
  login: string;
  name: string;
  email?: string;
  permissions: Array<"database:write">;
};
```

Do not add credentials, authorization codes, refresh tokens, cookies, or raw provider responses.

## Storage and Wrangler

`OAUTH_KV` belongs to `workers-oauth-provider` grants and tokens. `OAUTH_STATE` is a SQLite Durable Object used only for application consent and upstream state.

The migration array is immutable deployment history:

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["MyMCP"] },
  { "tag": "v2", "new_sqlite_classes": ["OAuthStateStore"] }
]
```

The current bindings contain `OAUTH_STATE`, not the removed legacy `MCP_OBJECT`. Keep migration v1. Do not add `deleted_classes` as part of this local-only migration; remote class retirement requires a separate approved deployment plan.

Run Wrangler type generation after every config change. `worker-configuration.d.ts` is generated output and must not be hand-maintained.

## Sentry

`src/index_sentry.ts` uses Sentry 10's `withSentry()` wrapper and the same stateless auth boundary. Telemetry must never contain identity, email, application claims, OAuth tokens, raw SQL, parameters, query results, or raw database error objects/messages/details. Emit only allowlisted generic categories/codes and generated event IDs; do not duplicate failures into console breadcrumbs.

## Testing

Every behavior change requires a discriminating test. The MCP handler suite must cover:

- HTTP 401 and `cache-control: no-store` without valid props;
- `tools/list` for regular and privileged identities;
- `tools/call` input and permission boundaries;
- concurrent principal isolation;
- absent `/sse` route;
- unsupported HTTP methods.

OAuth tests must cover parallel flows, forged or replayed state, atomic one-time consume, expiry, and cleanup without storage recreation.

## Completion gate

Before claiming local completion, capture separate exit codes for:

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

`npm audit` and `npm ls` are dependency evidence, not substitutes for compilation or tests. Wrangler dry-run proves local configuration and bundling only; it does not prove a deployment, OAuth provider integration, or production behavior.
