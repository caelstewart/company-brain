/**
 * REST API Server.
 *
 * Lightweight HTTP server using Node's built-in http module.
 * Exposes the Brain API as JSON endpoints with bearer token auth.
 * Includes connector management and webhook endpoints.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  Brain,
  ConnectorRegistry,
  FilesystemConnector,
  SlackConnector,
  NotionConnector,
} from '@company-brain/core';
import type { BrainConfig } from '@company-brain/core';

interface RestConfig {
  port: number;
  host: string;
  authToken?: string;
}

type RouteHandler = (body: any, params: URLSearchParams, rawBody?: string, headers?: Record<string, string>) => Promise<unknown>;

export async function startRestServer(brainConfig: BrainConfig, restConfig: RestConfig): Promise<void> {
  const brain = new Brain(brainConfig);
  await brain.init();

  // Set up connector registry with built-in connectors
  const registry = new ConnectorRegistry(brain);
  registry.register(new FilesystemConnector());
  registry.register(new SlackConnector());
  registry.register(new NotionConnector());

  const routes = new Map<string, RouteHandler>();

  // ─── Brain Routes ─────────────────────────────────────────

  routes.set('POST /api/ingest', async (body) => {
    return brain.ingest({
      content: body.content,
      sourceType: body.sourceType,
      sourceId: body.sourceId,
      validAt: body.validAt ? new Date(body.validAt) : undefined,
      metadata: body.metadata,
      groupId: body.groupId,
    });
  });

  routes.set('POST /api/search', async (body) => {
    return brain.search({
      query: body.query,
      groupId: body.groupId,
      limit: body.limit,
      offset: body.offset,
      asOf: body.asOf ? new Date(body.asOf) : undefined,
      entityTypes: body.entityTypes,
      relations: body.relations,
      methods: body.methods,
      minConfidence: body.minConfidence,
    });
  });

  routes.set('GET /api/entities/:id', async (_body, params) => {
    const id = params.get('id')!;
    const includeFacts = params.get('includeFacts') !== 'false';
    const includeRelated = params.get('includeRelated') === 'true';
    const includeTimeline = params.get('includeTimeline') === 'true';
    const depth = params.get('depth') ? Number(params.get('depth')) : undefined;

    const result = await brain.getEntity(id, { includeFacts, includeRelated, includeTimeline, depth });
    if (!result) throw new HttpError(404, 'Entity not found');
    return result;
  });

  routes.set('GET /api/entities/find/:name', async (_body, params) => {
    const name = decodeURIComponent(params.get('name')!);
    const groupId = params.get('groupId') || undefined;

    const entity = await brain.findEntity(name, groupId);
    if (!entity) throw new HttpError(404, 'Entity not found');
    return entity;
  });

  routes.set('GET /api/facts/:sourceId', async (_body, params) => {
    const sourceId = params.get('sourceId')!;
    const targetId = params.get('targetId') || undefined;
    const relation = params.get('relation') || undefined;
    const includeInvalidated = params.get('includeInvalidated') === 'true';
    const asOf = params.get('asOf') ? new Date(params.get('asOf')!) : undefined;

    return brain.getFacts(sourceId, targetId, { relation, includeInvalidated, asOf });
  });

  routes.set('POST /api/schema', async (body) => {
    await brain.defineSchema(body);
    return { ok: true };
  });

  routes.set('GET /api/stats', async (_body, params) => {
    const since = params.get('since') ? new Date(params.get('since')!) : undefined;
    return brain.getExtractionStats(since);
  });

  routes.set('GET /api/stats/patterns', async (_body, params) => {
    const min = params.get('minOccurrences') ? Number(params.get('minOccurrences')) : undefined;
    return brain.getSuggestedPatterns(min);
  });

  routes.set('GET /api/health', async () => {
    return { status: 'ok', version: '0.1.0' };
  });

  // ─── Connector Routes ─────────────────────────────────────

  routes.set('POST /api/connectors', async (body) => {
    if (!body.id || !body.type) {
      throw new HttpError(400, 'Required fields: id, type, config');
    }
    await registry.connect({
      id: body.id,
      type: body.type,
      config: body.config || {},
      groupId: body.groupId,
    });
    return { ok: true, id: body.id, type: body.type };
  });

  routes.set('POST /api/connectors/:id/sync', async (body, params) => {
    const id = params.get('id')!;
    const options: any = {};
    if (body.since) options.since = new Date(body.since);
    if (body.limit) options.limit = body.limit;
    if (body.resource) options.resource = body.resource;

    return registry.sync(id, Object.keys(options).length > 0 ? options : undefined);
  });

  routes.set('GET /api/connectors', async () => {
    return {
      types: registry.listTypes(),
      configured: registry.listConfigured(),
    };
  });

  routes.set('POST /api/webhooks/:type', async (body, _params, rawBody, headers) => {
    const type = _params.get('type')!;
    return registry.handleWebhook(type, body, headers);
  });

  // ─── Server ───────────────────────────────────────────────

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Webhook endpoints skip auth (they use their own signature verification)
    const isWebhook = req.url?.startsWith('/api/webhooks/');

    // Auth check for non-webhook routes
    if (!isWebhook && restConfig.authToken) {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${restConfig.authToken}`) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const { rawBody, parsed } = req.method === 'POST' ? await readBody(req) : { rawBody: '', parsed: {} };

      // Collect headers for webhook signature verification
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }

      // Match route
      const { handler, params } = matchRoute(routes, req.method!, url.pathname, url.searchParams);

      if (!handler) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      const result = await handler(parsed, params, rawBody, headers);
      sendJson(res, 200, result);
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : 'Internal server error';
      if (status === 500) console.error(err);
      sendJson(res, status, { error: message });
    }
  });

  server.listen(restConfig.port, restConfig.host, () => {
    console.log(`Company Brain REST API listening on http://${restConfig.host}:${restConfig.port}`);
    console.log(`Endpoints:`);
    console.log(`  Brain:      POST /api/ingest, POST /api/search, GET /api/entities/:id`);
    console.log(`  Connectors: POST /api/connectors, POST /api/connectors/:id/sync`);
    console.log(`  Webhooks:   POST /api/webhooks/:type`);
    console.log(`  Health:     GET /api/health`);
  });
}

// ─── Helpers ─────────────────────────────────────────────────

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<{ rawBody: string; parsed: any }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString();
      if (!rawBody) return resolve({ rawBody: '', parsed: {} });
      try {
        resolve({ rawBody, parsed: JSON.parse(rawBody) });
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function matchRoute(
  routes: Map<string, RouteHandler>,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
): { handler: RouteHandler | null; params: URLSearchParams } {
  // Exact match first
  const exactKey = `${method} ${pathname}`;
  if (routes.has(exactKey)) {
    return { handler: routes.get(exactKey)!, params: searchParams };
  }

  // Pattern match (simple :param support)
  for (const [routeKey, handler] of routes) {
    const [routeMethod, routePattern] = routeKey.split(' ', 2);
    if (routeMethod !== method) continue;

    const routeParts = routePattern.split('/');
    const pathParts = pathname.split('/');

    if (routeParts.length !== pathParts.length) continue;

    const params = new URLSearchParams(searchParams);
    let match = true;

    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        params.set(routeParts[i].slice(1), pathParts[i]);
      } else if (routeParts[i] !== pathParts[i]) {
        match = false;
        break;
      }
    }

    if (match) return { handler, params };
  }

  return { handler: null, params: searchParams };
}
