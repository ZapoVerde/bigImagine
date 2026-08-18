/**
 * @file orchestrator/src/server/portraitRoutes.ts
 * @stamp 2026-08-17
 * @architectural-role IO Wrapper — the Portrait Studio's HTTP surface + the portraits
 *   subsystem's DB read/write seam (bi_principles.md §8), the file wiki.ts's preamble names as
 *   the wrapper that shapes visual_wiki_entries rows before the pure formatters see them
 * @description
 * The Portrait Studio's routes (docs/plans/completed/portrait-studio-plan.md §New files): entity CRUD,
 * layer-stack management, generate/feedback, and wiki browse/edit — the same posture as
 * adminServer.ts (parse-body pure functions + handler functions, no HTTP plumbing of their own;
 * httpServer.ts's route table wires them with its withUser/withAdmin gates).
 *
 * Auth split, matching the data each surface touches:
 * - User-gated (withUser — userId from the API key, never the body): everything that reads or
 *   writes the user-scoped visual_* tables — entity CRUD, wiki browse/edit, and the
 *   generate/feedback actions, which run under the calling user's withUserScope (the RLS policy
 *   on every visual_* table is user_scoped, migration 0105, so the userId IS the scope). GET
 *   /layers is user-gated too: the manifest is household-global, but reading it is harmless and
 *   the Studio tab renders for any authenticated user.
 * - Admin-gated (withAdmin): POST /layers — writing visual_layer_stack is an
 *   orchestrator_settings write, and every orchestrator_settings write on this server is
 *   admin-gated (the Connections/Settings precedent). The Manage Layers panel therefore prompts
 *   for the admin key exactly like Connections tab writes do. The plan's in-use guard is
 *   enforced here, not just in the UI: a manifest that would drop the `subject` layer is
 *   rejected (400), and so is one that would drop a layer with entities still attached (409,
 *   plan §Edge Cases — no cascading-delete story).
 *
 * The orchestrator calls are thin: read the JSON body, validate the shape, hand off to
 * runPortraitGenerationRound / submitPortraitFeedback, map the fail-open result to a status.
 *
 * @api-declaration
 * parseCreateEntityBody / parseUpdateEntityBody / parseLayerManifestBody / parseGenerateBody /
 *   parseFeedbackBody / parseWikiPatchBody / parseFromCharacterBody — pure body parsers
 *   (undefined = invalid)
 * handlePortraitEntities(req, res, deps, userId, url) — CRUD on /v1/portraits/entities
 * handlePortraitEntityFromCastCharacter(req, res, deps, userId) — POST
 *   /v1/portraits/entities/from-cast-character (portrait-studio-standalone-subjects-plan.md Part C —
 *   always-inserts a new, unlinked subject entity seeded from a cast character's appearance/persona)
 * handlePortraitWiki(req, res, deps, userId, url) — list/edit/delete on /v1/portraits/wiki
 * handlePortraitLayersGet / handlePortraitLayersSet — GET/POST /v1/portraits/layers
 * handlePortraitGenerate / handlePortraitFeedback — POST /v1/portraits/generate,
 *   /v1/portraits/feedback
 * handlePortraitEpisodeReflect — POST /v1/portraits/episodes/:id/reflect (retry reflection on a
 *   failed/incomplete episode — the reflection state machine is retryable by design)
 * handlePortraitHistory — GET /v1/portraits/history (episode → lesson → use → result ledger)
 * handlePortraitLessons — GET /v1/portraits/lessons (the lesson ledger, state included)
 * handlePortraitsEnabledGet / handlePortraitsEnabledSet — GET /v1/portraits-enabled and
 *   GET/POST /v1/admin/portraits-enabled (portrait-chain-hardening-plan.md's kill switch)
 * handlePortraitLlmConnectionGet / handlePortraitLlmConnectionSet — GET/POST
 *   /v1/admin/portrait-llm-connection (portrait-studio-connection-picker-plan.md — Portrait
 *   Studio's own connection subscription, read by resolvePortraitLlm below)
 * requirePortraitsEnabled(deps, res) — the shared 403 gate every gated handler opens with
 *   (returns false and answers 403 when visual_portraits_enabled reads 'false')
 *
 * @contract
 *   assertions:
 *     purity:          body parsers pure; handlers impure (Postgres IO, orchestrator_settings,
 *                      the LLM + image provider via the orchestrators)
 *     state_ownership: []
 *     external_io:     [Postgres (visual_entities/visual_wiki_entries/visual_candidates via
 *                       db.withUserScope; characters for the from-cast-character seed), the LLM and
 *                       the active portrait image provider via the orchestrators]
 *     never:           throws. Every failure path logs and answers with a status + error body.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../io/logger.js';
import type { PostgresClient } from '../io/postgres.js';
import { loadLayerManifest, type LayerDefinition, type LayerManifest } from '../portraits/layerStack.js';
import type { WikiSubscription } from '../portraits/wiki.js';
import { describeStudioSubject } from '../orchestrator/describeStudioSubject.js';
import { describeStudioSlots } from '../orchestrator/describeStudioSlots.js';
import { runPortraitGenerationRound, retryPortraitCandidateRender } from '../orchestrator/portraitGeneration.js';
import { submitPortraitFeedback } from '../orchestrator/portraitFeedback.js';
import { createLlmProviderForProfile } from '../io/llm/index.js';
import { createGatedLlmProvider } from '../io/llm/llmGate.js';
import type { LlmProvider } from '../io/llm/types.js';
import { readJsonBody, sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';

// Portrait Studio's own connection subscription (portrait-studio-connection-picker-plan.md): the
// household's active connection (deps.llm) is still the fallback, but the Studio's sidebar panel
// can subscribe every LLM call in this module — the subject describer, the generation round, and
// feedback/reflection alike — to one specific connection, independent of whatever the household
// default is or later becomes. Same resolution shape as chat_memory_profile
// (orchestrator/chatMemorySync.ts) and a chat's own params.profile (server/turnExecution.ts):
// empty/unknown name falls back to deps.llm, never throws.
async function resolvePortraitLlm(deps: HttpServerDeps): Promise<LlmProvider> {
  const connectionName = await deps.settings.get('portrait_llm_connection');
  if (!connectionName) return deps.llm;
  const profile = await deps.llmConnections.resolveByName(connectionName);
  if (!profile) {
    log.error(`portraits: portrait_llm_connection names unknown connection "${connectionName}" — falling back to the active connection`);
    return deps.llm;
  }
  return createGatedLlmProvider(createLlmProviderForProfile(profile), deps.db, deps.settings, profile);
}

/** One visual_entities row as the Studio sees it — full, no redaction (nothing secret here). */
export interface PortraitEntityRow {
  entity_id: string;
  layer_id: string;
  character_id: string | null;
  name: string;
  slots: Record<string, string>;
  template: string | null;
  last_image_url: string | null;
  current_best_candidate_id: string | null;
  created_at: string;
  updated_at: string;
}

