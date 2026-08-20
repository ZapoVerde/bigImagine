/**
 * @file orchestrator/src/server/admin/diagnostics.ts
 * @stamp 2026-08-20
 * @architectural-role IO Wrapper — read-only admin observability/read models over Postgres
 * @description
 * The admin-facing read side of the platform's background pipelines and stats pages: chat-memory
 * sync status, location render status + the Locations browser's known-locations roster, and the
 * LLM Stats page's row sources. Every read here is cross-user and read-only — the same
 * "roster every user, then query each one under its own RLS scope" (or withSystemScope for the
 * RLS-exempt llm_calls table) shape the rest of the codebase uses for admin reads. Deliberately no
 * configuration writes mix in here — those live in the sibling admin/settings modules.
 *
 * This file sits slightly over the 300-line budget as one deliberately coherent read-only domain
 * (bi_principles.md §10's "don't split merely to satisfy line count if doing so destroys a
 * coherent domain"): the four reads are the same roster/scope pattern and share their row-mapping
 * types; a line-count split would separate near-identical reads rather than genuine fault lines.
 *
 * @api-declaration
 * getChatMemorySyncStatus(db) — ChatMemorySyncStatusRow[]: the chat_memory_sync_status read side
 *   (migration 0055), proving each background pipeline stage (chunk/embed/distill) actually ran
 * getLocationRenderStatus(db) — LocationRenderStatusRow[]: the bg-gen pipeline's proof-it-ran read
 *   (bi_principles.md §11): per recently-touched location, which render stages actually completed
 * getLocationsAdmin(db) — LocationAdminRow[]: the Locations page's read-only known-locations table
 *   with parent, lifecycle status, image thumbnail, and owning chat titles (location.md §6.2.4)
 * listLlmStats(db, days) — LlmCallStatRow[]: the Usage & Cost section's row source (max 365 days,
 *   default 30 via the caller)
 * listTurnDisplayStats(db, days) — TurnDisplayMetricRow[]: the Timing section's row source
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected PostgresClient)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected PostgresClient)]
 */

import type { PostgresClient } from '../../io/postgres.js';
import {
  mapTurnDisplayMetricRow,
  type TurnDisplayMetricRow,
  type TurnDisplayMetricRowShape,
} from '../../io/turnDisplayMetrics.js';

// --- Chat-memory sync status (bi_principles.md §11) ---
// The read side of orchestrator/chatMemorySync.ts's chat_memory_sync_status table (migration
// 0055) — the review panel's actual purpose per the user: confirmation that each background
// pipeline stage (chunk/embed/distill) is actually working, not an editing surface. Unlike every
// other function in this file, this reads chat-scoped Postgres tables directly rather than the
// settings store, so it needs the same "roster every user, then query each one under its own RLS
// scope" shape chatMemorySync.ts's own tick loop uses (there is no single userId an admin key
// resolves to, and withSystemScope alone can't read a user_id-scoped, RLS-forced table).

export interface ChatMemorySyncStatusRow {
  chatId: string;
  chatTitle: string;
  lastAttemptAt: string;
  lastStatus: 'ok' | 'skipped' | 'error';
  lastStep: string | null;
  lastError: string | null;
  /** The Settings-tab prompt key the failing prompt is edited under (migration 0130) — set only
   *  when the failure was a malformed-output parse (LlmOutputParseError), null for every other
   *  failure kind. */
  lastErrorPromptName: string | null;
  /** The model's raw completion text that failed to parse (migration 0130), untouched — null for
   *  every non-parse failure kind (nothing to show for an HTTP/transport error). */
  lastErrorLlmReply: string | null;
  lastSuccessAt: string | null;
  lastChunksAdded: number | null;
  lastEntriesUpdated: number | null;
  consecutiveErrors: number;
  canonProposedCount: number;
  canonApprovedCount: number;
  canonLastProposedAt: string | null;
}

