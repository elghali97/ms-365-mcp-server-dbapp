import { afterEach, describe, expect, it } from 'vitest';
import {
  buildUcProxyUrl,
  getUcConnectionConfig,
  normalizeWorkspaceHost,
} from '../src/uc-connection.js';

const ENV_KEYS = ['MS365_MCP_UC_CONNECTION', 'DATABRICKS_HOST', 'DATABRICKS_TOKEN'] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  clearEnv();
});

describe('normalizeWorkspaceHost', () => {
  it('adds https:// when scheme is missing (Databricks App DATABRICKS_HOST)', () => {
    expect(normalizeWorkspaceHost('e2-demo.cloud.databricks.com')).toBe(
      'https://e2-demo.cloud.databricks.com'
    );
  });

  it('preserves an existing scheme and strips a trailing slash', () => {
    expect(normalizeWorkspaceHost('https://e2-demo.cloud.databricks.com/')).toBe(
      'https://e2-demo.cloud.databricks.com'
    );
  });
});

describe('getUcConnectionConfig', () => {
  it('returns null when the connection name is not set (mode disabled)', () => {
    clearEnv();
    expect(getUcConnectionConfig()).toBeNull();
  });

  it('resolves connection name, host, and fallback token when configured', () => {
    clearEnv();
    process.env.MS365_MCP_UC_CONNECTION = 'system_ai_agent_sharepoint';
    process.env.DATABRICKS_HOST = 'e2-demo.cloud.databricks.com';
    process.env.DATABRICKS_TOKEN = 'dapiXXXX';

    expect(getUcConnectionConfig()).toEqual({
      connectionName: 'system_ai_agent_sharepoint',
      workspaceHost: 'https://e2-demo.cloud.databricks.com',
      fallbackToken: 'dapiXXXX',
    });
  });

  it('throws when the connection is set but DATABRICKS_HOST is missing', () => {
    clearEnv();
    process.env.MS365_MCP_UC_CONNECTION = 'system_ai_agent_sharepoint';
    expect(() => getUcConnectionConfig()).toThrow(/DATABRICKS_HOST/);
  });
});

describe('buildUcProxyUrl', () => {
  const config = {
    connectionName: 'system_ai_agent_sharepoint',
    workspaceHost: 'https://e2-demo.cloud.databricks.com',
  };

  it('builds the proxy URL for a Graph path', () => {
    expect(buildUcProxyUrl(config, '/v1.0/me')).toBe(
      'https://e2-demo.cloud.databricks.com/api/2.0/unity-catalog/connections/system_ai_agent_sharepoint/proxy/v1.0/me'
    );
  });

  it('tolerates a path missing its leading slash', () => {
    expect(buildUcProxyUrl(config, 'v1.0/me')).toBe(
      'https://e2-demo.cloud.databricks.com/api/2.0/unity-catalog/connections/system_ai_agent_sharepoint/proxy/v1.0/me'
    );
  });
});
