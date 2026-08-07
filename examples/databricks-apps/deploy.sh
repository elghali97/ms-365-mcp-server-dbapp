#!/usr/bin/env bash
#
# Create + sync + deploy ms-365-mcp-server to Databricks Apps.
#
# Usage:
#   ./deploy.sh --profile <workspace-profile> --user <you@example.com> \
#               [--app mcp-m365-server] [--connection system_ai_agent_sharepoint]
#
# The app name must start with "mcp-" so the Databricks AI Playground
# auto-discovers it as a custom MCP server.
#
# Run from the repository root (the directory that contains app.yaml).
# After the first deploy, an account admin must grant the `all-apis` scope on the
# app's account-level Custom OAuth App Integration — see this example's README.

set -euo pipefail

APP="mcp-m365-server"
CONNECTION="system_ai_agent_sharepoint"
PROFILE=""
USER_EMAIL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --user) USER_EMAIL="$2"; shift 2 ;;
    --app) APP="$2"; shift 2 ;;
    --connection) CONNECTION="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PROFILE" || -z "$USER_EMAIL" ]]; then
  echo "Usage: $0 --profile <workspace-profile> --user <you@example.com> [--app <name>] [--connection <name>]" >&2
  exit 1
fi

if [[ "$APP" != mcp-* ]]; then
  echo "Warning: app name '$APP' does not start with 'mcp-'; the AI Playground will not auto-discover it." >&2
fi

if [[ ! -f app.yaml ]]; then
  echo "app.yaml not found. Run this script from the repository root." >&2
  exit 1
fi

WORKSPACE_PATH="/Workspace/Users/${USER_EMAIL}/${APP}"

echo ">> Ensuring app '$APP' exists..."
if ! databricks apps get "$APP" -p "$PROFILE" >/dev/null 2>&1; then
  databricks apps create "$APP" \
    --description "Microsoft 365 MCP server via Unity Catalog HTTP connection proxy" \
    -p "$PROFILE"
else
  echo "   (already exists)"
fi

echo ">> Syncing source to $WORKSPACE_PATH ..."
databricks sync . "$WORKSPACE_PATH" -p "$PROFILE"

echo ">> Deploying (platform runs npm install + npm run build) ..."
databricks apps deploy "$APP" --source-code-path "$WORKSPACE_PATH" -p "$PROFILE"

echo ">> Done. App details:"
databricks apps get "$APP" -p "$PROFILE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('  url:        ', d.get('url'))
print('  compute:    ', d.get('compute_status', {}).get('state'))
print('  oauth_client:', d.get('oauth2_app_client_id'))
print()
print('  MCP endpoint:', (d.get('url') or '') + '/mcp')
print('  Using UC connection: ${CONNECTION}')
print()
print('  Next: grant the all-apis scope on the account integration (see README).')
"
