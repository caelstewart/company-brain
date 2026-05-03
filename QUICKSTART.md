# Quickstart

This is the fastest path to run Company Brain locally and see the operating-memory demo.

## 1. Start Postgres

### Option A: Local Postgres

If you already run Postgres locally:

```bash
createdb company_brain 2>/dev/null || true
export DATABASE_URL=postgresql://localhost:5432/company_brain
psql "$DATABASE_URL" -f packages/core/src/schema.sql
```

If `CREATE EXTENSION vector` fails, install pgvector for your Postgres install, then rerun the schema command.

On macOS with Homebrew, one common setup is:

```bash
brew install postgresql@16 pgvector
brew services start postgresql@16
createdb company_brain 2>/dev/null || true
export DATABASE_URL=postgresql://localhost:5432/company_brain
psql "$DATABASE_URL" -f packages/core/src/schema.sql
```

### Option B: Docker Postgres

If you prefer Docker:

```bash
docker compose up -d postgres
export DATABASE_URL=postgresql://brain:brain@localhost:5432/company_brain
```

## 2. Install and Build

```bash
npm install
npm run build
```

## 3. Configure Environment

Create a local `.env` file from the example:

```bash
cp .env.example .env
```

Then set at least:

```bash
DATABASE_URL=postgresql://localhost:5432/company_brain
OPENAI_API_KEY=sk-...
```

If you used Docker, set `DATABASE_URL=postgresql://brain:brain@localhost:5432/company_brain` instead.

`.env` is gitignored. Do not commit real API keys.

## 4. Run Tests

```bash
npm test
```

Expected result:

```text
Test Files  16 passed (16)
Tests       195 passed (195)
```

## 5. Run the Operating-Memory Demo

This live smoke suite clears the default group, ingests noisy interactions plus document/design/runbook examples, and asks grounded questions about company operating knowledge.

```bash
set -a && source .env && set +a
node tests/operating-memory-suite.mjs
```

Expected result:

```text
answerPassed: 9
answerTotal: 9
failedCases: []
```

## Other Demo Suites

```bash
# Big noisy ingestion + answer pressure test
npx tsx tests/messy-noise-suite.ts

# Verbose walkthrough of the SDK and graph behavior
npx tsx tests/demo.ts
```

Manual MCP test scripts live in `tests/mcp-test-cases/` if you want to drive the system from Cursor or Claude Code.

## 6. Start the REST API

```bash
set -a && source .env && set +a
npx company-brain --rest --port 3333
```

In another terminal:

```bash
curl -X POST http://localhost:3333/api/answer \
  -H "Content-Type: application/json" \
  -d '{"query":"How do we handle pricing exceptions above 30%?"}'
```

If you set `BRAIN_AUTH_TOKEN`, include:

```bash
-H "Authorization: Bearer $BRAIN_AUTH_TOKEN"
```

## Notes

- Use `groupId` only when you intentionally want isolated workspaces. For local demos, use the default group and let the demo suite clear it.
- Without an LLM key, semantic extraction and triage fail closed. The system will not pretend to understand organizational meaning with brittle regex fallbacks.
- `graph.html` is generated locally by `tools/visualize.ts` and is intentionally not committed.