/** One visual_wiki_entries row shaped for the pure formatters (wiki.ts WikiEntryRow) plus the
 *  Studio panel's extra fields. */
export interface PortraitWikiRow {
  entry_id: string;
  title: string;
  body: string;
  tags: string[];
  subscriptions: WikiSubscription[];
  origin_episode_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ManifestValidation {
  manifest: LayerManifest;
  layers: LayerDefinition[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!isRecord(v)) return false;
  return Object.values(v).every((x) => typeof x === 'string');
}

// ---- Pure body parsers (the adminServer.ts posture) ------------------------------

export interface CreateEntityBody {
  layerId: string;
  name: string;
  slots: Record<string, string>;
  template: string | null;
  seed: string | null;
}

/** POST /v1/portraits/entities — { layerId, name, slots?, template?, seed? }. `seed` is the
 *  optional free-text bootstrap context ("an Italian woman in her 30s") used only when `slots` is
 *  omitted/empty — the "type a name, get it filled in" default path
 *  (portrait-studio-standalone-subjects-plan.md Part B). On the subject layer it is first expanded
 *  into a full appearance blurb by describeStudioSubject; on every other layer it is passed to
 *  describeStudioSlots verbatim. It is silently unused whenever `slots` is supplied explicitly
 *  (bi_principles.md §3 — explicit outranks inferred). Neither `seed` nor the intermediate blurb
 *  is ever persisted (2026-08-17, migration 0114 dropped standing_instructions). No characterId
 *  anywhere: entities are standalone and never linked. */
export function parseCreateEntityBody(raw: unknown): CreateEntityBody | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.layerId !== 'string' || !raw.layerId) return undefined;
  if (typeof raw.name !== 'string' || !raw.name.trim()) return undefined;
  if (raw.slots !== undefined && !isStringRecord(raw.slots)) return undefined;
  if (raw.template !== undefined && raw.template !== null && typeof raw.template !== 'string') return undefined;
  if (raw.seed !== undefined && raw.seed !== null && typeof raw.seed !== 'string') return undefined;
  return {
    layerId: raw.layerId,
    name: raw.name.trim(),
    slots: raw.slots ?? {},
    template: typeof raw.template === 'string' ? raw.template : null,
    seed: typeof raw.seed === 'string' ? raw.seed.trim() : null,
  };
}

export interface UpdateEntityBody {
  name?: string;
  slots?: Record<string, string>;
  template?: string | null;
}

/** PATCH /v1/portraits/entities/:id — every field optional; null clears template (not name/slots
 *  — an entity always has a name). A stray characterId in the body is ignored by this parser
 *  (unknown fields are already inert here), never written. */
export function parseUpdateEntityBody(raw: unknown): UpdateEntityBody | undefined {
  if (!isRecord(raw)) return undefined;
  const out: UpdateEntityBody = {};
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || !raw.name.trim()) return undefined;
    out.name = raw.name.trim();
  }
  if (raw.slots !== undefined) {
    if (!isStringRecord(raw.slots)) return undefined;
    out.slots = raw.slots;
  }
  if (raw.template !== undefined) {
    if (raw.template !== null && typeof raw.template !== 'string') return undefined;
    out.template = typeof raw.template === 'string' ? raw.template : null;
  }
  return out;
}

/** POST /v1/portraits/entities/from-cast-character — { characterId: string }. The one-time,
 *  never-linking pull-in (portrait-studio-standalone-subjects-plan.md Part C): resolves the
 *  caller's own character, then ALWAYS inserts a brand-new, unlinked subject entity seeded from
 *  its appearance (falling back to the persona when appearance is blank). No refresh-in-place, no
 *  per-character dedup — clicking "Send to Studio" twice creates two independent training
 *  subjects, exactly like clicking "+ new" twice would. */
export interface FromCharacterBody {
  characterId: string;
}

export function parseFromCharacterBody(raw: unknown): FromCharacterBody | undefined {
  if (!isRecord(raw) || typeof raw.characterId !== 'string' || !raw.characterId.trim()) return undefined;
  return { characterId: raw.characterId.trim() };
}

/** POST /v1/admin/portraits-enabled — { enabled: boolean }. The kill switch's write side
 *  (portrait-chain-hardening-plan.md): one boolean, strict — a missing or non-boolean value is a
 *  400, no coercion. */
export interface SetPortraitsEnabledBody {
  enabled: boolean;
}

export function parseSetPortraitsEnabledBody(raw: unknown): SetPortraitsEnabledBody | undefined {
  if (!isRecord(raw) || typeof raw.enabled !== 'boolean') return undefined;
  return { enabled: raw.enabled };
}

/** POST /v1/portraits/layers — { layers: [{ id, label, promptable, boundary }], template }.
 *  Structural validation mirrors parseLayerManifest's rules (every layer well-formed, template a
 *  string, non-empty, `subject` present) so the stored value always parses back to the same
 *  shape; the in-use guard (a layer with entities can't be dropped) is the handler's 409. */
export function parseLayerManifestBody(raw: unknown): LayerManifest | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.layers) || typeof raw.template !== 'string') return undefined;
  const layers: LayerDefinition[] = [];
  for (const entry of raw.layers) {
    if (!isRecord(entry)) return undefined;
    if (typeof entry.id !== 'string' || !entry.id || typeof entry.label !== 'string' || !entry.label) return undefined;
    if (typeof entry.promptable !== 'boolean' || typeof entry.boundary !== 'string') return undefined;
    layers.push({ id: entry.id, label: entry.label, promptable: entry.promptable, boundary: entry.boundary });
  }
  if (layers.length === 0 || !layers.some((l) => l.id === 'subject')) return undefined;
  return { layers, template: raw.template };
}

