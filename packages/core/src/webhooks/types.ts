/**
 * Webhook receiver types.
 *
 * Webhook sources define how to receive, verify, normalize, and ingest
 * incoming webhook payloads from any external service.
 */

import type { EpisodeInput } from '../types.js';

/**
 * Configuration for a webhook source.
 * Defines how incoming payloads are verified, normalized, and ingested.
 */
export interface WebhookSource {
  /** Unique source ID (e.g., "github-issues", "linear", "stripe") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Episode sourceType for ingested data (e.g., "github_issue", "linear_issue") */
  sourceType: string;

  // ─── Content Extraction ─────────────────────────────────────

  /** Template for episode content. Uses {{field}} and {{nested.field}} from payload. */
  contentTemplate?: string;
  /** Template for episode sourceId (dedup key). Uses {{field}} from payload. */
  sourceIdTemplate?: string;
  /** Dot-path to timestamp field in payload (e.g., "created_at", "event.timestamp") */
  dateField?: string;

  // ─── Signature Verification ─────────────────────────────────

  /** HMAC secret for signature verification */
  secret?: string;
  /** Header containing the signature (e.g., "x-hub-signature-256") */
  signatureHeader?: string;
  /** HMAC algorithm: "sha256" (default), "sha1" */
  signatureAlgorithm?: string;
  /** Prefix before the hex digest (e.g., "sha256=" for GitHub) */
  signaturePrefix?: string;

  // ─── Filtering ──────────────────────────────────────────────

  /** Header that carries the event type (e.g., "x-github-event") */
  eventTypeHeader?: string;
  /** Only process these event types. If empty, all events are accepted. */
  allowedEvents?: string[];

  // ─── Metadata ───────────────────────────────────────────────

  /** Dot-paths to extract from payload into episode metadata */
  metadataFields?: string[];

  /** Group/workspace to ingest into */
  groupId?: string;
}

/**
 * Result of processing a webhook.
 */
export interface WebhookResult {
  source: string;
  accepted: boolean;
  episodes: number;
  errors: number;
  /** Reason if not accepted (filtered event type, verification failed, etc.) */
  reason?: string;
}

/**
 * Raw webhook payload for the open ingest endpoint.
 * No source config needed — caller provides everything inline.
 */
export interface RawWebhookPayload {
  content: string;
  sourceType: string;
  sourceId?: string;
  validAt?: string;
  metadata?: Record<string, unknown>;
  groupId?: string;
}
