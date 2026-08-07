# Production Deployment

The server can be hosted centrally so that multiple users in an organization share a single MCP endpoint. Each user
authenticates with their own identity — the server is stateless and does not store tokens.

There are two supported ways to obtain each user's Microsoft Graph token:

1. **Direct OAuth** (default): the MCP client performs OAuth 2.1 against Microsoft Entra through the server, and each
   Graph request carries a per-user Microsoft bearer token. Suitable for Docker / Azure / any generic host.
2. **Databricks Unity Catalog HTTP connection proxy** (Databricks Apps): the server never handles Microsoft tokens.
   It forwards each request through a Unity Catalog HTTP connection configured for Microsoft Graph with **OAuth
   User-to-Machine (U2M) Per User** credentials. Databricks injects the signed-in user's own Graph credentials. This
   is the recommended mode when hosting on Databricks Apps.

## Architecture

### Direct OAuth (Docker / generic host)

```
MCP Clients (Claude Desktop, Claude Code, Open WebUI, ...)
         │  Streamable HTTP + OAuth 2.1
         ▼
   ┌─────────────────────────────┐
   │  ms-365-mcp-server --http   │  Docker / any host
   │  (stateless, no token store)│
   └─────────────┬───────────────┘
                 │  Bearer token (per-user, Microsoft)
                 ▼
         Microsoft Graph API
```

### Unity Catalog proxy (Databricks Apps)

```
MCP Clients (Databricks AI Playground, Claude Code, Cursor, ...)
         │  Streamable HTTP (Databricks user identity)
         ▼
   ┌─────────────────────────────────────┐
   │  ms-365-mcp-server (Databricks App)  │
   │  --http $DATABRICKS_APP_PORT         │
   │  MS365_MCP_UC_CONNECTION=<conn>      │
   └─────────────┬───────────────────────┘
                 │  x-forwarded-access-token (Databricks user token)
                 ▼
   ┌─────────────────────────────────────┐
   │  Unity Catalog HTTP connection proxy │
   │  OAuth U2M Per User → Microsoft Graph│  injects each user's Graph credentials
   └─────────────┬───────────────────────┘
                 ▼
         Microsoft Graph API
```

In UC-proxy mode MSAL/OBO are bypassed entirely: no Azure app registration, client secret, or Key Vault is needed on
the server. Identity and token lifecycle are owned by the Unity Catalog connection.

---

# Databricks Apps deployment

This is the recommended deployment. The app runs the Node HTTP server; the Databricks Apps platform terminates TLS,
authenticates the user (SSO), and forwards the user's Databricks token to the app, which routes Graph calls through a
Unity Catalog HTTP connection.

## Prerequisites

- Databricks CLI ≥ 0.229 authenticated to the target workspace
  (`databricks auth login --host <workspace-url> --profile <profile>`).
