# Writing a Connector

A connector pulls data from an external source and normalizes it into episodes for the brain to ingest. You write one class, and the extraction pipeline, entity resolution, and search indexing all happen automatically.

## The Minimal Connector

```typescript
import { z } from 'zod';
import { AbstractConnector } from '@company-brain/core';
import type { SyncOptions, EpisodeInput } from '@company-brain/core';

// 1. Define your config schema with Zod
const MyConfigSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  workspace: z.string().optional(),
});

type MyConfig = z.infer<typeof MyConfigSchema>;

// 2. Extend AbstractConnector with your config type
export class MyServiceConnector extends AbstractConnector<MyConfig> {
  readonly id = 'my-service';
  readonly name = 'My Service';
  readonly configSchema = MyConfigSchema;

  // 3. Verify credentials in setup()
  async setup(config: MyConfig): Promise<void> {
    const res = await this.fetchJson<{ ok: boolean }>('https://api.myservice.com/me', {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) throw new Error('Auth failed');
  }

  // 4. Fetch data and return episodes in sync()
  async sync(options?: SyncOptions): Promise<EpisodeInput[]> {
    const params = new URLSearchParams();
    if (options?.since) params.set('since', options.since.toISOString());
    if (options?.limit) params.set('limit', String(options.limit));

    const items = await this.fetchJson<any[]>(
      `https://api.myservice.com/items?${params}`,
      { headers: { Authorization: `Bearer ${this.config.apiKey}` } },
    );

    return items.map(item => ({
      content: item.text,
      sourceType: 'my_service',
      sourceId: `myservice://${item.id}`,
      validAt: new Date(item.createdAt),
      visibility: {
        allowedGroups: item.visibleGroupIds || [],
        allowedPrincipals: item.visibleUserIds || [],
        sourceSystem: 'my_service',
        inheritedFrom: item.containerId,
      },
      metadata: {
        provider: 'my_service',
        rawAcl: item.acl,
      },
    }));
  }
}
```

That is the entire connector. Register it, connect it, sync it:

```typescript
import { Brain, ConnectorRegistry } from '@company-brain/core';
import { MyServiceConnector } from './my-connector.js';

const brain = new Brain({ database: process.env.DATABASE_URL! });
await brain.init();

const registry = new ConnectorRegistry(brain);
registry.register(new MyServiceConnector());

await registry.connect({
  id: 'my-svc',
  type: 'my-service',
  config: { apiKey: 'sk-...', workspace: 'engineering' },
});

// First sync fetches everything
await registry.sync('my-svc');

// Subsequent syncs only fetch new data (last sync time is persisted in Postgres)
await registry.sync('my-svc');
```

## What AbstractConnector Gives You

When you extend `AbstractConnector`, you get these for free:

**Config validation.** Your Zod schema is parsed in `init()`. Bad config throws a clear error with field names and messages. No more `config.token as string` hoping for the best.

**Rate-limited fetch.** `this.fetchWithRetry(url, init)` and `this.fetchJson(url, init)` handle rate limits and transient failures automatically:
- Enforces a minimum delay between requests (default 100ms, configurable)
- Retries on network errors with exponential backoff (default 3 retries)
- Reads `Retry-After` header on 429 responses

**Structured logging.** `this.log('info' | 'warn' | 'error', message)` prefixes output with `[connector:my-service]` so you can grep connector output in production.

**Persistent sync state.** The registry stores `lastSyncAt` in Postgres after every sync. Next time you call `registry.sync('my-svc')`, it passes `since: lastSyncAt` to your connector automatically. You do not need to track this yourself.

## What You Need To Implement

### `configSchema` (required)

A Zod schema that describes your connector's configuration. This is validated before `setup()` is called.

```typescript
const HubSpotConfigSchema = z.object({
  accessToken: z.string().min(1),
  portalId: z.string().optional(),
});
```

### `setup(config)` (required)

Called once after config validation. Use it to verify credentials. If auth fails, throw an error.

```typescript
async setup(config: HubSpotConfig): Promise<void> {
  const res = await this.fetchJson<any>('https://api.hubapi.com/account-info/v3/details', {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  });
  if (!res.portalId) throw new Error('HubSpot auth failed');
}
```

### `sync(options?)` (required)

Fetches data and returns `EpisodeInput[]`. Each episode becomes a node in the knowledge graph after extraction.

The `options` parameter provides:
- `since?: Date` - only fetch data modified after this time
- `limit?: number` - max items to return
- `cursor?: string` - pagination token
- `resource?: string` - specific channel/database/folder to sync

Your connector should respect `since` for incremental sync. The registry passes the last sync timestamp automatically.

An `EpisodeInput` has:

| Field | Required | Description |
|-------|----------|-------------|
| `content` | yes | The text to extract knowledge from |
| `sourceType` | yes | A string identifying the source kind (e.g. `'hubspot_deal'`, `'figma_comment'`) |
| `sourceId` | no | A unique URI for deduplication (e.g. `'hubspot://deals/123'`) |
| `validAt` | no | When this data was created/modified. Defaults to now. |
| `groupId` | no | Workspace override. Falls back to the connector config's groupId. |
| `metadata` | no | Arbitrary JSON stored with the episode for provenance. |
| `visibility` | no | Source-native ACLs/visibility. Pass allowed/denied groups or principals here instead of relying on labels inside the text. |

Permissions should come from the source system's metadata, not from words in the content. For example, a Slack channel membership list, ticket visibility field, Drive permissions response, or CRM team ACL should be mapped into `visibility.allowedGroups`, `visibility.allowedPrincipals`, `visibility.deniedGroups`, and `visibility.deniedPrincipals`.

### `handleWebhook(payload, headers?)` (optional)

If your source supports push notifications, implement this to convert incoming payloads into episodes.

```typescript
async handleWebhook(payload: unknown, headers?: Record<string, string>): Promise<EpisodeInput[]> {
  const body = payload as any;
  if (body.type !== 'item.created') return [];
  return [{ content: body.text, sourceType: 'my_service', sourceId: `myservice://${body.id}` }];
}
```

### `close()` (optional)

Cleanup. Close connections, flush buffers, etc.

## Tuning Rate Limits

Pass options to the constructor to match your API's rate limits:

```typescript
export class FigmaConnector extends AbstractConnector<FigmaConfig> {
  constructor() {
    super({
      rateLimitMs: 200,    // 5 req/sec
      maxRetries: 5,       // Figma is flaky
      retryBaseMs: 2000,   // Start backoff at 2s
    });
  }
  // ...
}
```

## Connector Examples

### Linear (issues and comments)

```typescript
const LinearConfigSchema = z.object({
  apiKey: z.string().min(1),
  teamId: z.string().optional(),
});