export interface GenerateBody {
  entityIds: Record<string, string>;
  goal: string;
  pendingFeedback?: string;
  /** A concluded lesson to drive this round with (plan §API step 6 — lesson-driven vs
   *  exploratory provenance). Optional; absent = explicitly exploratory. */
  lessonId?: string;
}

/** POST /v1/portraits/generate — { entityIds: { [layerId]: entityId }, goal, pendingFeedback?,
 *  lessonId? }. */
export function parseGenerateBody(raw: unknown): GenerateBody | undefined {
  if (!isRecord(raw) || !isRecord(raw.entityIds)) return undefined;
  if (!Object.values(raw.entityIds).every((v) => typeof v === 'string' && v !== '')) return undefined;
  if (typeof raw.goal !== 'string' || !raw.goal.trim()) return undefined;
  if (raw.pendingFeedback !== undefined && typeof raw.pendingFeedback !== 'string') return undefined;
  if (raw.lessonId !== undefined && (typeof raw.lessonId !== 'string' || !raw.lessonId)) return undefined;
  return {
    entityIds: raw.entityIds as Record<string, string>,
    goal: raw.goal.trim(),
    ...(typeof raw.pendingFeedback === 'string' && raw.pendingFeedback !== '' ? { pendingFeedback: raw.pendingFeedback } : {}),
    ...(typeof raw.lessonId === 'string' && raw.lessonId !== '' ? { lessonId: raw.lessonId } : {}),
  };
}

export interface FeedbackBody {
  /** Retry/complete feedback on an existing episode (re-runs reflection as attempt N+1). When
   *  present, entityIds/goal/candidateIds are not needed — the episode provides them. */
  episodeId?: string;
  entityIds?: Record<string, string>;
  goal?: string;
  candidateIds?: string[];
  /** Optional — a no-winner submission stays awaiting_feedback and never triggers reflection. */
  winnerId?: string;
  /** The operator explicitly records "no acceptable candidate" → insufficient_evidence. */
  noAcceptableCandidate?: boolean;
  ratings?: Record<string, number>;
  notes?: Record<string, string>;
  rationale?: string;
  layerAssessments?: { layer: string; assessment: 'improved' | 'unchanged' | 'regressed' }[];
}

/** POST /v1/portraits/feedback — either a fresh round ({ entityIds, goal, candidateIds,
 *  winnerId?, noAcceptableCandidate?, ratings?, notes?, rationale?, layerAssessments? }) or an
 *  episode retry ({ episodeId, winnerId?, noAcceptableCandidate?, ratings?, notes?, rationale?,
 *  layerAssessments? }). ratings values are validated as 1-5 integers here so the route can 400
 *  before the orchestrator's skip-with-log fallback (the orchestrator still guards — §11). */
export function parseFeedbackBody(raw: unknown): FeedbackBody | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.episodeId !== undefined && (typeof raw.episodeId !== 'string' || !raw.episodeId)) return undefined;
  if (raw.winnerId !== undefined && (typeof raw.winnerId !== 'string' || !raw.winnerId)) return undefined;
  if (raw.noAcceptableCandidate !== undefined && typeof raw.noAcceptableCandidate !== 'boolean') return undefined;
  if (raw.rationale !== undefined && typeof raw.rationale !== 'string') return undefined;
  if (raw.ratings !== undefined) {
    if (!isRecord(raw.ratings)) return undefined;
    for (const [id, rating] of Object.entries(raw.ratings)) {
      if (typeof id !== 'string' || typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) return undefined;
    }
  }
  if (raw.notes !== undefined) {
    if (!isRecord(raw.notes) || !Object.values(raw.notes).every((v) => typeof v === 'string')) return undefined;
  }
  if (raw.layerAssessments !== undefined) {
    if (!Array.isArray(raw.layerAssessments)) return undefined;
    for (const a of raw.layerAssessments) {
      if (!isRecord(a) || typeof a.layer !== 'string' || !a.layer) return undefined;
      if (a.assessment !== 'improved' && a.assessment !== 'unchanged' && a.assessment !== 'regressed') return undefined;
    }
  }
  if (raw.episodeId === undefined) {
    if (!isRecord(raw.entityIds)) return undefined;
    if (!Object.values(raw.entityIds).every((v) => typeof v === 'string' && v !== '')) return undefined;
    if (typeof raw.goal !== 'string' || !raw.goal.trim()) return undefined;
    if (!Array.isArray(raw.candidateIds) || !raw.candidateIds.every((v) => typeof v === 'string' && v !== '')) return undefined;
  }
  return {
    ...(typeof raw.episodeId === 'string' && raw.episodeId !== '' ? { episodeId: raw.episodeId } : {}),
    ...(typeof raw.winnerId === 'string' && raw.winnerId !== '' ? { winnerId: raw.winnerId } : {}),
    ...(raw.noAcceptableCandidate !== undefined ? { noAcceptableCandidate: raw.noAcceptableCandidate } : {}),
    ...(isRecord(raw.entityIds) ? { entityIds: raw.entityIds as Record<string, string> } : {}),
    ...(typeof raw.goal === 'string' && raw.goal !== '' ? { goal: raw.goal.trim() } : {}),
    ...(Array.isArray(raw.candidateIds) ? { candidateIds: raw.candidateIds as string[] } : {}),
    ...(raw.ratings !== undefined ? { ratings: raw.ratings as Record<string, number> } : {}),
    ...(raw.notes !== undefined ? { notes: raw.notes as Record<string, string> } : {}),
    ...(typeof raw.rationale === 'string' && raw.rationale !== '' ? { rationale: raw.rationale } : {}),
    ...(Array.isArray(raw.layerAssessments)
      ? { layerAssessments: raw.layerAssessments as FeedbackBody['layerAssessments'] }
      : {}),
  };
}

export interface WikiPatchBody {
  title?: string;
  body?: string;
  tags?: string[];
  subscriptions?: WikiSubscription[];
}

/** PATCH /v1/portraits/wiki/:id — { title?, body?, tags?, subscriptions? }; subscriptions is the
 *  full [{ layerType, layerEntityId: string | null }] array (replaces, not merges). */
