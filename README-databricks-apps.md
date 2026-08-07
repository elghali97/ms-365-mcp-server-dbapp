# Consuming the Microsoft 365 MCP server (Databricks Apps)

This guide covers how to **use** a `ms-365-mcp-server` instance that is deployed as a **Databricks App** with the Unity
Catalog HTTP connection proxy. To deploy it, see [`docs/deployment.md`](docs/deployment.md) and
[`examples/databricks-apps/`](examples/databricks-apps/).

In this mode the server exposes Microsoft Graph as MCP tools (mail, calendar, files, Teams, users, …) and each user
acts with **their own** Microsoft identity — resolved by the Unity Catalog connection, not stored by the app.

## What you need

- The app's URL, e.g. `https://mcp-m365-server-<number>.<region>.databricksapps.com`. Its MCP endpoint is
  `<app-url>/mcp`.
- **`USE CONNECTION`** on the underlying Unity Catalog Graph connection (ask the deployer if unsure).
- The first time you use it, you consent to Microsoft Graph access for your own account.

The app is read-only by default (only Graph read tools are exposed).

---

## From the Databricks AI Playground

The Playground runs in the same workspace and forwards your Databricks identity automatically — no tokens to copy.

1. Make sure the app is deployed in **the same workspace** and its name starts with `mcp-` (e.g. `mcp-m365-server`).
2. Open **AI → Playground** and pick a model with **Tools enabled**.
3. **Tools → + Add tool → MCP servers → Custom MCP Server**, then select your `mcp-…` app from the list.
4. The Playground fetches the tool catalog. Ask something that triggers a tool, e.g. _"What's my Microsoft 365
   profile?"_ (calls `get-current-user`) or _"List my 5 most recent emails."_

If the app does not appear: confirm it is running (`databricks apps get <app>`), its name starts with `mcp-`, and it is
in the current workspace.

---

## From Claude Code

Claude Code connects to the app over Streamable HTTP. Because the app is protected by Databricks SSO, pass a Databricks
OAuth token as a bearer header.

Get a token for the workspace that hosts the app:

```bash
databricks auth token -p <profile> | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])"
```

Add the server (note the `/mcp` suffix):

```bash
claude mcp add ms365 \
  --transport http \
  https://mcp-m365-server-<number>.<region>.databricksapps.com/mcp \
  --header "Authorization: Bearer <databricks-token>"
```

Then in Claude Code: `/mcp` to confirm it connected, and ask it to use an `ms365` tool.

> Databricks OAuth tokens are short-lived. When the token expires, re-run `databricks auth token` and update the
> header (`claude mcp remove ms365` then re-add, or edit `~/.claude.json`). For a longer-lived setup, use the AI
> Playground (no token handling) or a Databricks external-MCP proxy registration (below).

---

## From Cursor

Cursor reads MCP servers from `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project). Add an HTTP server
with the bearer header:

```json
{
  "mcpServers": {
    "ms365": {
      "url": "https://mcp-m365-server-<number>.<region>.databricksapps.com/mcp",
      "headers": {
        "Authorization": "Bearer <databricks-token>"
      }
    }
  }
}
```

Get `<databricks-token>` with:

```bash
databricks auth token -p <profile> | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])"
```

Reload Cursor (or toggle the server in **Settings → MCP**). The `ms365` tools appear in the Agent tool list.

> As with Claude Code, the token is short-lived; refresh it when calls start returning `401`.

---

## Optional: register as a governed external MCP (stable URL, no token juggling)

Instead of each client carrying a Databricks token, an admin can register the app as an **external MCP** through Unity
Catalog / AI Gateway. Clients then call a stable workspace proxy URL and the Gateway handles auth:

```
https://<workspace-host>/api/2.0/mcp/external/<connection-name>
```

This is the most robust option for shared use. See the Databricks docs for _Register an external MCP server_. Point
such a registration at `<app-url>/mcp`.

---

## Available tools

Run against the endpoint to list tools, or just ask the client "what tools do you have from ms365?". The catalog
mirrors the Microsoft Graph surface the server exposes for your mode (read-only by default): user profile, mail,
calendar, OneDrive/SharePoint files, Teams chats/channels, users directory, and more. Work/school-only tools require
the server to run with `--org-mode`.

## Troubleshooting

| Symptom                                             | Cause / fix                                                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` from the app                                  | Databricks token missing/expired — refresh it (`databricks auth token`).                                                                            |
| `403 ... required scopes: all-apis`                 | The app's account integration is missing the `all-apis` scope — an account admin must grant it (see deployment guide).                              |
| `USE CONNECTION` / permission denied from the proxy | You lack `USE CONNECTION` on the UC Graph connection — ask the deployer to grant it.                                                                |
| Tool call returns a Microsoft Graph `403`           | The connection's Graph scopes don't cover that call (e.g. a write on a read-only connection), or you haven't consented — re-consent / widen scopes. |
| App not listed in the AI Playground                 | App name must start with `mcp-`, be running, and live in the same workspace.                                                                        |
| `-32700 Parse error` from a client                  | Use a server build that includes the request-body sanitizer (this repo); older builds reject the playground's request shape.                        |
