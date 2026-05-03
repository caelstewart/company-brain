import type { EvalFixture } from './harness.js';

export const baselineEvalFixtures: EvalFixture[] = [
  {
    id: 'hiring-ops-baseline',
    domain: 'hiring',
    description: 'Hiring loop data across Slack and call transcripts with restricted candidate feedback.',
    episodes: [
      {
        sourceType: 'slack_message',
        sourceId: 'hiring-slack-1',
        content: 'Ava Patel moved Omar Singh to onsite for the Staff Backend role. The panel wants a systems-design focus.',
        metadata: { channel: 'hiring-team', userId: 'U_AVA' },
      },
      {
        sourceType: 'call_transcript',
        sourceId: 'hiring-call-1',
        content: 'Interviewer: Omar was strongest on distributed systems. Concern: limited React depth.',
        metadata: { title: 'Omar Singh technical debrief' },
        visibility: {
          allowedGroups: ['recruiting'],
          classification: 'candidate_feedback',
        },
      },
    ],
    expectations: {
      minEntitiesCreated: 3,
      minFactsCreated: 2,
      queries: [
        {
          id: 'onsite-status',
          query: 'Who moved to onsite for Staff Backend?',
          mustInclude: ['Omar', 'onsite', 'Staff Backend'],
        },
        {
          id: 'restricted-feedback-hidden',
          query: 'What concerns did interviewers raise about Omar?',
          access: { principalId: 'eng-manager', groups: ['engineering'] },
          mustNotInclude: ['React depth'],
        },
        {
          id: 'restricted-feedback-visible',
          query: 'What concerns did interviewers raise about Omar?',
          access: { principalId: 'recruiter', groups: ['recruiting'] },
          mustInclude: ['React depth'],
        },
      ],
    },
  },
  {
    id: 'investment-graph-baseline',
    domain: 'investment',
    description: 'Companies, investors, and people with multi-hop relationship retrieval.',
    episodes: [
      {
        sourceType: 'crm_record',
        sourceId: 'crm-deal-1',
        content: 'Northstar Ventures introduced Maya Lin to OrbitalDB. Maya is advising OrbitalDB on enterprise procurement.',
        metadata: { recordType: 'relationship_note' },
      },
      {
        sourceType: 'meeting_transcript',
        sourceId: 'investor-call-1',
        content: 'OrbitalDB is raising a Series A. Northstar Ventures requested a data-room update before partner meeting.',
        metadata: { title: 'OrbitalDB investor update' },
      },
    ],
    expectations: {
      minEntitiesCreated: 3,
      minFactsCreated: 3,
      queries: [
        {
          id: 'intro-chain',
          query: 'How is Maya connected to OrbitalDB and Northstar?',
          mustInclude: ['Maya', 'OrbitalDB', 'Northstar'],
        },
        {
          id: 'fundraise-status',
          query: 'What is OrbitalDB raising?',
          mustInclude: ['Series A'],
        },
      ],
    },
  },
  {
    id: 'product-analytics-baseline',
    domain: 'product',
    description: 'Analytics, Slack, and incident-style context for a product team.',
    episodes: [
      {
        sourceType: 'analytics_event',
        sourceId: 'analytics-1',
        content: 'Checkout conversion dropped 18% after the payment step experiment launched.',
        metadata: { eventName: 'checkout_conversion_drop', dimensions: { experiment: 'payment-step-v2' } },
      },
      {
        sourceType: 'slack_message',
        sourceId: 'product-slack-1',
        content: 'Priya says payment-step-v2 likely increased 3DS retries for EU users. Rollback is scheduled tonight.',
        metadata: { channel: 'growth-alerts', userId: 'U_PRIYA' },
      },
    ],
    expectations: {
      minEntitiesCreated: 3,
      minFactsCreated: 2,
      queries: [
        {
          id: 'metric-cause',
          query: 'Why did checkout conversion drop?',
          mustInclude: ['payment-step-v2', '3DS', 'EU'],
        },
        {
          id: 'next-action',
          query: 'What is the mitigation for the payment experiment?',
          mustInclude: ['Rollback', 'tonight'],
        },
      ],
    },
  },
  {
    id: 'support-escalation-baseline',
    domain: 'support',
    description: 'Support ticket and CRM context with account health and escalation ownership.',
    episodes: [
      {
        sourceType: 'crm_record',
        sourceId: 'support-crm-1',
        content: 'Apex Health is blocked on SSO provisioning. CSM Elena owns the escalation and support engineer Marco is investigating SCIM mapping.',
        metadata: { recordType: 'support_escalation', stage: 'blocked', owner: 'Elena' },
      },
      {
        sourceType: 'slack_message',
        sourceId: 'support-slack-1',
        content: 'Marco found that Apex Health sends department as dept_code, causing SCIM mapping failures.',
        metadata: { channel: 'support-war-room', userId: 'U_MARCO' },
      },
    ],
    expectations: {
      minEntitiesCreated: 4,
      minFactsCreated: 3,
      queries: [
        {
          id: 'support-blocker',
          query: 'Why is Apex Health blocked?',
          mustInclude: ['SSO', 'SCIM', 'dept_code'],
        },
        {
          id: 'support-owner',
          query: 'Who owns the Apex Health escalation?',
          mustInclude: ['Elena'],
        },
      ],
    },
  },
  {
    id: 'security-incident-baseline',
    domain: 'security',
    description: 'Security incident timeline with restricted details.',
    episodes: [
      {
        sourceType: 'slack_message',
        sourceId: 'sec-slack-1',
        content: 'Security opened Incident 42 after anomalous admin token use in eu-west.',
        metadata: { channel: 'security-incidents', channelId: 'C_SEC' },
        visibility: { allowedGroups: ['security'], classification: 'security_incident' },
      },
      {
        sourceType: 'call_transcript',
        sourceId: 'sec-call-1',
        content: 'Nora rotated the admin token and disabled the stale automation user. No customer data access observed.',
        metadata: { title: 'Incident 42 bridge', participants: ['Nora', 'Platform'] },
        visibility: { allowedGroups: ['security'], classification: 'security_incident' },
      },
    ],
    expectations: {
      minEntitiesCreated: 3,
      minFactsCreated: 2,
      queries: [
        {
          id: 'incident-visible',
          query: 'What happened in Incident 42?',
          access: { principalId: 'sec-analyst', groups: ['security'] },
          mustInclude: ['admin token', 'eu-west'],
        },
        {
          id: 'incident-hidden',
          query: 'What happened in Incident 42?',
          access: { principalId: 'pm', groups: ['product'] },
          minResults: 0,
          mustNotInclude: ['admin token'],
        },
      ],
    },
  },
  {
    id: 'engineering-architecture-baseline',
    domain: 'engineering',
    description: 'Architecture decisions and dependencies across docs and meetings.',
    episodes: [
      {
        sourceType: 'document',
        sourceId: 'arch-doc-1',
        content: 'Project Atlas depends on the EventBridge migration before replacing the legacy queue consumer.',
        metadata: { title: 'Atlas architecture plan' },
      },
      {
        sourceType: 'meeting_transcript',
        sourceId: 'arch-meeting-1',
        content: 'Decision: keep the legacy queue read path until EventBridge replay tests pass. Owner is Samir.',
        metadata: { title: 'Atlas architecture review' },
      },
    ],
    expectations: {
      minEntitiesCreated: 4,
      minFactsCreated: 3,
      queries: [
        {
          id: 'dependency-chain',
          query: 'What blocks Project Atlas?',
          mustInclude: ['EventBridge', 'legacy queue'],
        },
        {
          id: 'decision-owner',
          query: 'Who owns the Atlas queue migration decision?',
          mustInclude: ['Samir'],
        },
      ],
    },
  },
];