interface ChatMemorySyncStatusQueryRow {
  chat_id: string;
  chat_title: string;
  last_attempt_at: string;
  last_status: 'ok' | 'skipped' | 'error';
  last_step: string | null;
  last_error: string | null;
  last_error_prompt_name: string | null;
  last_error_llm_reply: string | null;
  last_success_at: string | null;
  last_chunks_added: number | null;
  last_entries_updated: number | null;
  consecutive_errors: number;
  canon_proposed_count: string;
  canon_approved_count: string;
  canon_last_proposed_at: string | null;
}

export async function getChatMemorySyncStatus(db: PostgresClient): Promise<ChatMemorySyncStatusRow[]> {
  const users = await db.withSystemScope((session) => session.query<{ user_id: string }>('select user_id from users'));
  const rows: ChatMemorySyncStatusRow[] = [];
  for (const { user_id: userId } of users) {
    const userRows = await db.withUserScope(userId, (session) =>
      session.query<ChatMemorySyncStatusQueryRow>(
        `select
           s.chat_id, cs.title as chat_title, s.last_attempt_at, s.last_status, s.last_step, s.last_error,
           s.last_error_prompt_name, s.last_error_llm_reply,
           s.last_success_at, s.last_chunks_added, s.last_entries_updated, s.consecutive_errors,
           coalesce(cf.proposed_count, 0)::text as canon_proposed_count,
           coalesce(cf.approved_count, 0)::text as canon_approved_count,
           cf.last_proposed_at as canon_last_proposed_at
         from chat_memory_sync_status s
         join chat_sessions cs on cs.chat_id = s.chat_id
         left join (
           select chat_id,
                  count(*) filter (where status = 'proposed') as proposed_count,
                  count(*) filter (where status = 'approved') as approved_count,
                  max(proposed_at) as last_proposed_at
           from canon_facts
           where chat_id is not null
           group by chat_id
         ) cf on cf.chat_id = s.chat_id
         order by (s.last_status = 'error') desc, s.last_attempt_at desc`,
      ),
    );
    for (const r of userRows) {
      rows.push({
        chatId: r.chat_id,
        chatTitle: r.chat_title,
        lastAttemptAt: r.last_attempt_at,
        lastStatus: r.last_status,
        lastStep: r.last_step,
        lastError: r.last_error,
        lastErrorPromptName: r.last_error_prompt_name,
        lastErrorLlmReply: r.last_error_llm_reply,
        lastSuccessAt: r.last_success_at,
        lastChunksAdded: r.last_chunks_added,
        lastEntriesUpdated: r.last_entries_updated,
        consecutiveErrors: r.consecutive_errors,
        canonProposedCount: Number(r.canon_proposed_count),
        canonApprovedCount: Number(r.canon_approved_count),
        canonLastProposedAt: r.canon_last_proposed_at,
      });
    }
  }
  return rows;
}

// --- Location render status (bi_principles.md §11) ---
// The read side of the bg-gen pipeline: one row per recently-touched location proving which
// stages actually ran — described (visual_description filled by describeLocation.ts / the
// describer's Definition half), rendered (image_url + render hash written by
// generateLocationImage.ts), plus the location's segway status (migration 0067). Same "roster
// every user, then query each one under its own RLS scope" shape as getChatMemorySyncStatus
// above — locations is user_id-scoped + RLS-forced, so an admin key alone can't read it.

export interface LocationRenderStatusRow {
  locationId: string;
  name: string;
  status: string | null;
  /** visual_description non-empty (the describer or the scraper's name seed). */
  described: boolean;
  /** definition non-empty (the describer's Definition half, migration 0078). */
  defined: boolean;
  /** image_url present — generateLocationImage.ts wrote a render for this row. */
  rendered: boolean;
  /** image_render_hash present — the cache-validation key (migration 0076). */
  hasRenderHash: boolean;
  imageGeneratedAt: string | null;
  updatedAt: string;
}

interface LocationRenderStatusQueryRow {
  location_id: string;
  name: string;
  status: string | null;
  described: boolean;
  defined: boolean;
  rendered: boolean;
  has_render_hash: boolean;
  image_generated_at: string | null;
  updated_at: string;
}

