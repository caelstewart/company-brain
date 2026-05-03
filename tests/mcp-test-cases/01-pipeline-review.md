# Test Case 1: Q2 Pipeline Review

A sales pipeline review meeting with multiple people, companies, deals, leadership changes, metrics, and risks. Exercises all search tiers.

---

## Step 1: Ingest

```
Use the company-brain ingest tool to ingest this meeting transcript:

"Q2 Pipeline Review — April 15, 2026

Attendees: Sarah Chen (VP Sales), Marcus Johnson (AE), Lisa Park (CSM), David Kim (Sales Ops)

Sarah: Let's start with the big ones. Marcus, where are we with the Meridian Health deal?

Marcus: Meridian is looking strong. $2.4M ARR, they're in final legal review. Our champion there, Dr. Rachel Torres, got promoted to Chief Medical Information Officer last month which actually accelerated things. She's pushing for signature by end of April.

Sarah: Excellent. What about NovaTech?

Marcus: NovaTech is trickier. $800K deal, was going well until their CTO James Liu left two weeks ago. The new interim CTO, Priya Sharma, wants to re-evaluate all pending vendor contracts. We're essentially back to technical validation.

Lisa: I've been working the NovaTech relationship from the CS side. Priya actually used our product at her previous company, Quantum Dynamics, so she's familiar with us. That could work in our favor.

Sarah: Good intel, Lisa. David, what's the pipeline looking like overall?

David: Total pipeline is $12.3M across 34 opportunities. Top 5 deals make up $6.8M. Win rate this quarter is tracking at 34%, up from 28% last quarter. The Meridian deal closing would push us to 41%.

Sarah: And the Helios Energy renewal?

Lisa: Helios is complicated. They're merging with Atlas Power, and the combined entity wants to renegotiate. Current contract is $1.2M, they want to consolidate to a single enterprise agreement. Could go up to $1.8M but timeline is uncertain — merger closes in June.

Marcus: I also wanted to flag that we got an intro to Cascade Financial through our investor board member, Patricia Owens. She knows their CEO, Tom Bradley. Initial meeting is next week.

Sarah: Great, make sure to loop in Lisa early on that one. Any risks we should be tracking?

David: Two concerns — the NovaTech CTO change is the biggest risk to Q2 numbers. And we're seeing longer procurement cycles across healthcare clients, which could push Meridian into Q3 if legal drags.

Sarah: Let's set up weekly check-ins on both. Meeting adjourned."
```

## Step 2: Entity lookup (Tier 1)

```
Use company-brain search to find: "Who is Rachel Torres?"
```

**Expected:** Should return Dr. Rachel Torres as CMIO at Meridian Health, promoted last month, champion on the $2.4M deal.

## Step 3: Relationship query (Tier 2)

```
Use company-brain search to find: "Who does Marcus Johnson work with?"
```

**Expected:** Should return internal team (Sarah Chen, Lisa Park, David Kim) and external contacts (Rachel Torres, Priya Sharma, Patricia Owens, Tom Bradley).

## Step 4: Multi-hop query (Tier 3)

```
Use company-brain search to find: "Which deals are at risk because of leadership changes?"
```

**Expected:** Should identify NovaTech ($800K, high risk from James Liu departure / Priya Sharma re-evaluation) and Meridian Health ($2.4M, positive impact from Rachel Torres promotion but timeline risk).

## Step 5: Global query (Tier 2)

```
Use company-brain search to find: "How's our pipeline looking?"
```

**Expected:** Should return pipeline metrics ($12.3M, 34 opportunities, 34% win rate), top deals, and key risks.

## Step 6: Temporal query (Tier 2)

```
Use company-brain search to find: "What changed since the beginning of April?"
```

**Expected:** Should return James Liu departure, Priya Sharma stepping in, deal movements, Cascade Financial intro, decisions from the meeting.
