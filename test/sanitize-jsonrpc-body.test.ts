import { describe, expect, it } from 'vitest';
import { sanitizeJsonRpcBody } from '../src/server.js';

describe('sanitizeJsonRpcBody', () => {
  it('strips non-JSON-RPC top-level fields the Databricks playground injects', () => {
    const playgroundInitialize = {
      jsonrpc: '2.0',
      id: 1786092969,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'databricks-playground-client', version: '1.0' },
        name: null,
        arguments: null,
        cursor: null,
        uri: null,
        _meta: null,
      },
      catalog: null,
      schema: null,
      functionName: null,
      indexName: null,
      genieSpaceId: null,
      connectionName: null,
      repoId: null,
      workspacePath: null,
    };

    expect(sanitizeJsonRpcBody(playgroundInitialize)).toEqual({
      jsonrpc: '2.0',
      id: 1786092969,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'databricks-playground-client', version: '1.0' },
      },
    });
  });

  it('drops null-valued params keys (reserved _meta/cursor/uri) on any method', () => {
    const toolsList = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: { name: null, arguments: null, cursor: null, uri: null, _meta: null },
      catalog: null,
    };
    expect(sanitizeJsonRpcBody(toolsList)).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
  });

  it('preserves real non-null params such as a tool call name/arguments', () => {
    const toolCall = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get-current-user', arguments: {}, cursor: null, _meta: null },
    };
    expect(sanitizeJsonRpcBody(toolCall)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get-current-user', arguments: {} },
    });
  });

  it('keeps nested null values inside a preserved params object (only top-level params nulls are dropped)', () => {
    const call = {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'send-mail', arguments: { subject: 'hi', cc: null } },
    };
    expect(sanitizeJsonRpcBody(call)).toEqual({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'send-mail', arguments: { subject: 'hi', cc: null } },
    });
  });

  it('leaves a clean, spec-compliant message unchanged', () => {
    const clean = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c' } },
    };
    expect(sanitizeJsonRpcBody(clean)).toEqual(clean);
  });

  it('applies element-wise to a batch', () => {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: null }, catalog: null },
      { jsonrpc: '2.0', id: 2, method: 'ping', params: {} },
    ];
    expect(sanitizeJsonRpcBody(batch)).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'ping', params: {} },
    ]);
  });

  it('leaves non-object bodies untouched', () => {
    expect(sanitizeJsonRpcBody(null)).toBeNull();
    expect(sanitizeJsonRpcBody('not-json')).toBe('not-json');
    expect(sanitizeJsonRpcBody(42)).toBe(42);
  });
});
