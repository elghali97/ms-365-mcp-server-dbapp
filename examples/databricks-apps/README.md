# Databricks Apps deployment example

> **Community-contributed example.** Adapt names, workspace, and scopes to your environment before production use. See
> [`docs/deployment.md`](../../docs/deployment.md) for the full guide and the root
> [README's "Deploy on Databricks Apps"](../../README.md#deploy-on-databricks-apps) section for how clients consume the
> deployed server.

Deploys `ms-365-mcp-server` to **Databricks Apps** in Streamable HTTP mode. Microsoft Graph calls are routed through a
Unity Catalog HTTP connection (OAuth **U2M Per User**), so the app never handles Microsoft tokens and MSAL/OBO are
bypassed. Each user's own Graph credentials are injected by Unity Catalog.

## Contents

- `deploy.sh` — one-command create + sync + deploy wrapper around the Databricks CLI.

## Prerequisites

- Databricks CLI ≥ 0.229 authenticated: `databricks auth login --host <workspace-url> --profile <profile>`
- A Unity Catalog HTTP connection to `https://graph.microsoft.com` with `credential_type = OAUTH_U2M_MAPPING`. Reuse
  the system-managed `system_ai_agent_sharepoint` or create your own — see
  [Unity Catalog connection setup](../../docs/deployment.md#unity-catalog-connection-setup).
- Account admin to grant the `all-apis` scope once (see below).

## Deploy

```bash
./deploy.sh \
  --profile <workspace-profile> \
  --user <you@example.com> \
  --app mcp-m365-server \
  --connection system_ai_agent_sharepoint
```

The app name must start with `mcp-` so the Databricks AI Playground auto-discovers it as a custom MCP server.

## One-time account-admin scope grant

The UC connection proxy requires the `all-apis` scope on the app's account-level Custom OAuth App Integration. After
the first deploy:

```bash
CLIENT_ID=$(databricks apps get mcp-m365-server -p <workspace-profile> \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['oauth2_app_client_id'])")

databricks auth login --host https://accounts.cloud.databricks.com --account-id <account-id> --profile <account-profile>

databricks account custom-app-integration update "$CLIENT_ID" -p <account-profile> --json '{
  "scopes": ["offline_access","email","iam.current-user:read","openid","iam.access-control:read","profile","all-apis"],
  "user_authorized_scopes": ["all-apis"]
}'
```

See [`docs/deployment.md`](../../docs/deployment.md#5-grant-the-all-apis-scope-account-admin-one-time) for the full
explanation.

## Configuration

The deployed behaviour is defined by the repo-root [`app.yaml`](../../app.yaml):

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

To use a different connection, change `MS365_MCP_UC_CONNECTION`. To allow writes, drop `--read-only` (and make sure the
connection grants write Graph scopes).
