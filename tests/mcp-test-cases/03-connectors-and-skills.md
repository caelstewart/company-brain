# Test Case 3: Connectors and Skills

Tests the connector lifecycle (list, connect, sync, create custom) and skill CRUD (list, get, save, use). These are the integration tests that validate data can flow from external sources into the knowledge graph, and that skills can be created and retrieved.

---

## Part A: Filesystem Connector

### Step 1: Create test data

Before starting, create a folder with a few test files:

```bash
mkdir -p /tmp/brain-test-docs
echo "Meeting notes from April 10, 2026: John Smith from Raven Labs discussed a $200K platform deal. Their VP of Engineering, Maria Garcia, will lead the technical evaluation. Contact john.smith@ravenlabs.com." > /tmp/brain-test-docs/meeting-notes.md
echo "Slack summary: The design team at Raven Labs (led by Tom Baker) shipped their new dashboard. Maria Garcia approved the final specs. Timeline: launch by June 1." > /tmp/brain-test-docs/slack-digest.md
echo "Support ticket #4521: Raven Labs reported a bug in the export API. Assigned to our engineer Kevin Park. Priority: high. Maria Garcia escalated it." > /tmp/brain-test-docs/support-ticket.md
```

### Step 2: List available connectors

```
Use company-brain list_connectors
```

**Expected:** Should show at least: filesystem and nango as available types. Custom REST connector definitions may also appear if configured.

### Step 3: Connect the filesystem source

```
Use company-brain connect with id "test-docs", type "filesystem", config {"rootDir": "/tmp/brain-test-docs"}
```

**Expected:** Should succeed and confirm the filesystem connector is connected.

### Step 4: Sync the connector

```
Use company-brain sync_connector with id "test-docs"
```

**Expected:** Should pull all 3 files, ingest them, and report how many episodes were created. Each file's content goes through the full extraction pipeline.

### Step 5: Verify data landed in the graph

```
Use company-brain search to find: "What do we know about Raven Labs?"
```

**Expected:** Should return information from all 3 files — the $200K deal with John Smith, Maria Garcia as VP of Engineering, Tom Baker's design team, the export API bug, Kevin Park assigned to the ticket.

### Step 6: Verify entity relationships

```
Use company-brain find_entity to find "Maria Garcia", then use get_entity with her ID and includeRelated set to true.
```

**Expected:** Maria Garcia should be connected to Raven Labs, and should have facts from multiple sources (meeting notes, slack digest, support ticket).

### Step 7: Test incremental sync

```bash
echo "Update: Kevin Park fixed the Raven Labs export bug. Maria Garcia confirmed the fix works. Ticket #4521 closed." > /tmp/brain-test-docs/ticket-update.md
```

```
Use company-brain sync_connector with id "test-docs"
```

**Expected:** Should only pick up the new file (incremental sync). Should NOT re-ingest the 3 files from step 4.

### Step 8: Verify incremental data

```
Use company-brain search to find: "What happened with the Raven Labs export bug?"
```

**Expected:** Should show both the original bug report AND the fix — Kevin Park fixed it, Maria Garcia confirmed.

---

## Part B: Custom REST API Connector

### Step 9: Save a custom connector definition

```
Use company-brain save_connector with definition:
{
  "id": "jsonplaceholder-posts",
  "name": "JSONPlaceholder Posts",
  "url": "https://jsonplaceholder.typicode.com/posts",
  "records": null,
  "content": "{{title}}\n\n{{body}}",
  "sourceId": "jsonplaceholder://posts/{{id}}",
  "sourceType": "blog_post",
  "dateField": null,
  "rateLimitMs": 100
}
```

**Expected:** Should save the connector definition and register it as a new connector type.

### Step 10: Verify custom connector appears

```
Use company-brain list_connectors
```

**Expected:** Should now show `jsonplaceholder-posts` alongside the built-in types.

### Step 11: Connect and sync the custom connector

```
Use company-brain connect with id "test-posts", type "jsonplaceholder-posts", config {}
```

```
Use company-brain sync_connector with id "test-posts"
```

**Expected:** Should fetch posts from JSONPlaceholder API, ingest them as episodes, and extract entities/facts. Note: JSONPlaceholder returns 100 dummy posts — this tests pagination and bulk ingestion.

### Step 12: Verify custom connector data

```
Use company-brain search to find: "What topics are covered in the blog posts?"
```

**Expected:** Should return results from the ingested JSONPlaceholder posts.

---

## Part C: Skills

### Step 13: List existing skills

```
Use company-brain list_skills
```

**Expected:** Should show any built-in skills (like `query`) and their trigger patterns.

### Step 14: Create a new skill

```
Use company-brain save_skill with:
- id: "deal-summary"
- name: "Deal Summary"
- description: "Summarize everything known about a deal or account"
- triggers: ["summarize deal", "deal summary", "account overview", "what do we know about"]
- content: "# Deal Summary Skill\n\n## When to use\nWhen asked to summarize a deal, account, or company.\n\n## Protocol\n1. Search for the company/deal name\n2. Find the main entity and get its full details with timeline\n3. Find all related people and their roles\n4. Compile into a structured summary:\n   - Company overview\n   - Key contacts and roles\n   - Deal value and stage\n   - Recent activity\n   - Risks and blockers\n   - Next steps"
- priority: 80
```

**Expected:** Should save the skill to `~/.company-brain/skills/deal-summary.md` and confirm.

### Step 15: Verify the skill was saved

```
Use company-brain list_skills
```

**Expected:** Should now show `deal-summary` in the list with its triggers.

### Step 16: Read the skill back

```
Use company-brain get_skill with id "deal-summary"
```

**Expected:** Should return the full skill content matching what was saved in step 14.

### Step 17: Update the skill

```
Use company-brain save_skill with:
- id: "deal-summary"
- name: "Deal Summary"
- description: "Summarize everything known about a deal or account, including risk assessment"
- triggers: ["summarize deal", "deal summary", "account overview", "what do we know about", "deal risk"]
- content: "# Deal Summary Skill\n\n## When to use\nWhen asked to summarize a deal, account, or company, or assess deal risk.\n\n## Protocol\n1. Search for the company/deal name\n2. Find the main entity and get its full details with timeline\n3. Find all related people and their roles\n4. Check for any churn risk signals or blockers\n5. Compile into a structured summary:\n   - Company overview\n   - Key contacts and roles\n   - Deal value and stage\n   - Recent activity\n   - Risks and blockers (highlight these)\n   - Next steps\n   - Risk score: LOW / MEDIUM / HIGH"
- priority: 85
```

**Expected:** Should overwrite the existing skill. `get_skill` should return the updated version with "deal risk" trigger and risk score section.

---

## Part D: Sync All

### Step 18: Test sync_all

```
Use company-brain sync_all_connectors
```

**Expected:** Should attempt to sync both `test-docs` and `test-posts`. The filesystem connector should pick up no new files (incremental). The JSONPlaceholder connector may re-fetch (no date-based filtering on that API).

---

## Cleanup

```bash
rm -rf /tmp/brain-test-docs
```
