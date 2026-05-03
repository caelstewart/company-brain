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
import { Brain, SkillResolver, ConnectorRegistry, FilesystemConnector, NangoConnector, ConfigurableConnector, WebhookReceiver, allEvalFixtures, baselineEvalFixtures, loadConnectorsFromDir, runTriageEvalSuite, summarizeTriageEvalResults, validateDefinition } from '@company-brain/core';
import type { AccessContext, BrainConfig, GroundedAnswer, VisibilityPolicy, WebhookSource } from '@company-brain/core';

const MCP_VERSION = '0.9.5-jsonb-acl-fix';

const visibilitySchema = z.object({
  allowedPrincipals: z.array(z.string()).optional(),
  deniedPrincipals: z.array(z.string()).optional(),
  allowedGroups: z.array(z.string()).optional(),
  deniedGroups: z.array(z.string()).optional(),
  classification: z.string().optional(),
  inheritedFrom: z.string().optional(),
  sourceSystem: z.string().optional(),
  sourceAcl: z.array(z.object({
    provider: z.string(),
    id: z.string(),
    type: z.enum(['user', 'group', 'channel', 'workspace', 'role', 'account', 'unknown']),
    access: z.enum(['allow', 'deny']),
    name: z.string().optional(),
  })).optional(),
}).optional();

const accessSchema = z.object({
  principalId: z.string().optional(),
  principalIds: z.array(z.string()).optional(),
  groups: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  sourceAccounts: z.record(z.string()).optional(),
  bypass: z.boolean().optional(),
}).optional();

const memoryKindSchema = z.enum(['interaction', 'decision', 'rationale', 'commitment', 'open_question', 'risk', 'value_object', 'product_signal', 'workflow_signal', 'policy', 'exception']);
const memoryStatusSchema = z.enum(['observed', 'proposed', 'decided', 'rejected', 'parked', 'open', 'in_progress', 'done', 'blocked', 'unknown']);

