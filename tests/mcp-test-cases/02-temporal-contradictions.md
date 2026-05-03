# Test Case 2: Temporal Contradiction Detection

Tests that the system correctly handles information that changes over time — a person's role changing should invalidate the old fact and create a new one.

---

## Step 1: Ingest initial state

```
Use the company-brain ingest tool to ingest this with sourceType "meeting_transcript":

"Sales sync — March 15, 2026

Alice Chen, VP of Sales at Acme Corp, discussed the enterprise upgrade.
Their CTO Bob Zhang is evaluating our platform against CompetitorX.
Contact alice.chen@acme.com for pricing follow-up.
Deal value is $500K, expected close Q2."
```

## Step 2: Verify initial state

```
Use company-brain search to find: "What is Alice Chen's role at Acme Corp?"
```

**Expected:** Should show Alice Chen as VP of Sales at Acme Corp.

## Step 3: Ingest contradicting update

```
Use the company-brain ingest tool to ingest this with sourceType "meeting_transcript":

"Update from Alice Chen — March 22, 2026

Alice Chen has been promoted to CRO of Acme Corp.
Bob Zhang approved the enterprise purchase — deal is now $750K.
New timeline: close by end of Q1."
```

## Step 4: Verify contradiction detected

```
Use company-brain search to find: "What is Alice Chen's current role?"
```

**Expected:** Should show Alice Chen as CRO (not VP of Sales). The old VP fact should be invalidated.

## Step 5: Verify temporal timeline

```
Use the company-brain find_entity tool to find "Alice Chen", then use get_entity with her ID and includeTimeline set to true.
```

**Expected:** Timeline should show both the VP of Sales fact (invalidated) and the CRO fact (current), with correct dates.

## Step 6: Cross-entity verification

```
Use company-brain search to find: "What's happening with the Acme Corp deal?"
```

**Expected:** Should show the deal value updated from $500K to $750K, Bob Zhang's approval, and the new Q1 close timeline.