- A Unity Catalog **HTTP connection to Microsoft Graph** with OAuth **U2M Per User** credentials
  (see [Unity Catalog connection setup](#unity-catalog-connection-setup) below). You can reuse the system-managed
  SharePoint connection or create your own with custom Graph scopes.
- Account-admin access (or someone who has it) to grant the `all-apis` OAuth scope on the app's integration
  (one-time, see [step 5](#5-grant-the-all-apis-scope-account-admin-one-time)).

## Repository configuration (already in this repo)

These are committed so the platform build works — listed here so you understand why:

- **`app.yaml`** — the app entry point and config:

  ```yaml
  command: ['node', 'dist/index.js', '-v', '--http', 'DATABRICKS_APP_PORT', '--read-only']

  user_authorization:
    scopes:
      - all-apis

  env:
    - name: 'NODE_ENV'
      value: 'production'
    - name: 'MS365_MCP_UC_CONNECTION'
      value: 'system_ai_agent_sharepoint'
  ```

  - `DATABRICKS_APP_PORT` is a literal token the platform substitutes with the real port at runtime; the server also
    reads `process.env.DATABRICKS_APP_PORT` and binds `0.0.0.0`.
  - `--read-only` matches the read-only Graph scopes on the SharePoint connection. Drop it if your connection grants
    write scopes.
  - `user_authorization.scopes: [all-apis]` makes the platform forward each user's token (see the scope note in
    [step 5](#5-grant-the-all-apis-scope-account-admin-one-time)).
  - `MS365_MCP_UC_CONNECTION` names the Unity Catalog connection and turns on proxy mode.

- **`src/generated/client.ts` is committed** (not gitignored) — the platform build runs only `npm run build`, not
  `npm run generate`, so the generated Graph client must be present or the app crashes at startup with
  `ERR_MODULE_NOT_FOUND`.
- **`tsup` is a runtime `dependency`** (not `devDependency`) — `NODE_ENV=production` skips dev dependencies, and the
  platform build needs `tsup`.

## Deploy

Replace `<profile>`, `<you@example.com>`, and the app name as needed. The app name **must start with `mcp-`** for the
Databricks AI Playground to auto-discover it as a custom MCP server.

```bash
# 1. Create the app (provisions compute; ~1-2 min)
databricks apps create mcp-m365-server \
  --description "Microsoft 365 MCP server via Unity Catalog HTTP connection proxy" \
  -p <profile>

# 2. Sync the source into the workspace
databricks sync . /Workspace/Users/<you@example.com>/mcp-m365-server -p <profile>

# 3. Deploy (platform runs `npm install` + `npm run build`, then starts app.yaml's command)
databricks apps deploy mcp-m365-server \
  --source-code-path /Workspace/Users/<you@example.com>/mcp-m365-server \
  -p <profile>

# 4. Get the app URL + status
databricks apps get mcp-m365-server -p <profile>
```

The app URL looks like `https://mcp-m365-server-<number>.<region>.databricksapps.com`. Its MCP endpoint is
`<app-url>/mcp`.

### 5. Grant the `all-apis` scope (account admin, one-time)

The Unity Catalog connection proxy is a non-SQL Databricks API and requires the broad `all-apis` OAuth scope on the
**forwarded user token**. The workspace `databricks apps update --json '{"user_api_scopes":[...]}'` API rejects
`all-apis`; it must be set on the account-level **Custom OAuth App Integration** instead. `app.yaml`'s
`user_authorization.scopes: [all-apis]` declares the intent, but an account admin applies it:

```bash
# Find the app's OAuth client id (== integration id)
databricks apps get mcp-m365-server -p <profile> \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['oauth2_app_client_id'])"

# Log in to the ACCOUNT console (not the workspace)
databricks auth login --host https://accounts.cloud.databricks.com --account-id <account-id> --profile <account-profile>

# Read the integration's current scopes
databricks account custom-app-integration get <client-id> -p <account-profile>

# The update OVERWRITES scopes — include the existing ones plus all-apis
databricks account custom-app-integration update <client-id> -p <account-profile> --json '{
  "scopes": ["offline_access","email","iam.current-user:read","openid","iam.access-control:read","profile","all-apis"]
}'

# (Recommended) pre-consent for all users so they are not prompted on first use
databricks account custom-app-integration update <client-id> -p <account-profile> --json '{
  "user_authorized_scopes": ["all-apis"]
}'
```

If you previously opened the app in a browser, clear its cookie (or use an incognito window) so the new scopes are
picked up.

> **Scoping down later**: `all-apis` is broad. Narrower scopes (e.g. `catalog.connections`) are currently rejected by
> the connection-proxy endpoint, so `all-apis` is required today. Revisit once Databricks accepts a narrower grant for
> the proxy.

### 6. Verify

```bash
# App is running
databricks apps get mcp-m365-server -p <profile> | grep -A1 compute_status

# Health check (requires a Databricks token for the app's SSO)
TOKEN=$(databricks auth token -p <profile> | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s -H "Authorization: Bearer $TOKEN" https://<app-url>/     # -> "Microsoft 365 MCP Server is running"

# End-to-end: call a tool through the proxy
curl -s -X POST https://<app-url>/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get-current-user","arguments":{}}}'
```

Logs are at `<app-url>/logz` or via `databricks apps logs mcp-m365-server -p <profile>`.

> **Turnkey example**: see [`examples/databricks-apps/`](../examples/databricks-apps/) for a copy-paste deploy script.

## Unity Catalog connection setup

The app talks to Microsoft Graph through a Unity Catalog HTTP connection with `credential_type = OAUTH_U2M_MAPPING`
(OAuth User-to-Machine, Per User). Point the connection at `https://graph.microsoft.com`; the server appends the Graph
path so `MS365_MCP_UC_CONNECTION`'s proxy resolves `/proxy/v1.0/me` → `https://graph.microsoft.com/v1.0/me`.

### Option A — reuse the system-managed SharePoint connection

Many workspaces already have `system_ai_agent_sharepoint`, a system-managed connection to `graph.microsoft.com` with a
broad set of **read** Graph delegated scopes (User.Read, Mail.Read, Calendars.Read, Files.Read, Sites.Read.All,
Teams/chat/meeting reads, …). Verify it exists and is active:

```bash
databricks connections get system_ai_agent_sharepoint -p <profile>
```

If present, set `MS365_MCP_UC_CONNECTION=system_ai_agent_sharepoint` in `app.yaml` (the repo default) and run the
server `--read-only` since the connection has no write scopes. This is the fastest path and needs no Azure setup.

### Option B — create your own connection with custom Graph scopes

Create a dedicated Azure app registration when you need specific (or write) Graph scopes, or a specific tenant.

1. **Azure app registration** (Microsoft Entra admin center → App registrations → New registration):
   - Supported account types: single tenant (or as required).
   - Add a **Web** redirect URI: `https://<workspace-host>/login/oauth/http.html` (the Databricks connection callback).
   - API permissions → Microsoft Graph → **Delegated permissions** → add the scopes you want (e.g. `User.Read`,
     `Mail.ReadWrite`, `Calendars.ReadWrite`, `Files.ReadWrite.All`). Run
     `npx @softeria/ms-365-mcp-server --org-mode --list-permissions` to see what the enabled tools need.
   - Grant admin consent.
   - Certificates & secrets → new client secret.

2. **Store the client secret** in a Databricks secret scope:

   ```bash
   databricks secrets create-scope ms365-graph -p <profile>
   databricks secrets put-secret ms365-graph client-secret --string-value '<azure-app-client-secret>' -p <profile>
   ```

3. **Create the Unity Catalog HTTP connection** (SQL editor or any warehouse):

   ```sql
   CREATE CONNECTION ms365_graph TYPE HTTP
   OPTIONS (
     host 'https://graph.microsoft.com',
     port '443',
     base_path '/',
     client_id '<azure-app-client-id>',
     client_secret secret('ms365-graph','client-secret'),
     oauth_scope 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Calendars.ReadWrite offline_access openid profile email',
     authorization_endpoint 'https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize',
     token_endpoint 'https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token',
     oauth_credential_exchange_method 'header_and_body'
   );
   ```

   Use `common` for `<tenant-id>` for multi-tenant apps. Include `offline_access` so refresh tokens are issued.

4. **Grant `USE CONNECTION`** to the users who will call the app:

   ```sql
   GRANT USE CONNECTION ON CONNECTION ms365_graph TO `account users`;
   ```

5. Set `MS365_MCP_UC_CONNECTION=ms365_graph` in `app.yaml`. Drop `--read-only` if you granted write scopes.

> Each user consents to their own Graph access on first use (U2M Per User), and Databricks stores per-user tokens. The
> MCP server never sees a Microsoft token — only the Databricks user token used to reach the proxy.

---

# Direct OAuth deployment (Docker / generic host)

Use this when hosting outside Databricks. Here the server performs OAuth against Microsoft Entra and each Graph request
carries a per-user Microsoft bearer token. This requires an Azure app registration (see
[Azure AD App Registration](#azure-ad-app-registration-for-organizations)).

## Headless stdio auth-cache storage

Production HTTP deployments are stateless: normal Graph requests carry a per-user bearer token, including On-Behalf-Of
(`--obo`) deployments, and the server does not store MSAL token state for those requests.

For headless stdio deployments that use local MSAL login (`--login`, `--verify-login`, auth tools, account selection,
and regular stdio Graph calls), `MS365_MCP_AUTH_CACHE_COMMAND` can point at an external executable wrapper that stores
the MSAL token cache and selected-account metadata in a deployment-approved backing store. The package only defines the
provider-neutral command protocol; provider-specific scripts for AWS, Azure, GCP, Redis, databases, or other stores
live outside this package.

In HTTP mode, `MS365_MCP_AUTH_CACHE_COMMAND` is skipped at startup and per Graph request unless local auth tools are
explicitly enabled with `--enable-auth-tools` or a local account command such as `--login`, `--verify-login`,
`--list-accounts`, `--select-account`, `--remove-account`, or `--logout` is invoked.

## Docker

A `Dockerfile` is included for containerized deployments:

```bash
# Build the image
docker build -t ms-365-mcp-server .

# Run with environment variables
docker run -p 3000:3000 \
  -e MS365_MCP_CLIENT_ID=your-client-id \
  -e MS365_MCP_TENANT_ID=your-tenant-id \
  -e MS365_MCP_CLIENT_SECRET=your-secret \
  -e MS365_MCP_ORG_MODE=true \
  ms-365-mcp-server \
  --http 3000 --org-mode
```

For production, use Azure Key Vault instead of environment variables for secrets (see
[Azure Key Vault Integration](../README.md#azure-key-vault-integration)):

```bash
docker run -p 3000:3000 \
  -e MS365_MCP_KEYVAULT_URL=https://your-keyvault.vault.azure.net \
  -e MS365_MCP_ORG_MODE=true \
  -e MS365_MCP_PUBLIC_URL=https://mcp.example.com \
  ms-365-mcp-server \
  --http 3000 --org-mode
```

## Azure AD App Registration (for organizations)

Only needed for **Direct OAuth** deployments (not the UC-proxy Databricks Apps mode). When deploying for an
organization, create a dedicated app registration instead of using the built-in client ID:

1. **Create the app** in [Azure Portal](https://portal.azure.com) > App registrations > New registration
   - Name: `MS365 MCP Server`
   - Supported account types: **Accounts in this organizational directory only** (single tenant)
   - Redirect URI (platform type **Web**): the **MCP client's** OAuth callback URL, not the server's own domain. The
     server proxies the OAuth flow and forwards the client's `redirect_uri` to Microsoft Entra, so Entra delivers the
     authorization code directly to the client. Register one redirect URI per MCP client you want to support, for
     example:
     - Claude (claude.ai, Desktop, Cowork): `https://claude.ai/api/mcp/auth_callback`
     - Other clients: check the `redirect_uri` query parameter your client sends to the server's `/authorize` endpoint
       (visible in the server logs)

   > **Common pitfall**: registering `https://your-server-domain/callback` here breaks sign-in with `AADSTS50011`
   > (redirect URI mismatch) after the user authenticates. The server has no callback endpoint of its own; the
   > authorization code always goes to the MCP client. Note that platform type **Web** applies because this setup uses
   > a client secret; an app without a secret must register the redirect URI under "Mobile and desktop applications"
   > instead.

2. **Add API permissions** > Microsoft Graph > Delegated permissions
   Run `npx @softeria/ms-365-mcp-server --org-mode --list-permissions` to print the exact list of permissions required
   for your enabled tools.

3. **Grant admin consent** to skip per-user consent prompts:

   ```bash
   az ad app permission admin-consent --id your-app-client-id
   ```

4. **Create a client secret** under Certificates & secrets, then store it in Key Vault

5. **Store credentials** in Key Vault (see [Azure Key Vault Integration](../README.md#azure-key-vault-integration))

## Redirect URI Validation

The /authorize endpoint defensively validates client-supplied `redirect_uri` values before forwarding them to
Microsoft Entra (CWE-601, Open Redirect). Microsoft Entra also validates the URI against your app registration, but
this server-side check rejects obviously dangerous schemes (`javascript:`, `data:`, `file:`, …) and arbitrary remote
`http://` origins before the request leaves the server.

Default behaviour (no explicit allowlist):

- Only `http:` and `https:` schemes are accepted.
- `http:` is only allowed for loopback hosts (`localhost`, `127.0.0.1`, `::1`).
- All other `https://` origins are accepted (Entra still has the final say).

For production deployments, configure an explicit allowlist via the `MS365_MCP_ALLOWED_REDIRECT_URIS` environment
variable. It takes a comma-separated list of exact URIs; only exact string matches pass validation:

```bash
# Single redirect URI
MS365_MCP_ALLOWED_REDIRECT_URIS=https://mcp.example.com/auth/callback

# Multiple URIs (comma-separated, no spaces required)
MS365_MCP_ALLOWED_REDIRECT_URIS=https://mcp.example.com/auth/callback,https://staging.example.com/auth/callback
```

The list should mirror the redirect URIs registered on your Azure AD app registration. Leaving the variable unset falls
back to the default behaviour above, which is appropriate for local development but not recommended for
shared/production deployments.

## Reverse Proxy / Custom Domain

When running behind a reverse proxy, set `MS365_MCP_PUBLIC_URL` so that the OAuth authorize URL handed back to the
user's browser is resolvable from outside the server's network:

```bash
# Via environment variable
MS365_MCP_PUBLIC_URL=https://mcp.example.com

# Or via CLI flag
--public-url https://mcp.example.com
```

Only browser-facing fields (`issuer`, `authorization_endpoint`, `authorization_servers`) are pinned to this URL.
Server-to-server endpoints (`token_endpoint`, `registration_endpoint`, `resource`) stay on the request origin, so
clients that reach the server over an internal network (e.g. another container on the same Docker network) don't have
to round-trip back through the public URL.

---

## Client Configuration

See the root [`README-databricks-apps.md`](../README-databricks-apps.md) for consuming a Databricks-Apps-hosted server
from the AI Playground, Cursor, and Claude Code.

For a **Direct OAuth** deployment, users point their MCP client at the server URL and the client discovers OAuth
endpoints automatically:

**Claude Desktop:**

```json
{
  "mcpServers": {
    "ms365": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add ms365 --transport http https://mcp.example.com/mcp
```

The client automatically discovers OAuth endpoints and opens a browser for authentication on first use.

## Security Considerations

- **Stateless**: the server does not store tokens — each request carries the user's Bearer token (Microsoft in direct
  mode, Databricks in UC-proxy mode)
- **Unity Catalog governance** (UC-proxy mode): per-user Graph credentials, `USE CONNECTION` grants, and connection
  scopes are all managed and audited by Unity Catalog; the app holds no Microsoft secret
- **Account pinning**: `MS365_MCP_EXPECTED_USERNAME` and `MS365_MCP_EXPECTED_HOME_ACCOUNT_ID` protect local MSAL cache
  flows for headless stdio deployments. In `--http`, `--obo`, UC-proxy, or `MS365_MCP_OAUTH_TOKEN` deployments they are
  warning-only because Graph calls use request-provided tokens.
- **Admin consent**: grant tenant-wide consent to avoid per-user consent prompts
- **Managed identity**: use managed identity for Key Vault access (no secrets in environment variables)
- **Read-only mode**: use `--read-only` to disable all write operations (send, delete, update, create)
- **Tool filtering**: use `--enabled-tools <regex>` or `--preset <names>` to restrict available tools
- **CORS**: configure `MS365_MCP_CORS_ORIGIN` to restrict allowed origins (defaults to `http://localhost:3000`); set
  explicitly when clients run on a different origin
- **Disable Dynamic Client Registration**: when only a known client talks to the server, set
  `MS365_MCP_DISABLE_DCR=true` (or pass `--no-dynamic-registration`) to close the anonymous `/register` endpoint
- **Structured audit log**: enabled by default. Every tool invocation emits one JSON line on stderr (captured by the
  container platform's log collector) and to `~/.ms-365-mcp-server/logs/audit.log` (mode `0o600`) with
  `{ event, request_id, user_principal_name, tool, http_method, status, duration_ms, target_resource?, error_type?, error_code? }`.
  When an audited generated Microsoft Graph tool targets a derivable resource through an ID-like path parameter such as
  `{message-id}` or `{driveItem-id}`, `target_resource` is `{ type, id }`, where `id` is the Graph path up to that
  resource ID. Later path parameters such as `{path}`, query values, tool parameters, returned content, and Graph
  response bodies are NEVER recorded, and error messages are reduced to `error_type` / `error_code` so upstream library
  errors do not leak token fragments or query-string PII. Forms the "who accessed what, when" trail required for GDPR /
  HIPAA / PIPEDA / SOC 2 audit. Opt-out: `MS365_MCP_AUDIT_LOG=false`
- **Graph resilience**: every call to Microsoft Graph is wrapped with a fetch timeout (default 100 s via
  `MS365_MCP_GRAPH_TIMEOUT_MS`), retry-with-backoff on 429 / 503 / 504 / network errors (default 3 retries, full-jitter
  exponential backoff, honours `Retry-After`; 503 / 504 / network errors only retried for idempotent methods, 429
  retried on all methods), and a process-wide circuit breaker that opens after 5 consecutive failures and cools down
  for 30 s (`MS365_MCP_GRAPH_CIRCUIT_THRESHOLD` / `MS365_MCP_GRAPH_CIRCUIT_COOLDOWN_MS`). Disable the breaker for
  trusted automation: `MS365_MCP_GRAPH_CIRCUIT_DISABLED=true`
- **Confirm gate on destructive tools**: opt-in, **off by default**. Enable with `MS365_MCP_REQUIRE_CONFIRM=true`. When
  on, destructive tools (POST except `readOnly`, PATCH, PUT, DELETE — `delete-mail-message`, `send-mail`,
  `update-event`, etc.) return `{ "error": "confirmation_required" }` until the caller re-invokes them with
  `"confirm": true`. Mitigates accidental writes when an LLM misroutes a request or follows an injected instruction.
  Shipped opt-in so it is a non-breaking, additive layer that can coexist with client-side elicitation prompts (MCP
  Elicitation API) where the client supports them.

## Exposed Endpoints

| Path                                      | Method   | Description                     | Auth Required |
| ----------------------------------------- | -------- | ------------------------------- | ------------- |
| `/`                                       | GET      | Health check                    | No            |
| `/mcp`, `/mcp/mcp`                        | GET/POST | MCP protocol endpoint           | Bearer token  |
| `/authorize`                              | GET      | OAuth — redirect to Microsoft   | No            |
| `/token`                                  | POST     | OAuth — code exchange / refresh | No            |
| `/register`                               | POST     | OAuth — dynamic registration    | No            |
| `/.well-known/oauth-authorization-server` | GET      | OAuth server metadata           | No            |
| `/.well-known/oauth-protected-resource`   | GET      | Protected resource metadata     | No            |

> `/mcp/mcp` is an alias of `/mcp`: when a Databricks App is registered as a custom MCP server, the platform appends
> `/mcp` to the app's MCP path and posts to `/mcp/mcp`. Both paths serve the same handler.
