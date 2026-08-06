/**
 * Unity Catalog HTTP Connection proxy mode.
 *
 * When enabled, Microsoft Graph requests are not sent directly to
 * graph.microsoft.com with a Microsoft access token. Instead they are routed
 * through a Databricks Unity Catalog HTTP connection configured for Microsoft
 * Graph with OAuth "User to Machine (U2M) Per User" credentials:
 *
 *   https://<workspace-host>/api/2.0/unity-catalog/connections/<name>/proxy/<graph-path>
 *
 * The caller authenticates to the proxy with a *Databricks* user token (not a
 * Microsoft token). The connection resolves that user's own stored Microsoft
 * Graph credentials, strips the inbound Authorization header, injects the user's
 * Graph token, and forwards the request to Graph. This means the MCP server never
 * handles Microsoft tokens in this mode — MSAL/OBO are fully bypassed.
 *
 * Docs: https://docs.databricks.com/aws/en/query-federation/http#forward-requests-through-the-http-connection-proxy
 */

/** Env var holding the UC HTTP connection name. Presence of a value enables the mode. */
const UC_CONNECTION_ENV = 'MS365_MCP_UC_CONNECTION';

/**
 * Env var holding the Databricks user token to authenticate to the proxy when a
 * per-request token is not available (local testing outside a Databricks App).
 * In a deployed Databricks App with user authorization the token instead arrives
 * per request via the x-forwarded-access-token header, which takes precedence.
 */
const UC_TOKEN_ENV = 'DATABRICKS_TOKEN';

export interface UcConnectionConfig {
  /** Unity Catalog HTTP connection name (e.g. "system_ai_agent_sharepoint"). */
  connectionName: string;
  /** Databricks workspace base URL, no trailing slash (e.g. "https://x.cloud.databricks.com"). */
  workspaceHost: string;
  /** Fallback Databricks user token for the proxy when no per-request token is set. */
  fallbackToken?: string;
}

/**
 * Normalizes the Databricks workspace host into a scheme-qualified origin with no
 * trailing slash. In a Databricks App, DATABRICKS_HOST is just a hostname (no
 * scheme); elsewhere it may already include https://.
 */
export function normalizeWorkspaceHost(raw: string): string {
  let host = raw.trim();
  if (!host) {
    return host;
  }
  if (!/^https?:\/\//i.test(host)) {
    host = `https://${host}`;
  }
  return host.replace(/\/$/, '');
}

/**
 * Reads UC connection configuration from the environment. Returns null when the
 * mode is not enabled (no connection name set), so existing MSAL/OAuth paths are
 * untouched. Throws when the connection name is set but the workspace host cannot
 * be resolved — a misconfiguration that would otherwise fail opaquely per request.
 */
export function getUcConnectionConfig(): UcConnectionConfig | null {
  const connectionName = process.env[UC_CONNECTION_ENV]?.trim();
  if (!connectionName) {
    return null;
  }

  const rawHost = process.env.DATABRICKS_HOST?.trim();
  if (!rawHost) {
    throw new Error(
      `${UC_CONNECTION_ENV}=${connectionName} enables Unity Catalog proxy mode, but DATABRICKS_HOST ` +
        `is not set. It is auto-injected inside a Databricks App; set it manually for local runs.`
    );
  }

  return {
    connectionName,
    workspaceHost: normalizeWorkspaceHost(rawHost),
    fallbackToken: process.env[UC_TOKEN_ENV]?.trim() || undefined,
  };
}

/**
 * Builds the full UC proxy URL for a Graph request path. The graphPath is the
 * portion after the Graph version segment already assembled by the caller,
 * e.g. "/v1.0/me". The connection's own host + base_path are combined with this
 * sub-path by the proxy to form the final graph.microsoft.com URL.
 */
export function buildUcProxyUrl(config: UcConnectionConfig, graphPath: string): string {
  const path = graphPath.startsWith('/') ? graphPath : `/${graphPath}`;
  return `${config.workspaceHost}/api/2.0/unity-catalog/connections/${config.connectionName}/proxy${path}`;
}