export function parseWikiPatchBody(raw: unknown): WikiPatchBody | undefined {
  if (!isRecord(raw)) return undefined;
  const out: WikiPatchBody = {};
  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string' || !raw.title.trim()) return undefined;
    out.title = raw.title.trim();
  }
  if (raw.body !== undefined) {
    if (typeof raw.body !== 'string') return undefined;
    out.body = raw.body;
  }
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t) => typeof t === 'string')) return undefined;
    out.tags = raw.tags as string[];
  }
  if (raw.subscriptions !== undefined) {
    if (!Array.isArray(raw.subscriptions)) return undefined;
    const subs: WikiSubscription[] = [];
    for (const sub of raw.subscriptions) {
      if (!isRecord(sub) || typeof sub.layerType !== 'string' || !sub.layerType) return undefined;
      if (sub.layerEntityId !== undefined && sub.layerEntityId !== null && typeof sub.layerEntityId !== 'string') return undefined;
      subs.push({ layerType: sub.layerType, layerEntityId: typeof sub.layerEntityId === 'string' ? sub.layerEntityId : null });
    }
    out.subscriptions = subs;
  }
  return out;
}

// ---- DB seams ------------------------------------------------------------------

/** Resolve the active manifest for route-level validation (entity layer ids, subject rules).
 *  loadLayerManifest seeds the default on first read and degrades corrupt values — never throws. */
async function resolveManifest(deps: HttpServerDeps): Promise<ManifestValidation> {
  const manifest = await loadLayerManifest({ settings: deps.settings });
  return { manifest, layers: manifest.layers };
}

async function getEntity(db: PostgresClient, userId: string, entityId: string): Promise<PortraitEntityRow | undefined> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<PortraitEntityRow>(
      `select entity_id, layer_id, character_id, name, slots, template,
              last_image_url, current_best_candidate_id, created_at, updated_at
       from visual_entities where entity_id = $1 and user_id = $2`,
      [entityId, userId],
    ),
  );
  return rows[0];
}

// ---- Handlers -------------------------------------------------------------------

/** portrait-chain-hardening-plan.md's kill switch read: visual_portraits_enabled as a boolean,
 *  unset meaning 'true' — the feature predates the switch and is already in use, so this is an
 *  opt-out safety valve, not an opt-in gate (fail-open-to-existing-behavior, matching every other
 *  settings key's unset shape in orchestratorSettings.ts). */
export async function readPortraitsEnabled(settings: HttpServerDeps['settings']): Promise<boolean> {
  const raw = await settings.get('visual_portraits_enabled');
  return raw !== 'false';
}

/** The shared 403 gate every gated portrait handler opens with (portrait-chain-hardening-plan.md):
 *  reads the kill switch live — no restart, no partial DB reads or external fetches when off — and
 *  on 'false' answers 403 and returns false so the handler returns immediately. The layer-manifest
 *  pair is deliberately NOT gated (see httpServer.ts's route comment); scene-presence ordering is a
 *  general scene feature and is also unaffected. */
async function requirePortraitsEnabled(deps: HttpServerDeps, res: ServerResponse): Promise<boolean> {
  if (await readPortraitsEnabled(deps.settings)) return true;
  sendJson(res, 403, { error: 'portrait studio is disabled — enable it in Settings' });
  return false;
}

/** GET /v1/portraits-enabled — the kill switch's read side for the frontend (household-gated via
 *  the withUser route registration; nothing secret here, and App.tsx fetches it as a regular
 *  authenticated user before anyone would have entered the separate admin key). */
export async function handlePortraitsEnabledGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, { enabled: await readPortraitsEnabled(deps.settings) });
}

/** GET/POST /v1/admin/portraits-enabled — the admin-gated mirror of the pair above: the admin
 *  Settings toggle reads the same live value and writes { enabled: boolean } → 200 echoing the new
 *  value; a missing/non-boolean enabled is a 400. Same three-route shape as the chat-background
 *  settings trio, same no-restart semantics (the very next gated route call reads it live). */
export async function handlePortraitsEnabledSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  const parsed = parseSetPortraitsEnabledBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { enabled: boolean }' });
    return;
  }
  await deps.settings.set('visual_portraits_enabled', parsed.enabled ? 'true' : 'false');
  sendJson(res, 200, { enabled: parsed.enabled });
}

/** GET/POST /v1/admin/portrait-llm-connection — Portrait Studio's own connection subscription
 *  (this file's resolvePortraitLlm reads it). Admin-gated like every orchestrator_settings write
 *  on this server; the Studio's sidebar panel already needs the admin key to list connections
 *  (adminListConnections), so gating this pair the same way adds no extra friction. Empty string
 *  = unset = falls back to the household's active connection. */
export async function handlePortraitLlmConnectionGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  sendJson(res, 200, { connectionName: (await deps.settings.get('portrait_llm_connection')) ?? '' });
}

function parseSetPortraitLlmConnectionBody(raw: unknown): { connectionName: string } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { connectionName } = raw as Record<string, unknown>;
  if (typeof connectionName !== 'string') return undefined;
  return { connectionName };
}

export async function handlePortraitLlmConnectionSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  const parsed = parseSetPortraitLlmConnectionBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { connectionName: string }' });
    return;
  }
  await deps.settings.set('portrait_llm_connection', parsed.connectionName);
  sendJson(res, 200, { connectionName: parsed.connectionName });
}

