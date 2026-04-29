/**
 * ConfigurableConnector tests.
 *
 * Tests the JSON-defined connector: definition validation, template
 * interpolation, pagination, content mapping, and directory loading.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigurableConnector, ConnectorDefinitionSchema } from '../src/connectors/configurable.js';
import { loadConnectorsFromDir, validateDefinition } from '../src/connectors/config-loader.js';
import type { ConnectorDefinition } from '../src/connectors/configurable.js';

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'brain-config-conn-test-'));
});

afterAll(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────

function makeDefinition(overrides?: Partial<ConnectorDefinition>): ConnectorDefinition {
  return {
    id: 'test-api',
    name: 'Test API',
    url: 'https://api.example.com/v1/items',
    auth: { type: 'bearer', value: '{{token}}' },
    records: 'data',
    sourceType: 'test_item',
    ...overrides,
  };
}

function createConnectorWithMockedFetch(def: ConnectorDefinition) {
  const connector = new ConfigurableConnector(def);
  const fetchMock = vi.fn();

  // Replace the private rateLimitedFetch
  (connector as any).rateLimitedFetch = fetchMock;
  // Also set lastRequestAt to avoid wait
  (connector as any).lastRequestAt = 0;

  return { connector, fetchMock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(),
  } as Response;
}

// ─── Definition Validation ────────────────────────────────

describe('ConnectorDefinitionSchema', () => {
  it('accepts a minimal valid definition', () => {
    const result = ConnectorDefinitionSchema.safeParse({
      id: 'my-api',
      name: 'My API',
      url: 'https://api.example.com/data',
      sourceType: 'my_data',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a full definition with all fields', () => {
    const result = ConnectorDefinitionSchema.safeParse({
      id: 'github-issues',
      name: 'GitHub Issues',
      url: 'https://api.github.com/repos/{{owner}}/{{repo}}/issues',
      auth: { type: 'bearer', value: '{{token}}' },
      headers: { Accept: 'application/vnd.github.v3+json' },
      records: 'items',
      pagination: {
        type: 'page',
        pageParam: 'page',
        limitParam: 'per_page',
        limit: 30,
      },
      content: '{{title}}\n\n{{body}}',
      sourceId: 'github://{{_config.owner}}/{{_config.repo}}/issues/{{number}}',
      sourceType: 'github_issue',
      dateField: 'created_at',
      sinceParam: 'since',
      sinceFormat: 'iso',
      rateLimitMs: 100,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(ConnectorDefinitionSchema.safeParse({}).success).toBe(false);
    expect(ConnectorDefinitionSchema.safeParse({ id: 'x' }).success).toBe(false);
    expect(ConnectorDefinitionSchema.safeParse({ id: 'x', name: 'X', url: 'http://x' }).success).toBe(false);
  });

  it('rejects invalid auth type', () => {
    const result = ConnectorDefinitionSchema.safeParse({
      id: 'x', name: 'X', url: 'http://x', sourceType: 'x',
      auth: { type: 'oauth', value: 'token' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid pagination type', () => {
    const result = ConnectorDefinitionSchema.safeParse({
      id: 'x', name: 'X', url: 'http://x', sourceType: 'x',
      pagination: { type: 'infinite-scroll' },
    });
    expect(result.success).toBe(false);
  });
});

describe('validateDefinition', () => {
  it('returns parsed definition on valid input', () => {
    const def = validateDefinition({
      id: 'test', name: 'Test', url: 'http://test', sourceType: 'test',
    });
    expect(def.id).toBe('test');
  });

  it('throws with details on invalid input', () => {
    expect(() => validateDefinition({})).toThrow('Invalid connector definition');
  });
});

// ─── Init and Auth ────────────────────────────────────────

describe('ConfigurableConnector init', () => {
  it('builds URL from instance config and verifies with test request', async () => {
    const def = makeDefinition({
      url: 'https://api.example.com/v1/{{workspace}}/items',
    });
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await connector.init({ token: 'sk-123', workspace: 'my-team' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain('my-team');
  });

  it('sets bearer auth header', async () => {
    const { connector, fetchMock } = createConnectorWithMockedFetch(makeDefinition());
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await connector.init({ token: 'sk-test' });

    const opts = fetchMock.mock.calls[0][1];
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
  });

  it('sets custom header auth', async () => {
    const def = makeDefinition({
      auth: { type: 'header', header: 'X-Api-Key', value: '{{apiKey}}' },
    });
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await connector.init({ apiKey: 'key-123' });

    const opts = fetchMock.mock.calls[0][1];
    expect(opts.headers['X-Api-Key']).toBe('key-123');
  });

  it('sets query param auth', async () => {
    const def = makeDefinition({
      auth: { type: 'query', param: 'api_key', value: '{{key}}' },
    });
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await connector.init({ key: 'my-key' });

    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain('api_key=my-key');
  });

  it('throws on missing template variable', async () => {
    const def = makeDefinition({
      url: 'https://api.example.com/{{workspace}}/items',
    });
    const { connector } = createConnectorWithMockedFetch(def);

    await expect(connector.init({ token: 'sk-123' }))
      .rejects.toThrow('Missing required variable: {{workspace}}');
  });
});

// ─── Content Mapping ──────────────────────────────────────

describe('ConfigurableConnector content mapping', () => {
  it('uses content template with record fields', async () => {
    const def = makeDefinition({ content: '{{title}}\n\n{{body}}' });
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await connector.init({ token: 'sk' });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: '1', title: 'Bug Report', body: 'App crashes on login', created_at: '2024-06-01T00:00:00Z' }],
    }));

    const episodes = await connector.sync();
    expect(episodes[0].content).toBe('Bug Report\n\nApp crashes on login');
  });

  it('uses _config prefix for instance config in content', async () => {
    const def = makeDefinition({
      content: '[{{_config.project}}] {{title}}',
      sourceId: '{{_config.project}}/{{id}}',
    });
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await connector.init({ token: 'sk', project: 'my-app' });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: '1', title: 'Fix login', created_at: '2024-06-01T00:00:00Z' }],
    }));

    const episodes = await connector.sync();
    expect(episodes[0].content).toBe('[my-app] Fix login');
    expect(episodes[0].sourceId).toBe('my-app/1');
  });

  it('auto-detects content fields when no template', async () => {
    const def = makeDefinition();
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await connector.init({ token: 'sk' });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: '1', description: 'A useful item', created_at: '2024-06-01T00:00:00Z' }],
    }));

    const episodes = await connector.sync();
    expect(episodes[0].content).toBe('A useful item');
  });

  it('prepends title to auto-detected content', async () => {
    const def = makeDefinition();
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await connector.init({ token: 'sk' });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: '1', title: 'My Doc', body: 'Doc content here.', created_at: '2024-06-01T00:00:00Z' }],
    }));

    const episodes = await connector.sync();
    expect(episodes[0].content).toBe('My Doc\n\nDoc content here.');
  });

  it('uses dateField from definition', async () => {
    const def = makeDefinition({ dateField: 'published_at' });
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await connector.init({ token: 'sk' });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: '1', text: 'hello', published_at: '2024-03-15T10:00:00Z' }],
    }));

    const episodes = await connector.sync();
    expect(episodes[0].validAt!.toISOString()).toBe('2024-03-15T10:00:00.000Z');
  });

  it('sets correct sourceType from definition', async () => {
    const def = makeDefinition({ sourceType: 'custom_type' });
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await connector.init({ token: 'sk' });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: '1', text: 'hello' }],
    }));

    const episodes = await connector.sync();
    expect(episodes[0].sourceType).toBe('custom_type');
  });
});

// ─── Pagination ───────────────────────────────────────────

describe('ConfigurableConnector pagination', () => {
  it('paginates with cursor', async () => {
    const def = makeDefinition({
      pagination: { type: 'cursor', cursorField: 'next_cursor', cursorParam: 'cursor', limit: 2 },
    });
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await connector.init({ token: 'sk' });

    // Page 1
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: '1', text: 'first' }],
      next_cursor: 'abc',
    }));
    // Page 2
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: '2', text: 'second' }],
      next_cursor: null,
    }));

    const episodes = await connector.sync();
    expect(episodes).toHaveLength(2);

    // Verify cursor was passed
    const secondUrl = fetchMock.mock.calls[2][0];
    expect(secondUrl).toContain('cursor=abc');
  });

  it('paginates with page numbers', async () => {
    const def = makeDefinition({
      pagination: { type: 'page', pageParam: 'page', limitParam: 'per_page', limit: 1 },
    });
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await connector.init({ token: 'sk' });

    // Page 1
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: '1', text: 'first' }],
    }));
    // Page 2 (empty, stops)
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [],
    }));

    const episodes = await connector.sync();
    expect(episodes).toHaveLength(1);

    // Verify page param incremented
    const secondUrl = fetchMock.mock.calls[2][0];
    expect(secondUrl).toContain('page=2');
  });

  it('paginates with offset', async () => {
    const def = makeDefinition({
      pagination: { type: 'offset', offsetParam: 'start', limit: 2 },
    });
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await connector.init({ token: 'sk' });

    // First batch
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: '1', text: 'a' }, { id: '2', text: 'b' }],
    }));
    // Second batch (partial, stops)
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: '3', text: 'c' }],
    }));

    const episodes = await connector.sync();
    expect(episodes).toHaveLength(3);

    // Verify offset was sent
    const secondUrl = fetchMock.mock.calls[2][0];
    expect(secondUrl).toContain('start=2');
  });

  it('stops when no records returned', async () => {
    const def = makeDefinition();
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await connector.init({ token: 'sk' });

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const episodes = await connector.sync();
    expect(episodes).toHaveLength(0);
  });
});

// ─── Since / Incremental Sync ─────────────────────────────

describe('ConfigurableConnector since', () => {
  it('passes since as ISO param', async () => {
    const def = makeDefinition({ sinceParam: 'updated_after', sinceFormat: 'iso' });
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await connector.init({ token: 'sk' });

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await connector.sync({ since: new Date('2024-06-01T00:00:00Z') });

    const url = fetchMock.mock.calls[1][0];
    expect(url).toContain('updated_after=2024-06-01T00%3A00%3A00.000Z');
  });

  it('passes since as unix timestamp', async () => {
    const def = makeDefinition({ sinceParam: 'since', sinceFormat: 'unix' });
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await connector.init({ token: 'sk' });

    const sinceDate = new Date('2024-06-01T00:00:00Z');
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await connector.sync({ since: sinceDate });

    const url = fetchMock.mock.calls[1][0];
    expect(url).toContain(`since=${Math.floor(sinceDate.getTime() / 1000)}`);
  });
});

// ─── Nested Records Path ──────────────────────────────────

describe('ConfigurableConnector records path', () => {
  it('extracts records from nested path', async () => {
    const def = makeDefinition({ records: 'response.items' });
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse({ response: { items: [] } }));
    await connector.init({ token: 'sk' });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      response: { items: [{ id: '1', text: 'nested' }] },
    }));

    const episodes = await connector.sync();
    expect(episodes).toHaveLength(1);
    expect(episodes[0].content).toBe('nested');
  });

  it('treats top-level array as records when no path set', async () => {
    const def = makeDefinition({ records: undefined });
    const { connector, fetchMock } = createConnectorWithMockedFetch(def);
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await connector.init({ token: 'sk' });

    fetchMock.mockResolvedValueOnce(jsonResponse([
      { id: '1', text: 'top level' },
    ]));

    const episodes = await connector.sync();
    expect(episodes).toHaveLength(1);
    expect(episodes[0].content).toBe('top level');
  });
});

// ─── Directory Loading ────────────────────────────────────

describe('loadConnectorsFromDir', () => {
  it('loads valid JSON definitions', async () => {
    const dir = join(testDir, 'valid');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'figma.json'), JSON.stringify({
      id: 'figma-comments',
      name: 'Figma Comments',
      url: 'https://api.figma.com/v1/files/{{fileKey}}/comments',
      auth: { type: 'header', header: 'X-Figma-Token', value: '{{token}}' },
      records: 'comments',
      sourceType: 'figma_comment',
    }));

    const connectors = await loadConnectorsFromDir(dir);
    expect(connectors).toHaveLength(1);
    expect(connectors[0].id).toBe('figma-comments');
    expect(connectors[0].name).toBe('Figma Comments');
  });

  it('loads multiple definitions', async () => {
    const dir = join(testDir, 'multi');
    await mkdir(dir, { recursive: true });

    await writeFile(join(dir, 'a.json'), JSON.stringify({
      id: 'api-a', name: 'A', url: 'http://a', sourceType: 'a',
    }));
    await writeFile(join(dir, 'b.json'), JSON.stringify({
      id: 'api-b', name: 'B', url: 'http://b', sourceType: 'b',
    }));

    const connectors = await loadConnectorsFromDir(dir);
    expect(connectors).toHaveLength(2);
  });

  it('skips invalid JSON files', async () => {
    const dir = join(testDir, 'invalid');
    await mkdir(dir, { recursive: true });

    await writeFile(join(dir, 'good.json'), JSON.stringify({
      id: 'good', name: 'Good', url: 'http://good', sourceType: 'good',
    }));
    await writeFile(join(dir, 'bad.json'), '{ not valid json }');
    await writeFile(join(dir, 'missing-fields.json'), JSON.stringify({ id: 'x' }));

    const connectors = await loadConnectorsFromDir(dir);
    expect(connectors).toHaveLength(1);
    expect(connectors[0].id).toBe('good');
  });

  it('skips non-JSON files', async () => {
    const dir = join(testDir, 'mixed-ext');
    await mkdir(dir, { recursive: true });

    await writeFile(join(dir, 'good.json'), JSON.stringify({
      id: 'good', name: 'Good', url: 'http://good', sourceType: 'good',
    }));
    await writeFile(join(dir, 'readme.md'), '# Not a connector');
    await writeFile(join(dir, 'notes.txt'), 'ignore me');

    const connectors = await loadConnectorsFromDir(dir);
    expect(connectors).toHaveLength(1);
  });

  it('returns empty array for nonexistent directory', async () => {
    const connectors = await loadConnectorsFromDir('/nonexistent/path');
    expect(connectors).toHaveLength(0);
  });
});