/** How many most-recently-touched locations each user's status table shows — a proof-it-ran
 *  surface, not a browser, so a cap keeps it cheap without hiding failures (errors surface as
 *  stale/missing stages on the newest rows). */
const LOCATION_RENDER_STATUS_LIMIT = 50;

export async function getLocationRenderStatus(db: PostgresClient): Promise<LocationRenderStatusRow[]> {
  const users = await db.withSystemScope((session) => session.query<{ user_id: string }>('select user_id from users'));
  const rows: LocationRenderStatusRow[] = [];
  for (const { user_id: userId } of users) {
    const userRows = await db.withUserScope(userId, (session) =>
      session.query<LocationRenderStatusQueryRow>(
        `select location_id, name, status,
                (visual_description is not null and visual_description <> '') as described,
                (definition is not null and definition <> '') as defined,
                (image_url is not null) as rendered,
                (image_render_hash is not null) as has_render_hash,
                image_generated_at, updated_at
         from locations
         order by updated_at desc
         limit $1`,
        [LOCATION_RENDER_STATUS_LIMIT],
      ),
    );
    for (const r of userRows) {
      rows.push({
        locationId: r.location_id,
        name: r.name,
        status: r.status,
        described: r.described,
        defined: r.defined,
        rendered: r.rendered,
        hasRenderHash: r.has_render_hash,
        imageGeneratedAt: r.image_generated_at,
        updatedAt: r.updated_at,
      });
    }
  }
  return rows;
}

// --- Locations browser (location.md §6.2.4) ---
// The Locations page's read-only known-locations table: every row with its parent (via
// parent_location_id, migration 0083), lifecycle status, and image thumbnail. Cross-user roster,
// the same shape as getLocationRenderStatus above — locations is user_id-scoped + RLS-forced,
// so an admin key alone can't read it. Parent-first ordering (coalesce on the parent's name)
// groups a place with its rooms.

export interface LocationAdminRow {
  locationId: string;
  userId: string;
  name: string;
  parentName: string | null;
  status: string | null;
  imageUrl: string | null;
  updatedAt: string;
  chatTitles: string[];
}

// db/migrations/0096's link table replaces the old anchor_chat_id column, so "which chat(s) is
// this row in" is now a join, not a field — surfaced here as titles (chat_sessions.title) so the
// roster visibly proves the chat-scope fix: an auto-registered row's chatTitles empties out the
// instant its last owning chat is deleted or its anchor message is edited away, at which point the
// cleanup trigger removes the row itself and it stops appearing at all. User-authored rows
// (status is null) never get a link row, so chatTitles is always [] for them.
export async function getLocationsAdmin(db: PostgresClient): Promise<LocationAdminRow[]> {
  const users = await db.withSystemScope((session) => session.query<{ user_id: string }>('select user_id from users'));
  const rows: LocationAdminRow[] = [];
  for (const { user_id: userId } of users) {
    const userRows = await db.withUserScope(userId, (session) =>
      session.query<{
        location_id: string;
        name: string;
        parent_name: string | null;
        status: string | null;
        image_url: string | null;
        updated_at: string;
        chat_titles: string[] | null;
      }>(
        `select l.location_id, l.name, p.name as parent_name, l.status, l.image_url, l.updated_at,
                (select coalesce(array_agg(cs.title order by cs.title), '{}')
                 from location_chat_links lcl
                 join chat_sessions cs on cs.chat_id = lcl.chat_id
                 where lcl.location_id = l.location_id) as chat_titles
         from locations l
         left join locations p on p.location_id = l.parent_location_id
         order by coalesce(p.name, l.name), l.name`,
      ),
    );
    for (const r of userRows) {
      rows.push({
        locationId: r.location_id,
        userId,
        name: r.name,
        parentName: r.parent_name,
        status: r.status,
        imageUrl: r.image_url,
        updatedAt: r.updated_at,
        chatTitles: r.chat_titles ?? [],
      });
    }
  }
  return rows;
}


