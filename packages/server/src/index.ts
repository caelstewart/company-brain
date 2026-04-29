#!/usr/bin/env node

/**
 * Company Brain Server.
 *
 * Starts the MCP server (stdio), REST API (HTTP), or both.
 *
 * Usage:
 *   company-brain --mcp              # MCP server only (for Claude Code, Cursor)
 *   company-brain --rest             # REST API only (for web apps)
 *   company-brain --rest --port 3000 # REST on custom port
 *
 * Environment variables:
 *   DATABASE_URL          - PostgreSQL connection string (required)
 *   OPENAI_API_KEY        - For embeddings
 *   ANTHROPIC_API_KEY     - For LLM extraction fallback
 *   BRAIN_AUTH_TOKEN      - Bearer token for REST API auth
 *   BRAIN_GROUP_ID        - Default group/workspace ID
 *   BRAIN_REST_PORT       - REST API port (default: 3333)
 *   BRAIN_REST_HOST       - REST API host (default: 127.0.0.1)
 */

import type { BrainConfig } from '@company-brain/core';
import { startMcpServer } from './mcp.js';
import { startRestServer } from './rest.js';

function parseArgs(argv: string[]): { mode: 'mcp' | 'rest' | 'both'; port: number; host: string } {
  const hasMcp = argv.includes('--mcp');
  const hasRest = argv.includes('--rest');

  let mode: 'mcp' | 'rest' | 'both';
  if (hasMcp && hasRest) mode = 'both';
  else if (hasMcp) mode = 'mcp';
  else if (hasRest) mode = 'rest';
  else mode = 'mcp'; // default to MCP for agent use

  const portIdx = argv.indexOf('--port');
  const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : Number(process.env.BRAIN_REST_PORT || 3333);

  const hostIdx = argv.indexOf('--host');
  const host = hostIdx >= 0 ? argv[hostIdx + 1] : process.env.BRAIN_REST_HOST || '127.0.0.1';

  return { mode, port, host };
}

function buildConfig(): BrainConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required.');
    console.error('Example: DATABASE_URL=postgresql://brain:brain@localhost:5432/company_brain');
    process.exit(1);
  }

  return {
    database: databaseUrl,
    embedding: process.env.OPENAI_API_KEY
      ? { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
      : undefined,
    llm: process.env.ANTHROPIC_API_KEY
      ? { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY }
      : process.env.OPENAI_API_KEY
        ? { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
        : undefined,
    defaultGroupId: process.env.BRAIN_GROUP_ID || 'default',
  };
}

async function main() {
  const { mode, port, host } = parseArgs(process.argv.slice(2));
  const config = buildConfig();

  if (mode === 'mcp' || mode === 'both') {
    await startMcpServer(config);
  }

  if (mode === 'rest' || mode === 'both') {
    await startRestServer(config, {
      port,
      host,
      authToken: process.env.BRAIN_AUTH_TOKEN,
    });
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