export class LinearConnector extends AbstractConnector<z.infer<typeof LinearConfigSchema>> {
  readonly id = 'linear';
  readonly name = 'Linear';
  readonly configSchema = LinearConfigSchema;

  async setup(config: z.infer<typeof LinearConfigSchema>) {
    await this.fetchJson('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        Authorization: config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: '{ viewer { id } }' }),
    });
  }

  async sync(options?: SyncOptions): Promise<EpisodeInput[]> {
    const since = options?.since?.toISOString() || '1970-01-01T00:00:00Z';
    const query = `{
      issues(filter: { updatedAt: { gt: "${since}" } }, first: ${options?.limit ?? 50}) {
        nodes { id title description updatedAt state { name } assignee { name } }
      }
    }`;

    const res = await this.fetchJson<any>('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        Authorization: this.config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });

    return (res.data?.issues?.nodes || []).map((issue: any) => ({
      content: `${issue.title}\n\n${issue.description || ''}`.trim(),
      sourceType: 'linear_issue',
      sourceId: `linear://${issue.id}`,
      validAt: new Date(issue.updatedAt),
      metadata: { state: issue.state?.name, assignee: issue.assignee?.name },
    }));
  }
}
```

### Google Docs (document content)

```typescript
const GDocsConfigSchema = z.object({
  accessToken: z.string().min(1),
  folderId: z.string().optional(),
});

export class GoogleDocsConnector extends AbstractConnector<z.infer<typeof GDocsConfigSchema>> {
  readonly id = 'google-docs';
  readonly name = 'Google Docs';
  readonly configSchema = GDocsConfigSchema;

  constructor() {
    super({ rateLimitMs: 100, maxRetries: 3 });
  }

  async setup(config: z.infer<typeof GDocsConfigSchema>) {
    await this.fetchJson('https://www.googleapis.com/drive/v3/about?fields=user', {
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });
  }

  async sync(options?: SyncOptions): Promise<EpisodeInput[]> {
    const params = new URLSearchParams({
      q: "mimeType='application/vnd.google-apps.document'",
      fields: 'files(id,name,modifiedTime)',
      pageSize: String(options?.limit ?? 50),
    });

    const list = await this.fetchJson<any>(
      `https://www.googleapis.com/drive/v3/files?${params}`,
      { headers: { Authorization: `Bearer ${this.config.accessToken}` } },
    );

    const episodes: EpisodeInput[] = [];
    for (const file of list.files || []) {
      if (options?.since && new Date(file.modifiedTime) < options.since) continue;

      const doc = await this.fetchJson<any>(
        `https://docs.googleapis.com/v1/documents/${file.id}`,
        { headers: { Authorization: `Bearer ${this.config.accessToken}` } },
      );

      const text = this.extractText(doc);
      if (text.trim()) {
        episodes.push({
          content: `# ${file.name}\n\n${text}`,
          sourceType: 'google_doc',
          sourceId: `gdocs://${file.id}`,
          validAt: new Date(file.modifiedTime),
          metadata: { name: file.name, docId: file.id },
        });
      }
    }

    return episodes;
  }

  private extractText(doc: any): string {
    // Walk the document body and extract paragraph text
    const parts: string[] = [];
    for (const el of doc.body?.content || []) {
      if (el.paragraph) {
        const text = el.paragraph.elements
          ?.map((e: any) => e.textRun?.content || '')
          .join('') || '';
        parts.push(text);
      }
    }
    return parts.join('');
  }
}
```

## Testing Your Connector

For connectors that call external APIs, test config validation and the episode shape:

```typescript
import { describe, it, expect } from 'vitest';
import { MyServiceConnector } from './my-connector.js';

describe('MyServiceConnector', () => {
  it('rejects missing apiKey', async () => {
    const c = new MyServiceConnector();
    await expect(c.init({})).rejects.toThrow('Invalid config');
  });

  it('rejects empty apiKey', async () => {
    const c = new MyServiceConnector();
    await expect(c.init({ apiKey: '' })).rejects.toThrow('Invalid config');
  });
});
```

For the FilesystemConnector (no external deps), see `packages/core/tests/connectors.test.ts` for a full example using temp directories.