/** CRUD family on /v1/portraits/entities (user-scoped). */
export async function handlePortraitEntities(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  userId: string,
  url: URL,
): Promise<void> {
  if (!(await requirePortraitsEnabled(deps, res))) return;
  const rest = url.pathname.slice('/v1/portraits/entities'.length);
  const segments = rest.split('/').filter(Boolean);

  if (segments.length === 0) {
    if (req.method === 'GET') {
      const rows = await deps.db.withUserScope(userId, (session) =>
        session.query<PortraitEntityRow>(
          `select entity_id, layer_id, character_id, name, slots, template,
                  last_image_url, current_best_candidate_id, created_at, updated_at
           from visual_entities where user_id = $1 order by layer_id, name`,
          [userId],
        ),
      );
      sendJson(res, 200, { entities: rows });
      return;
    }
    if (req.method === 'POST') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const parsed = parseCreateEntityBody(raw);
      if (!parsed) {
        sendJson(res, 400, {
          error: 'expected { layerId: non-empty string, name: non-empty string, slots?, template?, seed? }',
        });
        return;
      }
      const { manifest } = await resolveManifest(deps);
      if (!manifest.layers.some((l) => l.id === parsed.layerId)) {
        sendJson(res, 400, { error: `unknown layer "${parsed.layerId}" — see GET /v1/portraits/layers` });
        return;
      }
      const llm = await resolvePortraitLlm(deps);
      // The slot bootstrapper fires only on the "type a name, get it filled in" default path: an
      // entity created with slots: {} stays empty forever otherwise, since the mutation loop only
      // ever reuses slot names that already exist for a layer (describeStudioSlots.ts file header).
      // An operator who hand-fills slots gets exactly those (bi_principles.md §3), and neither
      // `seed` nor the bootstrap context ever gets written to the entity itself — both are
      // ephemeral, this call's own scratch data (2026-08-17, migration 0114 dropped
      // standing_instructions).
      let slots = parsed.slots;
      if (Object.keys(slots).length === 0) {
        const layer = manifest.layers.find((l) => l.id === parsed.layerId)!;
        // On the subject layer, expand the (possibly empty) seed into a full appearance blurb
        // first — describeStudioSubject invents from the name alone when the seed is blank
        // (fail-open: resolves to '' on any failure). Every other layer passes the seed straight
        // through as context, since no expansion pass fits a bikini/expression/format the way it
        // fits a physical subject.
        let context = parsed.seed ?? '';
        if (parsed.layerId === 'subject') {
          const described = await describeStudioSubject(deps.settings, llm, userId, { name: parsed.name, seed: parsed.seed ?? undefined });
          if (described.trim() !== '') context = described;
        }
        const bootstrapped = await describeStudioSlots(deps.settings, llm, userId, {
          layerId: layer.id,
          layerLabel: layer.label,
          layerBoundary: layer.boundary,
          name: parsed.name,
          context,
        });
        if (Object.keys(bootstrapped).length > 0) slots = bootstrapped;
      }
      const created = await deps.db.withUserScope(userId, (session) =>
        session.query<PortraitEntityRow>(
          `insert into visual_entities (user_id, layer_id, character_id, name, slots, template)
           values ($1, $2, null, $3, $4::jsonb, $5)
           returning entity_id, layer_id, character_id, name, slots, template,
                     last_image_url, current_best_candidate_id, created_at, updated_at`,
          [
            userId,
            parsed.layerId,
            parsed.name,
            JSON.stringify(slots),
            parsed.template,
          ],
        ),
      );
      sendJson(res, 201, created[0]);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const id = decodeURIComponent(segments[0]!);
  if (segments.length === 1) {
    if (req.method === 'GET') {
      const entity = await getEntity(deps.db, userId, id);
      if (!entity) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, entity);
      return;
    }
    if (req.method === 'PATCH') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const parsed = parseUpdateEntityBody(raw);
      if (!parsed) {
        sendJson(res, 400, { error: 'expected a partial entity patch — see POST /v1/portraits/entities for field shapes' });
        return;
      }
      const existing = await getEntity(deps.db, userId, id);
      if (!existing) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const sets: string[] = [];
      const params: unknown[] = [id, userId];
      let n = 2;
      const push = (col: string, v: unknown, cast = '') => {
        if (v === undefined) return;
        sets.push(`${col} = $${++n}${cast}`);
        params.push(v);
      };
      push('name', parsed.name);
      push('slots', parsed.slots !== undefined ? JSON.stringify(parsed.slots) : undefined, '::jsonb');
      push('template', parsed.template);
      if (sets.length === 0) {
        sendJson(res, 200, existing);
        return;
      }
      sets.push(`updated_at = now()`);
      const rows = await deps.db.withUserScope(userId, (session) =>
        session.query<PortraitEntityRow>(
          `update visual_entities set ${sets.join(', ')}
           where entity_id = $1 and user_id = $2
           returning entity_id, layer_id, character_id, name, slots, template,
                     last_image_url, current_best_candidate_id, created_at, updated_at`,
          params,
        ),
      );
      if (!rows[0]) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, rows[0]);
      return;
    }
    if (req.method === 'DELETE') {
      const rows = await deps.db.withUserScope(userId, (session) =>
        session.query<{ entity_id: string }>(
          'delete from visual_entities where entity_id = $1 and user_id = $2 returning entity_id',
          [id, userId],
        ),
      );
      if (!rows[0]) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, { deleted: true });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

/** POST /v1/portraits/entities/from-cast-character (portrait-studio-standalone-subjects-plan.md
 *  Part C) — the one-time, never-linking pull-in: resolve the caller's own character (any status —
 *  the route doesn't care whether it's a Card or a live character; in practice only CastSection
 *  calls it now, and it only ever offers live in-chat characters via its castOnly listing), read
 *  appearance || persona as the seed text exactly as the old from-character route did (409 when
 *  both are blank), and ALWAYS insert a brand-new, unlinked subject entity: character_id is never
 *  set on the row. There is no more "does a subject already exist for this character" check and no
 *  more refresh-in-place — clicking "Send to Studio" on the same cast row twice creates two
 *  independent training subjects, exactly like clicking "+ new" twice would. The seed text feeds
 *  describeStudioSubject then describeStudioSlots (2026-08-17, the same bootstrap sequence the
 *  plain create-entity path uses) so the entity starts with real slots instead of the empty
 *  `{}` this route used to insert — an entity with no slots never gets any from the mutation loop
 *  either (describeStudioSlots.ts file header), so skipping the bootstrap here would have quietly
 *  broken this path once standing_instructions (its old, never-actually-prompt-facing fallback)
 *  was dropped (migration 0114). Fail-open throughout (§11): a describer/bootstrapper failure
 *  still creates the entity, just with fewer or no starting slots. */