export const pressureEvalFixtures: EvalFixture[] = [
  {
    id: 'messy-investor-crm-pressure',
    domain: 'investment',
    description: 'Noisy CRM and Slack fragments with aliases, uncertainty, duplicate company names, and next-step reasoning.',
    episodes: [
      {
        sourceType: 'crm_record',
        sourceId: 'pressure-investor-1',
        content: 'copy/paste from elena: "north star / Northstar?? intro\'d maya l. to orbital db ppl yday. she\'s helping w/ ent procurement. sounds like ser A, partner mtg maybe fri, need fb before then" -- not sure if OrbitalDB legal name is Orbital Database Inc.',
        metadata: {
          recordType: 'raw_note',
          owner: 'elena',
          fields: { certainty: 'low-medium', source: 'forwarded dm' },
        },
      },
      {
        sourceType: 'slack_message',
        sourceId: 'pressure-investor-2',
        content: 'thread dump: maya: "procurement blockers are security questionnaire + DPA"; northstar person said "get data room refresh before partner mtg". someone typed Orbital DB as ODB in the thread.',
        metadata: {
          channel: 'investor-notes',
          channelId: 'C_INV',
          threadMessages: [
            { user: 'U_ELENA', text: 'ODB == Orbital DB, same co' },
            { user: 'U_MAYA', text: 'I can unblock procurement if security questionnaire is ready.' },
          ],
        },
      },
    ],
    expectations: {
      minEntitiesCreated: 5,
      minFactsCreated: 4,
      requiredEntities: ['maya', 'orbital', 'northstar'],
      requiredFacts: ['series a', 'partner mtg'],
      queries: [
        {
          id: 'messy-investor-chain',
          query: 'what is maya doing for orbital db and how is northstar involved?',
          mustInclude: ['Maya', 'Orbital', 'Northstar'],
          answerMustInclude: ['procurement'],
          requireCitations: true,
          minAnswerConfidence: 0.2,
        },
        {
          id: 'messy-investor-next-step',
          query: 'what needs to happen before the partner meeting?',
          mustInclude: ['data room'],
          answerMustInclude: ['data room'],
          requireCitations: true,
        },
      ],
    },
  },
  {
    id: 'messy-permissions-pressure',
    domain: 'security',
    description: 'Restricted incident data with decoys and public-safe summaries.',
    episodes: [
      {
        sourceType: 'slack_message',
        sourceId: 'pressure-sec-public',
        content: 'public-ish status: infra had a weird thing in eu-west. Nora says customer impact not observed. more details in sec channel.',
        metadata: { channel: 'eng-updates', channelId: 'C_ENG' },
      },
      {
        sourceType: 'slack_message',
        sourceId: 'pressure-sec-private',
        content: 'SEC PRIVATE: incident 42 = anomalous admin token use. rotated token, disabled stale automation user svc-old-17. do NOT share token path outside security. no customer data access seen so far.',
        metadata: {
          channel: 'security-incidents',
          channelId: 'C_SEC',
          reactions: [{ name: 'rotating_light', count: 4 }],
        },
        visibility: { allowedGroups: ['security'], classification: 'security_incident' },
      },
    ],
    expectations: {
      minEntitiesCreated: 3,
      minFactsCreated: 2,
      forbiddenFacts: ['fake-root-cause'],
      queries: [
        {
          id: 'security-public-hidden',
          query: 'what happened in incident 42?',
          access: { principalId: 'pm', groups: ['product'] },
          minResults: 0,
          mustNotInclude: ['admin token', 'svc-old-17'],
          answerMustNotInclude: ['admin token', 'svc-old-17'],
        },
        {
          id: 'security-visible',
          query: 'what happened in incident 42 and what did Nora do?',
          access: { principalId: 'nora', groups: ['security'] },
          mustInclude: ['admin token', 'stale automation'],
          answerMustInclude: ['admin token'],
          answerMustNotInclude: ['root cause was'],
          requireCitations: true,
        },
      ],
    },
  },
  {
    id: 'messy-product-analytics-pressure',
    domain: 'product',
    description: 'Analytics payloads, Slack shorthand, contradictory rollout status, and metric causality.',
    episodes: [
      {
        sourceType: 'analytics_event',
        sourceId: 'pressure-analytics-1',
        content: 'metric dump: chkout_conv -18.4 pct WoW after pmt-step-v2 ramp 50% -> 100%. 3ds_retry_eu up 2.7x. US flat. raw dashboard note says "correlation not proven".',
        metadata: {
          eventName: 'checkout_regression',
          dimensions: { experiment: 'payment-step-v2', region: 'EU', ramp: '100%' },
          properties: { checkout_conversion_delta: -18.4, retries_multiplier: 2.7 },
        },
      },
      {
        sourceType: 'slack_message',
        sourceId: 'pressure-product-1',
        content: 'priya: looks like pmt-step-v2/3DS is the thing. fraud says dont nuke logs. rollback tonight unless they can isolate narrow cohort. later edit: rollback started 22:10.',
        metadata: {
          channel: 'growth-alerts',
          channelId: 'C_GROWTH',
          userId: 'U_PRIYA',
          threadMessages: [{ user: 'U_FRAUD', text: 'preserve eu retry logs pls' }],
        },
        visibility: { allowedGroups: ['growth', 'fraud'] },
      },
    ],
    expectations: {
      minEntitiesCreated: 4,
      minFactsCreated: 4,
      requiredFacts: ['18.4', '3ds_retry_eu', 'rollback'],
      queries: [
        {
          id: 'product-cause',
          query: 'why did checkout conversion drop?',
          access: { principalId: 'growth', groups: ['growth'] },
          mustInclude: ['payment-step-v2', '3DS', 'EU'],
          answerMustInclude: ['3DS'],
          requireCitations: true,
        },
        {
          id: 'product-caveat',
          query: 'is the checkout drop proven to be caused by payment-step-v2?',
          access: { principalId: 'growth', groups: ['growth'] },
          mustInclude: ['correlation not proven'],
          answerMustInclude: ['correlation'],
          answerMustNotInclude: ['definitely caused'],
          requireCitations: true,
        },
      ],
    },
  },
  {
    id: 'messy-architecture-temporal-pressure',
    domain: 'engineering',
    description: 'Architecture notes with abbreviations, temporary decisions, ownership, and blocker chains.',
    episodes: [
      {
        sourceType: 'document',
        sourceId: 'pressure-arch-1',
        content: 'atlas scratchpad v messy: can\'t cut legacy q consumer -> EB until replay tests green. keep read path. samir owns. also someone said "maybe kafka?" but no decision.',
        metadata: { title: 'atlas scratchpad', fields: { docStatus: 'draft' } },
      },
      {
        sourceType: 'call_transcript',
        sourceId: 'pressure-arch-2',
        content: 'standup: replay tests failing on duplicate event ids. Samir says EventBridge migration blocked til idempotency patch lands. decision still: legacy read path stays.',
        metadata: {
          title: 'atlas standup',
          turns: [
            { speaker: 'Samir', text: 'blocked until idempotency patch lands' },
            { speaker: 'Mina', text: 'do not switch the consumer yet' },
          ],
        },
      },
    ],
    expectations: {
      minEntitiesCreated: 4,
      minFactsCreated: 4,
      requiredEntities: ['atlas', 'eventbridge', 'samir'],
      queries: [
        {
          id: 'arch-blocker',
          query: 'what blocks atlas from moving off the legacy queue consumer?',
          mustInclude: ['replay tests', 'idempotency'],
          answerMustInclude: ['idempotency'],
          requireCitations: true,
        },
        {
          id: 'arch-no-fake-kafka',
          query: 'did the team decide to use kafka for atlas?',
          mustInclude: ['maybe kafka'],
          answerMustNotInclude: ['decided to use kafka'],
          requireCitations: true,
        },
      ],
    },
  },
  {
    id: 'source-acl-pressure',
    domain: 'security',
    description: 'Source-native ACLs must gate restricted records while noisy decoys must not become claims.',
    episodes: [
      {
        sourceType: 'raw_dump',
        sourceId: 'pressure-acl-public',
        content: 'public status crumbs: incident 77 had no known customer impact. ignore the cafeteria chatter saying "root cause was pizza deploy" because that was a joke, not evidence.',
      },
      {
        sourceType: 'slack_message',
        sourceId: 'pressure-acl-security',
        content: 'private copied channel message: incident 77 token path was /prod/ci/deploy_token. Nora rotated it at 02:14. The note saying "pizza deploy" is explicitly not the root cause.',
        metadata: {
          workspaceId: 'T1',
          channelId: 'C_SECURITY_INCIDENTS',
          visibleGroupIds: ['security'],
        },
      },
      {
        sourceType: 'slack_message',
        sourceId: 'pressure-acl-recruiting',
        content: 'private copied recruiting channel message: candidate Quinn Rivera strong systems signal, weak PM collaboration. Recruiter Mia owns references.',
        metadata: {
          workspaceId: 'T1',
          channelId: 'C_RECRUITING_PRIVATE',
          visibleGroupIds: ['recruiting'],
        },
      },
    ],
    expectations: {
      minEntitiesCreated: 4,
      minFactsCreated: 3,
      forbiddenFacts: ['pizza deploy root cause'],
      queries: [
        {
          id: 'source-acl-hidden-from-product',
          query: 'what was the token path in incident 77?',
          access: { principalId: 'pm', groups: ['product'] },
          minResults: 0,
          mustNotInclude: ['/prod/ci/deploy_token'],
          answerMustNotInclude: ['/prod/ci/deploy_token'],
        },
        {
          id: 'source-acl-visible-to-security',
          query: 'what was the token path in incident 77 and what did Nora do?',
          access: { principalId: 'nora', groups: ['slack:security'] },
          mustInclude: ['/prod/ci/deploy_token', 'rotated'],
          answerMustInclude: ['/prod/ci/deploy_token', 'rotated'],
          answerMustNotInclude: ['pizza deploy was the root cause'],
          requireCitations: true,
        },
        {
          id: 'recruiting-hidden-from-engineering',
          query: 'what feedback exists for Quinn Rivera?',
          access: { principalId: 'eng-loop', groups: ['engineering'] },
          mustNotInclude: ['weak PM collaboration'],
          answerMustNotInclude: ['weak PM collaboration'],
        },
        {
          id: 'recruiting-visible-to-recruiter',
          query: 'what feedback exists for Quinn Rivera?',
          access: { principalId: 'recruiter', groups: ['slack:recruiting'] },
          mustInclude: ['strong systems', 'weak PM collaboration'],
          answerMustInclude: ['strong systems'],
          requireCitations: true,
        },
      ],
    },
  },
];

export const allEvalFixtures: EvalFixture[] = [
  ...baselineEvalFixtures,
  ...pressureEvalFixtures,
];