function formatMcpAnswer(result: GroundedAnswer, includeResults: boolean) {
  const formatted = {
    query: result.query,
    answer: result.answer,
    citations: result.citations.map(citation => ({
      ...citation,
      content: truncateText(citation.content, 700),
      quote: citation.quote ? truncateText(citation.quote, 500) : undefined,
    })),
    inference: result.inference,
    missing: result.missing,
    confidence: result.confidence,
    resultCount: result.results.length,
    ...(includeResults ? { results: result.results } : {}),
  };
  return formatted;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function mcpVisibilityWarnings(visibility?: VisibilityPolicy): string[] {
  const label = visibility?.classification;
  const classification = label?.trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (!classification) return [];
  const hasAcl = (visibility?.allowedPrincipals?.length ?? 0) > 0 ||
    (visibility?.deniedPrincipals?.length ?? 0) > 0 ||
    (visibility?.allowedGroups?.length ?? 0) > 0 ||
    (visibility?.deniedGroups?.length ?? 0) > 0 ||
    (visibility?.sourceAcl?.length ?? 0) > 0;
  const looksRestricted = classification.includes('private') ||
    classification.includes('confidential') ||
    classification.includes('restricted') ||
    classification.includes('only') ||
    classification.includes('sensitive');
  if (looksRestricted && !hasAcl) {
    return [`Classification "${label}" looks restricted but does not enforce access by itself. Pass source ACL metadata or explicit visibility rules.`];
  }
  return [];
}

export async function startMcpServer(config: BrainConfig, options?: { skillsDir?: string; connectorsDir?: string; webhooksDir?: string }): Promise<void> {
  const brain = new Brain(config);
  await brain.init();

  // Load skills from directory (defaults + user overrides)
  const skillsDir = options?.skillsDir || process.env.BRAIN_SKILLS_DIR;
  const resolver = new SkillResolver({ skillsDir });
  if (skillsDir) {
    const loaded = await resolver.loadFromDir();
    if (loaded > 0) console.error(`[skills] Loaded ${loaded} user skill(s) from ${skillsDir}`);
  }

  // Set up connector registry with built-in connector types
  const registry = new ConnectorRegistry(brain);
  registry.register(new FilesystemConnector());
  registry.register(new NangoConnector());

  // Load custom connectors from directory
  const connectorsDir = options?.connectorsDir || process.env.BRAIN_CONNECTORS_DIR;
  if (connectorsDir) {
    try {
      const custom = await loadConnectorsFromDir(connectorsDir);
      for (const c of custom) {
        registry.register(c);
      }
      if (custom.length > 0) console.error(`[connectors] Loaded ${custom.length} custom connector(s) from ${connectorsDir}`);
    } catch {}
  }

  // Set up webhook receiver
  const webhooksDir = options?.webhooksDir || process.env.BRAIN_WEBHOOKS_DIR || `${process.env.HOME || '~'}/.company-brain/webhooks`;
  const webhookReceiver = new WebhookReceiver(brain, { webhooksDir });
  const webhookSourcesLoaded = await webhookReceiver.loadSources();
  if (webhookSourcesLoaded > 0) console.error(`[webhooks] Loaded ${webhookSourcesLoaded} webhook source(s) from ${webhooksDir}`);

  const server = new McpServer({
    name: 'company-brain',
    version: MCP_VERSION,
  });

  // ─── Tools ───────────────────────────────────────────────────

  server.tool(
    'version',
    'Returns the Company Brain MCP server version.',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: `company-brain MCP server v${MCP_VERSION} (organizational memory + JSONB ACL enforcement)` }],
    }),
  );

  server.tool(
    'ingest',
    'Ingest raw content into the knowledge graph. IMPORTANT: pass the user/source text exactly as received; do not clean, summarize, rewrite, normalize, or add structure before calling this tool. The server-side ingest pipeline handles normalization, extraction, and security propagation.',
    {
      content: z.string().describe('Raw source text to ingest exactly as received. Do not rewrite or summarize it.'),
      sourceType: z.string().describe('Type of source (e.g., meeting_transcript, email, document, slack_message)'),
      sourceId: z.string().optional().describe('Optional external ID for deduplication'),
      groupId: z.string().optional().describe('Workspace/tenant group ID'),
      metadata: z.record(z.unknown()).optional().describe('Optional raw source metadata such as channel/thread IDs, call participants, CRM record fields, or explicit source ACL fields like visibleGroupIds.'),
      visibility: visibilitySchema.describe('Optional row-level visibility policy inherited by extracted graph records'),
    },
    async ({ content, sourceType, sourceId, groupId, metadata, visibility }) => {
      const result = await brain.ingest({
        content,
        sourceType,
        sourceId: sourceId ?? undefined,
        groupId: groupId ?? undefined,
        metadata: metadata ?? undefined,
        visibility: visibility as VisibilityPolicy | undefined,
        validAt: new Date(),
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...result,
            visibilityWarnings: mcpVisibilityWarnings(visibility as VisibilityPolicy | undefined),
          }, null, 2),
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
      methods: z.array(z.enum(['semantic', 'keyword', 'graph', 'temporal', 'pagerank', 'community', 'decompose'])).optional().describe('Search methods to use. Leave empty for automatic routing.'),
      access: accessSchema.describe('Optional caller access context for permission-filtered retrieval'),
    },
    async ({ query, limit, groupId, entityTypes, relations, methods, access }) => {
      const results = await brain.search({
        query,
        limit: limit ?? undefined,
        groupId: groupId ?? undefined,
        entityTypes: entityTypes ?? undefined,
        relations: relations ?? undefined,
        methods: methods ?? undefined,
        access: access as AccessContext | undefined,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            groundingInstructions: [
              'Answer only from returned results.',
              'Use metadata.evidence.quote or content as support.',
              'Include confidence when available.',
              'Label any interpretation beyond the result text as inference.',
              'Do not invent status, root cause, owner, timing, or next step without supporting evidence.',
            ],
            results,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'answer',
    'Answer a question using only retrieved graph evidence, with citations and inference separated.',
    {
      query: z.string().describe('Natural language question'),
      limit: z.number().optional().describe('Max search results to retrieve before synthesis'),
      groupId: z.string().optional().describe('Workspace/tenant group ID'),
      entityTypes: z.array(z.string()).optional().describe('Filter by entity types'),
      relations: z.array(z.string()).optional().describe('Filter by relation types'),
      methods: z.array(z.enum(['semantic', 'keyword', 'graph', 'temporal', 'pagerank', 'community', 'decompose'])).optional().describe('Search methods to use. Leave empty for automatic routing.'),
      access: accessSchema.describe('Optional caller access context for permission-filtered retrieval'),
      includeResults: z.boolean().optional().describe('Include full raw search results. Defaults to false to keep MCP responses compact.'),
    },
    async ({ query, limit, groupId, entityTypes, relations, methods, access, includeResults }) => {
      const result = await brain.answer({
        query,
        limit: limit ?? undefined,
        groupId: groupId ?? undefined,
        entityTypes: entityTypes ?? undefined,
        relations: relations ?? undefined,
        methods: methods ?? undefined,
        access: access as AccessContext | undefined,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(formatMcpAnswer(result, includeResults === true), null, 2),
        }],
      };
    },
  );

  server.tool(
    'search_memory',
    'Search first-class organizational memory objects: decisions, rationale, commitments, open questions, risks, and value objects.',
    {
      query: z.string().describe('Natural language memory query'),
      limit: z.number().optional().describe('Max memory results to return'),
      groupId: z.string().optional().describe('Workspace/tenant group ID'),
      kinds: z.array(memoryKindSchema).optional().describe('Filter by memory object kinds'),
      statuses: z.array(memoryStatusSchema).optional().describe('Filter by memory statuses'),
      access: accessSchema.describe('Optional caller access context for permission-filtered retrieval'),
    },
    async ({ query, limit, groupId, kinds, statuses, access }) => {
      const results = await brain.searchMemory({
        query,
        limit: limit ?? undefined,
        groupId: groupId ?? undefined,
        kinds: kinds ?? undefined,
        statuses: statuses ?? undefined,
        access: access as AccessContext | undefined,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ results }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'list_memory',
    'List recent organizational memory objects with optional kind/status filters.',
    {
      limit: z.number().optional().describe('Max memory objects to return'),
      groupId: z.string().optional().describe('Workspace/tenant group ID'),
      kinds: z.array(memoryKindSchema).optional().describe('Filter by memory object kinds'),
      statuses: z.array(memoryStatusSchema).optional().describe('Filter by memory statuses'),
      access: accessSchema.describe('Optional caller access context for permission-filtered retrieval'),
    },
    async ({ limit, groupId, kinds, statuses, access }) => {
      const results = await brain.listMemory({
        limit: limit ?? undefined,
        groupId: groupId ?? undefined,
        kinds: kinds ?? undefined,
        statuses: statuses ?? undefined,
        access: access as AccessContext | undefined,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ results }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'cleanup_ephemeral',
    'Delete expired ephemeral source episodes that triage kept only as short-lived context and that have no graph or memory references.',
    {
      groupId: z.string().optional().describe('Workspace/tenant group ID'),
      olderThanDays: z.number().optional().describe('Delete ephemeral episodes older than this many days'),
      limit: z.number().optional().describe('Maximum episodes to delete'),
    },
    async ({ groupId, olderThanDays, limit }) => {
      const result = await brain.cleanupEphemeralEpisodes({
        groupId: groupId ?? undefined,
        olderThanDays: olderThanDays ?? undefined,
        limit: limit ?? undefined,
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
    'get_entity',
    'Get a specific entity by ID with its facts, related entities, and timeline.',
    {
      id: z.string().describe('Entity ID'),
      includeFacts: z.boolean().optional().describe('Include current facts (default: true)'),
      includeRelated: z.boolean().optional().describe('Include related entities'),
      includeTimeline: z.boolean().optional().describe('Include full fact timeline (including invalidated)'),
      depth: z.number().optional().describe('Graph traversal depth for related entities (default: 1)'),
      access: accessSchema.describe('Optional caller access context for permission-filtered retrieval'),
    },
    async ({ id, includeFacts, includeRelated, includeTimeline, depth, access }) => {
      const result = await brain.getEntity(id, {
        includeFacts: includeFacts ?? undefined,
        includeRelated: includeRelated ?? undefined,
        includeTimeline: includeTimeline ?? undefined,
        depth: depth ?? undefined,
        access: access as AccessContext | undefined,
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
      access: accessSchema.describe('Optional caller access context for permission-filtered retrieval'),
    },
    async ({ name, groupId, access }) => {
      const entity = await brain.findEntity(name, groupId ?? undefined, access as AccessContext | undefined);

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
      access: accessSchema.describe('Optional caller access context for permission-filtered retrieval'),
    },
    async ({ sourceId, targetId, relation, includeInvalidated, asOf, access }) => {
      const facts = await brain.getFacts(sourceId, targetId ?? undefined, {
        relation: relation ?? undefined,
        includeInvalidated: includeInvalidated ?? undefined,
        asOf: asOf ? new Date(asOf) : undefined,
        access: access as AccessContext | undefined,
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

  server.tool(
    'improvement_proposals',
    'Get audited improvement proposals for schema, extraction, canonicalization, and skill evolution.',
    {},
    async () => {
      const proposals = await brain.getImprovementProposals();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(proposals, null, 2),
        }],
      };
    },
  );

  server.tool(
    'propose_canonical_clusters',
    'Process graph-level entity/relation canonicalization: auto-apply safe clusters, return ambiguous clusters inline, and log low-confidence telemetry.',
    {
      groupId: z.string().optional(),
      minConfidence: z.number().optional(),
      limit: z.number().optional(),
      autoApplyThreshold: z.number().optional().describe('Confidence at or above this threshold is applied automatically (default 0.92)'),
      ambiguousThreshold: z.number().optional().describe('Confidence at or above this threshold is returned inline as ambiguity (default 0.75)'),
    },
    async ({ groupId, minConfidence, limit, autoApplyThreshold, ambiguousThreshold }) => {
      const clusters = await brain.proposeCanonicalClusters({
        groupId: groupId ?? undefined,
        minConfidence: minConfidence ?? undefined,
        limit: limit ?? undefined,
        autoApplyThreshold: autoApplyThreshold ?? undefined,
        ambiguousThreshold: ambiguousThreshold ?? undefined,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(clusters, null, 2) }] };
    },
  );

  server.tool(
    'promote_skills',
    'Draft, validate, and optionally promote skills from improvement proposals.',
    {
      skillsDir: z.string().optional(),
      minConfidence: z.number().optional(),
      autoPromote: z.boolean().optional(),
    },
    async ({ skillsDir, minConfidence, autoPromote }) => {
      const promotions = await brain.promoteSkills({
        skillsDir: skillsDir ?? undefined,
        minConfidence: minConfidence ?? undefined,
        autoPromote: autoPromote ?? undefined,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(promotions, null, 2) }] };
    },
  );

  server.tool(
    'run_evals',
    'Run DB-backed eval fixtures through live ingest and retrieval.',
    {
      useBaselineFixtures: z.boolean().optional().describe('Use built-in baseline fixtures when true or omitted'),
      includePressure: z.boolean().optional().describe('Include high-pressure messy fixtures'),
      groupPrefix: z.string().optional(),
    },
    async ({ includePressure, groupPrefix }) => {
      const results = await brain.runEvals(includePressure ? allEvalFixtures : baselineEvalFixtures, { groupPrefix: groupPrefix ?? undefined });
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    },
  );

  server.tool(
    'run_triage_evals',
    'Run LLM-based interaction triage pressure evals for drop/ephemeral/durable admission decisions.',
    {},
    async () => {
      const results = await runTriageEvalSuite({
        llmConfig: config.llm,
        triageConfig: config.triage,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ summary: summarizeTriageEvalResults(results), results }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'simulate_permission',
    'Explain whether an access context can see a visibility policy.',
    {
      visibility: visibilitySchema,
      access: accessSchema,
    },
    async ({ visibility, access }) => {
      const result = brain.simulatePermission(visibility, access as AccessContext | undefined);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ─── Skill Tools ────────────────────────────────────────────

  server.tool(
    'list_skills',
    'List all available skills (built-in and user-created). Shows the routing table for agent skill selection.',
    {},
    async () => {
      const skills = resolver.list().map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        triggers: s.triggers,
        alwaysOn: s.alwaysOn || false,
        priority: s.priority || 0,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ skills, routingTable: resolver.toRoutingTable() }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_skill',
    'Get the full content of a skill by ID. Returns the complete SOP markdown.',
    {
      id: z.string().describe('Skill ID to retrieve'),
    },
    async ({ id }) => {
      const skill = resolver.get(id);
      if (!skill) {
        return {
          content: [{ type: 'text' as const, text: `Skill "${id}" not found.` }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(skill, null, 2),
        }],
      };
    },
  );

  server.tool(
    'save_skill',
    'Create or update a skill. Saves as a markdown file in the skills directory so it persists across restarts.',
    {
      id: z.string().describe('Unique skill ID (lowercase, hyphens ok)'),
      name: z.string().describe('Human-readable skill name'),
      description: z.string().describe('Short description of what this skill does'),
      triggers: z.array(z.string()).describe('Phrases that activate this skill'),
      content: z.string().describe('Full markdown SOP content'),
      alwaysOn: z.boolean().optional().describe('Run on every message (default: false)'),
      priority: z.number().optional().describe('Priority for resolver conflicts (higher = preferred, default: 50)'),
    },
    async ({ id, name, description, triggers, content, alwaysOn, priority }) => {
      const skill = {
        id,
        name,
        description,
        triggers,
        content,
        alwaysOn: alwaysOn ?? undefined,
        priority: priority ?? 50,
      };

      try {
        const filepath = await resolver.save(skill);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ok: true, id, filepath, message: `Skill "${name}" saved. It will be loaded automatically on next restart.` }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err.message }, null, 2),
          }],
        };
      }
    },
  );

  // ─── Connector Tools ────────────────────────────────────────

  server.tool(
    'nango_connect',
    'Start an OAuth connection flow via Nango. Returns a URL the user must open in their browser to authorize. Once authorized, use connect() with type "nango" to register the connection, then sync_connector() to pull data. Nango supports 700+ integrations (GitHub, Slack, Notion, HubSpot, Salesforce, Linear, Gmail, etc.).',
    {
      integration: z.string().optional().describe('Nango integration ID to connect (e.g., "github-getting-started"). If omitted, shows all available integrations.'),
      endUserId: z.string().optional().describe('Identifier for the end user (default: "default")'),
    },
    async ({ integration, endUserId }) => {
      const nangoKey = process.env.NANGO_API_KEY;
      if (!nangoKey) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'NANGO_API_KEY environment variable is not set. Add it to your MCP server config.' }, null, 2) }],
        };
      }

      try {
        // If no integration specified, list available ones
        if (!integration) {
          const res = await fetch('https://api.nango.dev/integrations', {
            headers: { 'Authorization': `Bearer ${nangoKey}` },
          });
          const data = await res.json() as any;
          const integrations = (data.data || []).map((i: any) => ({
            id: i.unique_key,
            provider: i.provider,
            name: i.display_name,
          }));

          // Also list existing connections
          const connRes = await fetch('https://api.nango.dev/connections', {
            headers: { 'Authorization': `Bearer ${nangoKey}` },
          });
          const connData = await connRes.json() as any;
          const connections = (connData.connections || []).map((c: any) => ({
            connectionId: c.connection_id,
            provider: c.provider_config_key,
            created: c.created_at,
          }));

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                integrations,
                connections,
                message: integrations.length === 0
                  ? 'No integrations configured in Nango yet. Go to app.nango.dev to add an integration, then use nango_connect to authorize it.'
                  : `${integrations.length} integration(s) available. Use nango_connect with integration set to the ID to start the OAuth flow. ${connections.length} active connection(s).`,
              }, null, 2),
            }],
          };
        }

        // Create a connect session for the specified integration
        const res = await fetch('https://api.nango.dev/connect/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${nangoKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            end_user: { id: endUserId || 'default' },
            allowed_integrations: [integration],
          }),
        });
        const data = await res.json() as any;

        if (!data.data?.connect_link) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Failed to create connect session', details: data }, null, 2) }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              authUrl: data.data.connect_link,
              expiresAt: data.data.expires_at,
              message: `Open this URL in your browser to authorize ${integration}:\n\n${data.data.connect_link}\n\nAfter authorizing, come back and run nango_connect (with no args) to see your new connection. Then use connect() with type "nango" and the connection details to register it.`,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }, null, 2) }],
        };
      }
    },
  );

  server.tool(
    'list_connectors',
    'List available connector types and currently configured connector instances.',
    {},
    async () => {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            availableTypes: registry.listTypes(),
            configured: registry.listConfigured().map(c => ({
              id: c.id,
              type: c.type,
              groupId: c.groupId,
            })),
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'connect',
    'Configure and connect a data source. Supported built-in types: filesystem, nango (700+ integrations via Nango), or any custom connector type loaded from BRAIN_CONNECTORS_DIR. For nango: use nango_connect first to authorize via OAuth, then connect with the connection details. Once connected, use sync_connector to pull data.',
    {
      id: z.string().describe('Unique instance ID for this connection (e.g., "sales-notes", "nango-slack")'),
      type: z.string().describe('Connector type: filesystem, nango, or a custom connector type'),
      config: z.record(z.unknown()).describe('Connector-specific config. filesystem: {rootDir, extensions?}. nango: {secretKey (or uses NANGO_API_KEY env), providerConfigKey, connectionId, model, contentTemplate?, sourceType?}.'),
      groupId: z.string().optional().describe('Group/workspace to ingest data into (default: "default")'),
    },
    async ({ id, type, config: connConfig, groupId }) => {
      try {
        // Inject API keys from env if not provided in config
        const finalConfig = { ...connConfig };
        if (type === 'nango' && !finalConfig.secretKey && process.env.NANGO_API_KEY) {
          finalConfig.secretKey = process.env.NANGO_API_KEY;
        }

        await registry.connect({
          id,
          type,
          config: finalConfig,
          groupId: groupId ?? undefined,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ok: true, id, type, message: `Connected "${id}" (${type}). Use sync_connector to pull data.` }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err.message }, null, 2),
          }],
        };
      }
    },
  );

  server.tool(
    'sync_connector',
    'Pull data from a connected data source into the knowledge graph. Supports incremental sync — only fetches new data since the last sync.',
    {
      id: z.string().describe('Connector instance ID (as set in connect)'),
      full: z.boolean().optional().describe('Force full sync, ignoring last sync timestamp (default: false, incremental)'),
      limit: z.number().optional().describe('Max records to sync (default: connector-specific)'),
    },
    async ({ id, full, limit }) => {
      try {
        const options: { since?: Date; limit?: number } = {};
        if (full) options.since = undefined;
        if (limit) options.limit = limit;

        const result = await registry.sync(id, full ? { ...options, since: new Date(0) } : options);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err.message }, null, 2),
          }],
        };
      }
    },
  );

  server.tool(
    'sync_all_connectors',
    'Sync all configured connectors at once. Each connector syncs incrementally from its last sync point.',
    {},
    async () => {
      try {
        const results = await registry.syncAll();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(results, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err.message }, null, 2),
          }],
        };
      }
    },
  );

  server.tool(
    'save_connector',
    'Create a custom REST API connector by defining its URL, auth, pagination, and content mapping. Saves as a JSON file and immediately registers it for use. For any REST API not covered by the built-in connectors.',
    {
      definition: z.object({
        id: z.string().describe('Unique connector type ID (lowercase, e.g., "linear", "github-issues")'),
        name: z.string().describe('Human-readable name'),
        url: z.string().describe('API URL template. Use {{varName}} for values from instance config (e.g., "https://api.linear.app/{{endpoint}}")'),
        auth: z.object({
          type: z.enum(['bearer', 'header', 'query']).describe('Auth method'),
          header: z.string().optional().describe('Header name for type "header" (e.g., "X-Api-Key")'),
          param: z.string().optional().describe('Query param name for type "query"'),
          value: z.string().describe('Value template (e.g., "{{token}}")'),
        }).optional().describe('Authentication config'),
        headers: z.record(z.string()).optional().describe('Extra headers'),
        records: z.string().optional().describe('Dot-path to records array in response (e.g., "data.items"). Omit if response IS the array.'),
        pagination: z.object({
          type: z.enum(['cursor', 'offset', 'page']),
          cursorField: z.string().optional(),
          cursorParam: z.string().optional(),
          pageParam: z.string().optional(),
          offsetParam: z.string().optional(),
          limitParam: z.string().optional(),
          limit: z.number().optional(),
        }).optional(),
        content: z.string().optional().describe('Content template using {{fieldName}} from record'),
        sourceId: z.string().optional().describe('Source ID template using {{fieldName}}'),
        sourceType: z.string().describe('Episode source type (e.g., "linear_issue")'),
        dateField: z.string().optional().describe('Record field with timestamp'),
        sinceParam: z.string().optional().describe('Query param for incremental sync'),
        sinceFormat: z.enum(['iso', 'unix']).optional(),
        rateLimitMs: z.number().optional().describe('Ms between requests (default: 200)'),
      }).describe('Connector definition'),
    },
    async ({ definition }) => {
      try {
        // Validate the definition
        const validated = validateDefinition(definition);

        // Save to connectors directory
        const { writeFile, mkdir } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const dir = connectorsDir || `${process.env.HOME || '~'}/.company-brain/connectors`;
        await mkdir(dir, { recursive: true });
        const filepath = join(dir, `${validated.id}.json`);
        await writeFile(filepath, JSON.stringify(validated, null, 2));

        // Immediately register so it's usable without restart
        const connector = new ConfigurableConnector(validated);
        registry.register(connector);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              id: validated.id,
              filepath,
              message: `Connector "${validated.name}" saved and registered. Use connect(type: "${validated.id}", ...) then sync_connector() to pull data.`,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err.message }, null, 2),
          }],
        };
      }
    },
  );

  // ─── Webhook Receiver Tools ─────────────────────────────────

  server.tool(
    'list_webhook_sources',
    'List all registered webhook sources. Each source is a configured endpoint that external services can POST to.',
    {},
    async () => {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ sources: webhookReceiver.listSources() }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'register_webhook_source',
    'Register a webhook source so external services can push data in real-time. Once registered, the source has a webhook URL (POST /api/webhooks/receive/:id) that accepts payloads, verifies signatures, normalizes content, and ingests automatically. Saves to disk so it persists across restarts.',
    {
      id: z.string().describe('Unique source ID (e.g., "github-issues", "linear", "stripe-events")'),
      name: z.string().optional().describe('Human-readable name'),
      sourceType: z.string().describe('Episode sourceType for ingested data (e.g., "github_issue")'),
      contentTemplate: z.string().optional().describe('Template for episode content using {{field}} from payload (e.g., "{{title}}\\n\\n{{body}}")'),
      sourceIdTemplate: z.string().optional().describe('Template for dedup sourceId (e.g., "github://{{repository.full_name}}/issues/{{number}}")'),
      dateField: z.string().optional().describe('Dot-path to timestamp in payload (e.g., "created_at")'),
      secret: z.string().optional().describe('HMAC secret for signature verification'),
      signatureHeader: z.string().optional().describe('Header containing signature (e.g., "x-hub-signature-256")'),
      signatureAlgorithm: z.string().optional().describe('HMAC algorithm: "sha256" (default), "sha1"'),
      signaturePrefix: z.string().optional().describe('Prefix before hex digest (e.g., "sha256=" for GitHub)'),
      eventTypeHeader: z.string().optional().describe('Header with event type (e.g., "x-github-event")'),
      allowedEvents: z.array(z.string()).optional().describe('Only process these event types'),
      metadataFields: z.array(z.string()).optional().describe('Dot-paths to extract into episode metadata'),
      groupId: z.string().optional().describe('Group/workspace to ingest into'),
    },
    async ({ id, name, sourceType, contentTemplate, sourceIdTemplate, dateField, secret, signatureHeader, signatureAlgorithm, signaturePrefix, eventTypeHeader, allowedEvents, metadataFields, groupId }) => {
      try {
        const source: WebhookSource = {
          id,
          name: name || id,
          sourceType,
          contentTemplate: contentTemplate ?? undefined,
          sourceIdTemplate: sourceIdTemplate ?? undefined,
          dateField: dateField ?? undefined,
          secret: secret ?? undefined,
          signatureHeader: signatureHeader ?? undefined,
          signatureAlgorithm: signatureAlgorithm ?? undefined,
          signaturePrefix: signaturePrefix ?? undefined,
          eventTypeHeader: eventTypeHeader ?? undefined,
          allowedEvents: allowedEvents ?? undefined,
          metadataFields: metadataFields ?? undefined,
          groupId: groupId ?? undefined,
        };

        const filepath = await webhookReceiver.saveSource(source);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              id,
              filepath,
              webhookUrl: `/api/webhooks/receive/${id}`,
              message: `Webhook source "${name || id}" registered. Point your external service at POST /api/webhooks/receive/${id} to start receiving data. The webhook endpoint does not require bearer auth — it uses signature verification if configured.`,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: err.message }, null, 2),
          }],
        };
      }
    },
  );

  server.tool(
    'remove_webhook_source',
    'Remove a registered webhook source.',
    {
      id: z.string().describe('Webhook source ID to remove'),
    },
    async ({ id }) => {
      webhookReceiver.removeSource(id);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, id, message: `Webhook source "${id}" removed.` }, null, 2),
        }],
      };
    },
  );

  // ─── Start ───────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