export async function handlePortraitEntityFromCastCharacter(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  userId: string,
): Promise<void> {
  if (!(await requirePortraitsEnabled(deps, res))) return;
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  const parsed = parseFromCharacterBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { characterId: non-empty string }' });
    return;
  }
  const chars = await deps.db.withUserScope(userId, (session) =>
    session.query<{ character_id: string; name: string; persona: string; appearance: string }>(
      'select character_id, name, persona, appearance from characters where character_id = $1 and user_id = $2',
      [parsed.characterId, userId],
    ),
  );
  const character = chars[0];
  if (!character) {
    sendJson(res, 404, { error: 'character not found' });
    return;
  }
  const seedText = character.appearance.trim() || character.persona.trim();
  if (seedText === '') {
    sendJson(res, 409, { error: 'character has no appearance or persona' });
    return;
  }
  const { manifest } = await resolveManifest(deps);
  const subjectLayer = manifest.layers.find((l) => l.id === 'subject')!;
  const llm = await resolvePortraitLlm(deps);
  const described = await describeStudioSubject(deps.settings, llm, userId, { name: character.name, seed: seedText });
  const bootstrapped = await describeStudioSlots(deps.settings, llm, userId, {
    layerId: subjectLayer.id,
    layerLabel: subjectLayer.label,
    layerBoundary: subjectLayer.boundary,
    name: character.name,
    context: described.trim() || seedText,
  });
  const created = await deps.db.withUserScope(userId, (session) =>
    session.query<PortraitEntityRow>(
      `insert into visual_entities (user_id, layer_id, character_id, name, slots, template)
       values ($1, 'subject', null, $2, $3::jsonb, null)
       returning entity_id, layer_id, character_id, name, slots, template,
                 last_image_url, current_best_candidate_id, created_at, updated_at`,
      [userId, character.name, JSON.stringify(bootstrapped)],
    ),
  );
  const entity = created[0]!;
  log.info('portraitRoutes: subject entity pulled in from cast character (unlinked)', { characterId: character.character_id, entityId: entity.entity_id });
  sendJson(res, 200, { entity });
}

/** Wiki family on /v1/portraits/wiki — list / edit / delete (creation is the Reflection pass's
 *  job, plan §Reflection Investigation). */
export async function handlePortraitWiki(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  userId: string,
  url: URL,
): Promise<void> {
  if (!(await requirePortraitsEnabled(deps, res))) return;
  const rest = url.pathname.slice('/v1/portraits/wiki'.length);
  const segments = rest.split('/').filter(Boolean);

  if (segments.length === 0 && req.method === 'GET') {
    const rows = await deps.db.withUserScope(userId, (session) =>
      session.query<PortraitWikiRow>(
        `select entry_id, title, body, tags, subscriptions, origin_episode_id, created_at, updated_at
         from visual_wiki_entries where user_id = $1 order by created_at`,
        [userId],
      ),
    );
    sendJson(res, 200, { entries: rows });
    return;
  }

  if (segments.length === 1) {
    const id = decodeURIComponent(segments[0]!);
    if (req.method === 'PATCH') {
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'expected a JSON request body' });
        return;
      }
      const parsed = parseWikiPatchBody(raw);
      if (!parsed) {
        sendJson(res, 400, { error: 'expected { title?, body?, tags?, subscriptions? }' });
        return;
      }
      const sets: string[] = [];
      const params: unknown[] = [id, userId];
      let n = 2;
      const push = (col: string, v: unknown, cast = '') => {
        if (v === undefined) return;
        sets.push(`${col} = $${++n}${cast}`);
        params.push(v);
      };
      push('title', parsed.title);
      push('body', parsed.body);
      push('tags', parsed.tags !== undefined ? parsed.tags : undefined, '::text[]');
      push('subscriptions', parsed.subscriptions !== undefined ? JSON.stringify(parsed.subscriptions) : undefined, '::jsonb');
      if (sets.length === 0) {
        sendJson(res, 400, { error: 'empty patch — nothing to update' });
        return;
      }
      sets.push('updated_at = now()');
      const rows = await deps.db.withUserScope(userId, (session) =>
        session.query<PortraitWikiRow>(
          `update visual_wiki_entries set ${sets.join(', ')}
           where entry_id = $1 and user_id = $2
           returning entry_id, title, body, tags, subscriptions, origin_episode_id, created_at, updated_at`,
          params,
        ),
      );
      if (!rows[0]) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, rows[0]);
      return;
    }
    if (req.method === 'DELETE') {
      const rows = await deps.db.withUserScope(userId, (session) =>
        session.query<{ entry_id: string }>(
          'delete from visual_wiki_entries where entry_id = $1 and user_id = $2 returning entry_id',
          [id, userId],
        ),
      );
      if (!rows[0]) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, { deleted: true });
      return;
    }
  }

  sendJson(res, 404, { error: 'not found' });
}

/** GET /v1/portraits/layers — the active manifest (parsed object, never the raw stored string):
 *  the Studio's layer pickers and Manage Layers editor both render from this. User-gated — the
 *  manifest is household-global but reading it is harmless and the tab renders for any user. */
export async function handlePortraitLayersGet(res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const { manifest } = await resolveManifest(deps);
  sendJson(res, 200, { manifest });
}

/** POST /v1/portraits/layers — replace the manifest. Admin-gated (an orchestrator_settings
 *  write). Rejects a manifest without `subject` (400) or one that drops a layer still holding
 *  entities (409) — the plan's in-use guard enforced server-side, not just in the UI. */
export async function handlePortraitLayersSet(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  const parsed = parseLayerManifestBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { layers: [{ id, label, promptable, boundary }], template } with a subject layer' });
    return;
  }
  // In-use guard: the current manifest's layers that the new manifest drops must have no
  // entities attached anywhere (the plan's no-cascading-delete rule). Cross-user — the manifest
  // is global, so any user's entities block a removal. visual_entities is FORCE ROW LEVEL
  // SECURITY (migration 0105), so withSystemScope alone can never see a row in it — it sets no
  // app.current_user_id, and the user_id = app_current_user_id() policy then excludes every row.
  // Same shape adminServer.ts's getChatMemorySyncStatus already established for this exact
  // problem: roster every user_id via withSystemScope (the users table itself isn't RLS-forced),
  // then check each one under its own withUserScope. Early-exits on the first hit — this is a
  // yes/no gate, not a report, so there's no reason to keep querying once one user blocks it.
  const { manifest: current } = await resolveManifest(deps);
  const dropped = current.layers.filter((l) => !parsed.layers.some((n) => n.id === l.id));
  if (dropped.length > 0) {
    const users = await deps.db.withSystemScope((session) => session.query<{ user_id: string }>('select user_id from users'));
    for (const layer of dropped) {
      for (const { user_id: uid } of users) {
        const inUse = await deps.db.withUserScope(uid, (session) =>
          session.query<{ entity_id: string }>('select entity_id from visual_entities where layer_id = $1 limit 1', [layer.id]),
        );
        if (inUse[0]) {
          sendJson(res, 409, { error: `cannot remove layer "${layer.id}" — entities are still attached to it` });
          return;
        }
      }
    }
  }
  await deps.settings.set('visual_layer_stack', JSON.stringify(parsed, null, 2));
  log.info('portraitRoutes: layer manifest updated', { layers: parsed.layers.map((l) => l.id).join(','), dropped: dropped.map((l) => l.id) });
  sendJson(res, 200, { manifest: parsed });
}

