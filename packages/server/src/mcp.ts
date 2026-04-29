/**
 * MCP (Model Context Protocol) Server.
 *
 * Exposes the Brain API as MCP tools for Claude Code, Cursor, and other
 * MCP-compatible AI editors/agents.
 *
 * Transport: stdio (standard for local MCP servers).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Brain } from '@company-brain/core';
import type { BrainConfig } from '@company-brain/core';

export async function startMcpServer(config: BrainConfig): Promise<void> {
  const brain = new Brain(config);
  await brain.init();

  const server = new McpServer({
    name: 'company-brain',
    version: '0.1.0',
  });

  // ─── Tools ───────────────────────────────────────────────────

  server.tool(
    'ingest',
    'Ingest content into the knowledge graph. Extracts entities and facts automatically.',
    {
      content: z.string().describe('The text content to ingest'),
      sourceType: z.string().describe('Type of source (e.g., meeting_transcript, email, document, slack_message)'),
      sourceId: z.string().optional().describe('Optional external ID for deduplication'),
      groupId: z.string().optional().describe('Workspace/tenant group ID'),
    },
    async ({ content, sourceType, sourceId, groupId }) => {
      const result = await brain.ingest({
        content,
        sourceType,
        sourceId: sourceId ?? undefined,
        groupId: groupId ?? undefined,
        validAt: new Date(),
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    'search',
    'Search the knowledge graph using hybrid search (semantic + keyword + graph traversal).',
    {
      query: z.string().describe('Natural language search query'),
      limit: z.number().optional().describe('Max results to return (default: 20)'),
      groupId: z.string().optional().describe('Workspace/tenant group ID'),
      entityTypes: z.array(z.string()).optional().describe('Filter by entity types'),
      relations: z.array(z.string()).optional().describe('Filter by relation types'),
      methods: z.array(z.enum(['semantic', 'keyword', 'graph', 'temporal'])).optional().describe('Search methods to use'),
    },
    async ({ query, limit, groupId, entityTypes, relations, methods }) => {
      const results = await brain.search({
        query,
        limit: limit ?? undefined,
        groupId: groupId ?? undefined,
        entityTypes: entityTypes ?? undefined,
        relations: relations ?? undefined,
        methods: methods ?? undefined,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(results, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_entity',
    'Get a specific entity by ID with its facts, related entities, and timeline.',
    {
      id: z.string().describe('Entity ID'),
      includeFacts: z.boolean().optional().describe('Include current facts (default: true)'),
      includeRelated: z.boolean().optional().describe('Include related entities'),
      includeTimeline: z.boolean().optional().describe('Include full fact timeline (including invalidated)'),
      depth: z.number().optional().describe('Graph traversal depth for related entities (default: 1)'),
    },
    async ({ id, includeFacts, includeRelated, includeTimeline, depth }) => {
      const result = await brain.getEntity(id, {
        includeFacts: includeFacts ?? undefined,
        includeRelated: includeRelated ?? undefined,
        includeTimeline: includeTimeline ?? undefined,
        depth: depth ?? undefined,
      });

      if (!result) {
        return {
          content: [{ type: 'text' as const, text: 'Entity not found.' }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    'find_entity',
    'Find an entity by name using fuzzy matching.',
    {
      name: z.string().describe('Entity name to search for'),
      groupId: z.string().optional().describe('Workspace/tenant group ID'),
    },
    async ({ name, groupId }) => {
      const entity = await brain.findEntity(name, groupId ?? undefined);

      if (!entity) {
        return {
          content: [{ type: 'text' as const, text: `No entity found matching "${name}".` }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(entity, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_facts',
    'Get facts between entities. Supports temporal queries.',
    {
      sourceId: z.string().describe('Source entity ID'),
      targetId: z.string().optional().describe('Target entity ID (omit for all facts about source)'),
      relation: z.string().optional().describe('Filter by relation type'),
      includeInvalidated: z.boolean().optional().describe('Include superseded facts'),
      asOf: z.string().optional().describe('Point-in-time query (ISO date string)'),
    },
    async ({ sourceId, targetId, relation, includeInvalidated, asOf }) => {
      const facts = await brain.getFacts(sourceId, targetId ?? undefined, {
        relation: relation ?? undefined,
        includeInvalidated: includeInvalidated ?? undefined,
        asOf: asOf ? new Date(asOf) : undefined,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(facts, null, 2),
        }],
      };
    },
  );

  server.tool(
    'extraction_stats',
    'Get fail-improve loop statistics. Shows how the system is learning to extract without LLM.',
    {
      since: z.string().optional().describe('Start date for stats (ISO date string)'),
    },
    async ({ since }) => {
      const stats = await brain.getExtractionStats(since ? new Date(since) : undefined);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(stats, null, 2),
        }],
      };
    },
  );

  // ─── Start ───────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