// --- LLM Stats page data reads (docs/plans/llm-stats-page-plan.md) ---
// The Usage & Cost and Timing sections' row sources. Both are cross-user admin reads via
// db.withSystemScope — llm_calls is deliberately RLS-exempt (the gate's own household-wide cap
// check needs to sum across users, 0035), and turn_display_metrics is user_scoped but the
// household's own stats page needs the same roster-every-user shape getLocationsAdmin already
// uses. Bounded lookback (max 365 days, default 30) keeps both comfortably small at household
// scale — no pagination needed (plan Edge Cases).

export interface LlmCallStatRow {
  callId: string;
  createdAt: string; // ISO
  userId: string;
  kind: 'chat' | 'agent_routine' | 'system';
  taskId: string;
  jobId: string | null;
  outcome: 'ok' | 'refused' | 'error';
  /** The LlmProfile.kind that served the call, or '(pre-tracking)' for rows written before
   *  migration 0101 — the numeric columns stay null for those rows, excluded from sums/averages,
   *  not treated as zero. */
  providerKind: string;
  model: string;
  /** The finer one-level-deeper label for 'system'-kind calls (docs/plans/
   *  llm-call-label-breakdown-plan.md), or null — for kind 'chat'/'agent_routine' rows, for
   *  rows written before migration 0103, and for any system call no label applies to. Null is
   *  passed through untouched, deliberately NOT substituted like providerKind/model: a null
   *  call_label isn't necessarily a pre-migration artifact, so the Stats page falls back to the
   *  row's own kind for those. */
  callLabel: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  attempt: number;
}

interface LlmCallRowShape {
  call_id: string;
  created_at: Date;
  user_id: string;
  kind: 'chat' | 'agent_routine' | 'system';
  task_id: string;
  job_id: string | null;
  outcome: 'ok' | 'refused' | 'error';
  provider_kind: string | null;
  model: string | null;
  call_label: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: string | null; // numeric columns come back as strings from node-postgres
  duration_ms: number | null;
  attempt: number;
}

const PRE_TRACKING = '(pre-tracking)';

export async function listLlmStats(db: PostgresClient, days: number): Promise<LlmCallStatRow[]> {
  const rows = await db.withSystemScope((session) =>
    session.query<LlmCallRowShape>(
      `select call_id, created_at, user_id, kind, task_id, job_id, outcome, provider_kind, model, call_label,
              prompt_tokens, completion_tokens, total_tokens, cache_read_tokens, cost_usd, duration_ms, attempt
       from llm_calls
       where created_at > now() - ($1 || ' days')::interval
       order by created_at desc`,
      [days],
    ),
  );
  return rows.map((r) => ({
    callId: r.call_id,
    createdAt: r.created_at.toISOString(),
    userId: r.user_id,
    kind: r.kind,
    taskId: r.task_id,
    jobId: r.job_id,
    outcome: r.outcome,
    providerKind: r.provider_kind ?? PRE_TRACKING,
    model: r.model ?? PRE_TRACKING,
    // Deliberately no '(pre-tracking)'-style substitution: a null call_label isn't necessarily
    // a pre-migration artifact (it may just be an unlabeled system call), so the Stats page
    // falls back to the row's own kind for those — never a fabricated group (llm-call-label-
    // breakdown-plan.md Edge Cases).
    callLabel: r.call_label,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens,
    cacheReadTokens: r.cache_read_tokens,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    durationMs: r.duration_ms,
    attempt: r.attempt,
  }));
}

export async function listTurnDisplayStats(db: PostgresClient, days: number): Promise<TurnDisplayMetricRow[]> {
  const rows = await db.withSystemScope((session) =>
    session.query<TurnDisplayMetricRowShape>(
      `select turn_display_metric_id, user_id, chat_id, message_id, dispatch_at,
              first_token_ms, last_token_ms, display_land_ms, display_settle_ms,
              header_start_ms, header_stop_ms, body_start_ms, body_stop_ms,
              footer_start_ms, footer_stop_ms, outcome, terminated_at_ms, created_at
       from turn_display_metrics
       where created_at > now() - ($1 || ' days')::interval
       order by created_at desc`,
      [days],
    ),
  );
  return rows.map(mapTurnDisplayMetricRow);
}