/** POST /v1/portraits/generate — run one generation round for the calling user. The fail-open
 *  orchestrator result maps: ok → 200 with the candidates; a structured round failure → 400 with
 *  its stable error code. */
export async function handlePortraitGenerate(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps, userId: string): Promise<void> {
  if (!(await requirePortraitsEnabled(deps, res))) return;
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  const parsed = parseGenerateBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { entityIds: { [layerId]: entityId }, goal: non-empty string, pendingFeedback?, lessonId? }' });
    return;
  }
  const result = await runPortraitGenerationRound({ db: deps.db, settings: deps.settings, imageConnections: deps.imageConnections }, await resolvePortraitLlm(deps), userId, parsed);
  if (!result.ok) {
    sendJson(res, 400, { error: result.error ?? 'generation failed' });
    return;
  }
  sendJson(res, 200, { candidates: result.candidates, lesson: result.lesson });
}

/** POST /v1/portraits/candidates/:id/retry — re-render one candidate (typically one whose
 *  original render failed) without spending a new mutation call; see
 *  retryPortraitCandidateRender's doc comment for the template/prompt resolution. */
export async function handlePortraitCandidateRetry(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps, userId: string, url: URL): Promise<void> {
  if (!(await requirePortraitsEnabled(deps, res))) return;
  const rest = url.pathname.slice('/v1/portraits/candidates'.length);
  const segments = rest.split('/').filter(Boolean);
  if (req.method !== 'POST' || segments.length !== 2 || segments[1] !== 'retry') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const result = await retryPortraitCandidateRender({ db: deps.db, settings: deps.settings, imageConnections: deps.imageConnections }, userId, segments[0]);
  if (!result.ok) {
    sendJson(res, 400, { error: result.error ?? 'retry failed' });
    return;
  }
  sendJson(res, 200, { imageUrl: result.imageUrl, composedPrompt: result.composedPrompt, ...(result.failed !== undefined ? { failed: result.failed } : {}) });
}

/** POST /v1/portraits/feedback — record the human evaluation for the calling user: a fresh round
 *  or an episode retry (episodeId). The truthful reflection outcome maps: 200 with the episode id
 *  + reflection outcome; a structured failure (missing rationale for a winner, unknown candidate,
 *  ...) → 400 with its stable error code. */
export async function handlePortraitFeedback(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps, userId: string): Promise<void> {
  if (!(await requirePortraitsEnabled(deps, res))) return;
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  const parsed = parseFeedbackBody(raw);
  if (!parsed) {
    sendJson(res, 400, {
      error:
        'expected { entityIds, goal, candidateIds, winnerId?, noAcceptableCandidate?, ratings?, notes?, rationale?, layerAssessments? } ' +
        'or an episode retry { episodeId, winnerId?, noAcceptableCandidate?, ratings?, notes?, rationale?, layerAssessments? }',
    });
    return;
  }
  const result = await submitPortraitFeedback({ db: deps.db, settings: deps.settings }, await resolvePortraitLlm(deps), userId, parsed);
  if (!result.ok) {
    sendJson(res, 400, { error: result.error ?? 'feedback failed' });
    return;
  }
  sendJson(res, 200, { episodeId: result.episodeId, reflection: result.reflection });
}

/** POST /v1/portraits/episodes/:id/reflect — retry reflection on one existing episode (plan §UI:
 *  a failed reflection offers retry instead of silently closing the round). Thin: the reflect
 *  action IS feedback-with-episodeId, so this reuses submitPortraitFeedback with the winner
 *  already stored on the episode. */
export async function handlePortraitEpisodeReflect(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps, userId: string, url: URL): Promise<void> {
  if (!(await requirePortraitsEnabled(deps, res))) return;
  const rest = url.pathname.slice('/v1/portraits/episodes'.length);
  const segments = rest.split('/').filter(Boolean);
  if (req.method !== 'POST' || segments.length !== 2 || segments[1] !== 'reflect') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  const parsed = parseFeedbackBody({ episodeId: segments[0], ...(isRecord(raw) ? raw : {}) });
  if (!parsed) {
    sendJson(res, 400, {
      error: 'expected { winnerId?, noAcceptableCandidate?, ratings?, notes?, rationale?, layerAssessments? }',
    });
    return;
  }
  const result = await submitPortraitFeedback({ db: deps.db, settings: deps.settings }, await resolvePortraitLlm(deps), userId, parsed);
  if (!result.ok) {
    sendJson(res, 400, { error: result.error ?? 'reflect failed' });
    return;
  }
  sendJson(res, 200, { episodeId: result.episodeId, reflection: result.reflection });
}

/** One episode's learning chain for GET /v1/portraits/history — episode → lesson → use → result
 *  (plan §UI's compact history view). */
export interface HistoryLearningEntry {
  learningId: string;
  attempt: number;
  status: string;
  lessonId: string | null;
  statement: string | null;
  evidence: string | null;
  nextChange: { layer: string; instruction: string } | null;
  preserve: string[] | null;
  confidence: string | null;
  createdAt: string;
}

export interface HistoryEpisode {
  episodeId: string;
  goal: string;
  rationale: string | null;
  createdAt: string;
  reflectionStatus: string;
  winnerCandidateId: string | null;
  candidates: { candidateId: string; imageUrl: string | null; rating: number | null; note: string | null; lessonId: string | null }[];
  learning: HistoryLearningEntry[];
}

export interface HistoryLesson {
  lessonId: string;
  statement: string;
  evidence: string;
  nextChange: { layer: string; instruction: string };
  preserve: string[];
  confidence: string;
  state: string;
  createdAt: string;
  sourceEpisodeId: string | null;
  uses: { useId: string; lessonId: string; episodeId: string | null; appliedChange: unknown; resultCandidateIds: string[]; createdAt: string }[];
}

/** GET /v1/portraits/history — the compact episode → lesson → use → result ledger: every episode
 *  with its candidates' outcomes and reflection attempts (visual_episode_learning), every lesson,
 *  and every lesson use. The UI can render the whole learning chain from this one call. */
