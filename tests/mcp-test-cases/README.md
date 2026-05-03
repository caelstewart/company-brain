# MCP Test Cases

Manual test cases for the Company Brain MCP server. Each `.md` file in this directory is a self-contained test case.

## Before testing

Start Postgres, clear the default group, and rebuild:

```bash
docker compose up -d postgres
psql "postgresql://brain:brain@localhost:5432/company_brain" -c "DELETE FROM groups WHERE id = 'default';"
npm run build
```

Then reconnect the MCP server in your test chat: `/mcp`

## Running a test

1. Open a new Claude Code chat in the `company-brain` directory
2. Open the test case `.md` file
3. Copy-paste each step in order

## Test cases

| File | What it tests |
|------|--------------|
| `01-pipeline-review.md` | Full ingestion + all search tiers (direct, hybrid, multi-hop, global, temporal) |
| `02-temporal-contradictions.md` | Role changes, fact invalidation, temporal timeline |
| `03-connectors-and-skills.md` | Filesystem connector, custom connector creation, skill CRUD, end-to-end data flow |

## Adding new test cases

Create a new `.md` file in this directory. Structure:

1. Pick a scenario that exercises specific capabilities
2. Write the ingest content as a realistic transcript/document
3. Write search queries targeting each search tier:
   - **Tier 1:** Simple entity lookups ("Who is X?", "Tell me about Y")
   - **Tier 2:** Relationships, temporal, analytical, global, similarity
   - **Tier 3:** Multi-hop reasoning ("Which X are affected by Y because of Z?")
4. Write expected results for each query