export async function handlePortraitHistory(res: ServerResponse, deps: HttpServerDeps, userId: string): Promise<void> {
  const episodes = await deps.db.withUserScope(userId, (session) =>
    session.query<{
      episode_id: string;
      goal: string;
      rationale: string | null;
      created_at: string;
      reflection_status: string;
      selected_candidate_id: string | null;
      candidate_ids: string[];
    }>(
      `select episode_id, goal, rationale, created_at, reflection_status, selected_candidate_id, candidate_ids
       from visual_episodes where user_id = $1 order by created_at desc`,
      [userId],
    ),
  );
  const allCandidateIds = [...new Set(episodes.flatMap((e) => e.candidate_ids ?? []))];
  const candidates = allCandidateIds.length > 0
    ? await deps.db.withUserScope(userId, (session) =>
        session.query<{
          candidate_id: string;
          image_url: string | null;
          rating: number | null;
          note: string | null;
          lesson_id: string | null;
        }>(
          `select candidate_id, image_url, rating, note, lesson_id
           from visual_candidates where user_id = $1 and candidate_id = any($2::uuid[])`,
          [userId, allCandidateIds],
        ),
      )
    : [];
  const episodeIds = episodes.map((e) => e.episode_id);
  const learning = episodeIds.length > 0
    ? await deps.db.withUserScope(userId, (session) =>
        session.query<{
          learning_id: string;
          episode_id: string;
          attempt: number;
          status: string;
          output_snapshot: unknown;
          created_at: string;
        }>(
          `select learning_id, episode_id, attempt, status, output_snapshot, created_at
           from visual_episode_learning where user_id = $1 and episode_id = any($2::uuid[]) order by attempt`,
          [userId, episodeIds],
        ),
      )
    : [];

  const lessons = await deps.db.withUserScope(userId, (session) =>
    session.query<{
      lesson_id: string;
      source_episode_id: string | null;
      statement: string;
      evidence: string;
      next_change: { layer: string; instruction: string };
      preserve: string[];
      confidence: string;
      state: string;
      created_at: string;
    }>(
      `select lesson_id, source_episode_id, statement, evidence, next_change, preserve, confidence, state, created_at
       from visual_lessons where user_id = $1 order by created_at`,
      [userId],
    ),
  );
  const lessonUses = await deps.db.withUserScope(userId, (session) =>
    session.query<{
      use_id: string;
      lesson_id: string;
      episode_id: string | null;
      applied_change: unknown;
      result_candidates: { candidateIds: string[] } | null;
      created_at: string;
    }>(
      `select use_id, lesson_id, episode_id, applied_change, result_candidates, created_at
       from visual_lesson_uses where user_id = $1 order by created_at`,
      [userId],
    ),
  );

  const history: HistoryEpisode[] = episodes.map((e) => {
    const episodeCandidates = candidates.filter((c) => (e.candidate_ids ?? []).includes(c.candidate_id));
    const learningEntries: HistoryLearningEntry[] = learning
      .filter((l) => l.episode_id === e.episode_id)
      .map((l) => {
        const out = (l.output_snapshot ?? {}) as { lesson?: string; evidence?: string; nextChange?: { layer: string; instruction: string }; preserve?: string[]; confidence?: string };
        return {
          learningId: l.learning_id,
          attempt: l.attempt,
          status: l.status,
          lessonId: null,
          statement: null,
          evidence: null,
          nextChange: null,
          preserve: null,
          confidence: null,
          createdAt: l.created_at,
          ...(out.lesson !== undefined ? { statement: out.lesson } : {}),
          ...(out.evidence !== undefined ? { evidence: out.evidence } : {}),
          ...(out.nextChange !== undefined ? { nextChange: out.nextChange } : {}),
          ...(out.preserve !== undefined ? { preserve: out.preserve } : {}),
          ...(out.confidence !== undefined ? { confidence: out.confidence } : {}),
        };
      });
    return {
      episodeId: e.episode_id,
      goal: e.goal,
      rationale: e.rationale,
      createdAt: e.created_at,
      reflectionStatus: e.reflection_status,
      winnerCandidateId: e.selected_candidate_id,
      candidates: episodeCandidates.map((c) => ({
        candidateId: c.candidate_id,
        imageUrl: c.image_url,
        rating: c.rating,
        note: c.note,
        lessonId: c.lesson_id,
      })),
      learning: learningEntries,
    };
  });
  const historyLessons: HistoryLesson[] = lessons.map((l) => ({
    lessonId: l.lesson_id,
    statement: l.statement,
    evidence: l.evidence,
    nextChange: l.next_change,
    preserve: l.preserve ?? [],
    confidence: l.confidence,
    state: l.state,
    createdAt: l.created_at,
    sourceEpisodeId: l.source_episode_id,
    uses: lessonUses
      .filter((u) => u.lesson_id === l.lesson_id)
      .map((u) => ({
        useId: u.use_id,
        lessonId: u.lesson_id,
        episodeId: u.episode_id,
        appliedChange: u.applied_change,
        resultCandidateIds: u.result_candidates?.candidateIds ?? [],
        createdAt: u.created_at,
      })),
  }));
  sendJson(res, 200, { episodes: history, lessons: historyLessons });
}

/** GET /v1/portraits/lessons — the lesson ledger (state included), for the Studio's lesson list
 *  and the lesson-picker that drives a lesson-driven mutation round (generate body's lessonId). */
export async function handlePortraitLessons(res: ServerResponse, deps: HttpServerDeps, userId: string): Promise<void> {
  const lessons = await deps.db.withUserScope(userId, (session) =>
    session.query<{
      lesson_id: string;
      source_episode_id: string | null;
      statement: string;
      evidence: string;
      next_change: { layer: string; instruction: string };
      preserve: string[];
      confidence: string;
      state: string;
      created_at: string;
    }>(
      `select lesson_id, source_episode_id, statement, evidence, next_change, preserve, confidence, state, created_at
       from visual_lessons where user_id = $1 order by created_at desc`,
      [userId],
    ),
  );
  sendJson(res, 200, {
    lessons: lessons.map((l) => ({
      lessonId: l.lesson_id,
      statement: l.statement,
      evidence: l.evidence,
      nextChange: l.next_change,
      preserve: l.preserve ?? [],
      confidence: l.confidence,
      state: l.state,
      createdAt: l.created_at,
      sourceEpisodeId: l.source_episode_id,
    })),
  });
}
