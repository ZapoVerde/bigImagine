/**
 * @file orchestrator/src/server/portraitRoutes.ts
 * @stamp 2026-08-16
 * @architectural-role IO Wrapper — the Portrait Studio's HTTP surface + the portraits
 *   subsystem's DB read/write seam (bi_principles.md §8), the file wiki.ts's preamble names as
 *   the wrapper that shapes visual_wiki_entries rows before the pure formatters see them
 * @description
 * The Portrait Studio's routes (docs/plans/portrait-studio-plan.md §New files): entity CRUD,
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
 *   parseFeedbackBody / parseWikiPatchBody — pure body parsers (undefined = invalid)
 * handlePortraitEntities(req, res, deps, userId, url) — CRUD on /v1/portraits/entities
 * handlePortraitWiki(req, res, deps, userId, url) — list/edit/delete on /v1/portraits/wiki
 * handlePortraitLayersGet / handlePortraitLayersSet — GET/POST /v1/portraits/layers
 * handlePortraitGenerate / handlePortraitFeedback — POST /v1/portraits/generate,
 *   /v1/portraits/feedback
 *
 * @contract
 *   assertions:
 *     purity:          body parsers pure; handlers impure (Postgres IO, orchestrator_settings,
 *                      the LLM + image provider via the orchestrators)
 *     state_ownership: []
 *     external_io:     [Postgres (visual_entities/visual_wiki_entries/visual_candidates via
 *                       db.withUserScope; characters for subject-entity validation), the LLM and
 *                       the active portrait image provider via the orchestrators]
 *     never:           throws. Every failure path logs and answers with a status + error body.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../io/logger.js';
import type { PostgresClient } from '../io/postgres.js';
import { loadLayerManifest, type LayerDefinition, type LayerManifest } from '../portraits/layerStack.js';
import type { WikiSubscription } from '../portraits/wiki.js';
import { runPortraitGenerationRound } from '../orchestrator/portraitGeneration.js';
import { submitPortraitFeedback } from '../orchestrator/portraitFeedback.js';
import { readJsonBody, sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';

/** One visual_entities row as the Studio sees it — full, no redaction (nothing secret here). */
export interface PortraitEntityRow {
  entity_id: string;
  layer_id: string;
  character_id: string | null;
  name: string;
  slots: Record<string, string>;
  standing_instructions: string;
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
  characterId: string | null;
  name: string;
  slots: Record<string, string>;
  standingInstructions: string;
  template: string | null;
}

/** POST /v1/portraits/entities — { layerId, characterId?, name, slots?, standingInstructions?,
 *  template? }. characterId is validated against the caller's characters table in the handler
 *  (subject entities require it — one subject per character, plan §Entities). */
export function parseCreateEntityBody(raw: unknown): CreateEntityBody | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.layerId !== 'string' || !raw.layerId) return undefined;
  if (typeof raw.name !== 'string' || !raw.name.trim()) return undefined;
  if (raw.characterId !== undefined && raw.characterId !== null && typeof raw.characterId !== 'string') return undefined;
  if (raw.slots !== undefined && !isStringRecord(raw.slots)) return undefined;
  if (raw.standingInstructions !== undefined && typeof raw.standingInstructions !== 'string') return undefined;
  if (raw.template !== undefined && raw.template !== null && typeof raw.template !== 'string') return undefined;
  return {
    layerId: raw.layerId,
    characterId: typeof raw.characterId === 'string' ? raw.characterId : null,
    name: raw.name.trim(),
    slots: raw.slots ?? {},
    standingInstructions: raw.standingInstructions ?? '',
    template: typeof raw.template === 'string' ? raw.template : null,
  };
}

export interface UpdateEntityBody {
  name?: string;
  characterId?: string | null;
  slots?: Record<string, string>;
  standingInstructions?: string;
  template?: string | null;
}

/** PATCH /v1/portraits/entities/:id — every field optional; null clears
 *  standingInstructions/template/characterId (not name/slots — an entity always has a name). */
export function parseUpdateEntityBody(raw: unknown): UpdateEntityBody | undefined {
  if (!isRecord(raw)) return undefined;
  const out: UpdateEntityBody = {};
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || !raw.name.trim()) return undefined;
    out.name = raw.name.trim();
  }
  if (raw.characterId !== undefined) {
    if (raw.characterId !== null && typeof raw.characterId !== 'string') return undefined;
    out.characterId = typeof raw.characterId === 'string' ? raw.characterId : null;
  }
  if (raw.slots !== undefined) {
    if (!isStringRecord(raw.slots)) return undefined;
    out.slots = raw.slots;
  }
  if (raw.standingInstructions !== undefined) {
    if (typeof raw.standingInstructions !== 'string') return undefined;
    out.standingInstructions = raw.standingInstructions;
  }
  if (raw.template !== undefined) {
    if (raw.template !== null && typeof raw.template !== 'string') return undefined;
    out.template = typeof raw.template === 'string' ? raw.template : null;
  }
  return out;
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
}

/** POST /v1/portraits/generate — { entityIds: { [layerId]: entityId }, goal, pendingFeedback? }. */
export function parseGenerateBody(raw: unknown): GenerateBody | undefined {
  if (!isRecord(raw) || !isRecord(raw.entityIds)) return undefined;
  if (!Object.values(raw.entityIds).every((v) => typeof v === 'string' && v !== '')) return undefined;
  if (typeof raw.goal !== 'string' || !raw.goal.trim()) return undefined;
  if (raw.pendingFeedback !== undefined && typeof raw.pendingFeedback !== 'string') return undefined;
  return {
    entityIds: raw.entityIds as Record<string, string>,
    goal: raw.goal.trim(),
    ...(typeof raw.pendingFeedback === 'string' && raw.pendingFeedback !== '' ? { pendingFeedback: raw.pendingFeedback } : {}),
  };
}

export interface FeedbackBody {
  entityIds: Record<string, string>;
  goal: string;
  candidateIds: string[];
  winnerId: string;
  ratings?: Record<string, number>;
  notes?: Record<string, string>;
  rationale?: string;
}

/** POST /v1/portraits/feedback — { entityIds, goal, candidateIds, winnerId, ratings?,
 *  notes?, rationale? }. ratings values are validated as 1-5 integers here so the route can 400
 *  before the orchestrator's skip-with-log fallback (the orchestrator still guards — §11). */
export function parseFeedbackBody(raw: unknown): FeedbackBody | undefined {
  if (!isRecord(raw) || !isRecord(raw.entityIds)) return undefined;
  if (!Object.values(raw.entityIds).every((v) => typeof v === 'string' && v !== '')) return undefined;
  if (typeof raw.goal !== 'string' || !raw.goal.trim()) return undefined;
  if (!Array.isArray(raw.candidateIds) || !raw.candidateIds.every((v) => typeof v === 'string' && v !== '')) return undefined;
  if (typeof raw.winnerId !== 'string' || !raw.winnerId) return undefined;
  if (raw.ratings !== undefined) {
    if (!isRecord(raw.ratings)) return undefined;
    for (const [id, rating] of Object.entries(raw.ratings)) {
      if (typeof id !== 'string' || typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) return undefined;
    }
  }
  if (raw.notes !== undefined) {
    if (!isRecord(raw.notes) || !Object.values(raw.notes).every((v) => typeof v === 'string')) return undefined;
  }
  if (raw.rationale !== undefined && typeof raw.rationale !== 'string') return undefined;
  return {
    entityIds: raw.entityIds as Record<string, string>,
    goal: raw.goal.trim(),
    candidateIds: raw.candidateIds as string[],
    winnerId: raw.winnerId,
    ...(raw.ratings !== undefined ? { ratings: raw.ratings as Record<string, number> } : {}),
    ...(raw.notes !== undefined ? { notes: raw.notes as Record<string, string> } : {}),
    ...(typeof raw.rationale === 'string' && raw.rationale !== '' ? { rationale: raw.rationale } : {}),
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
      `select entity_id, layer_id, character_id, name, slots, standing_instructions, template,
              last_image_url, current_best_candidate_id, created_at, updated_at
       from visual_entities where entity_id = $1 and user_id = $2`,
      [entityId, userId],
    ),
  );
  return rows[0];
}

/** One subject entity per character (plan §Entities) — the app-level guard (0105 has no unique
 *  index for it). Called on create and on a subject-entity patch that changes character_id. */
async function subjectExistsForCharacter(db: PostgresClient, userId: string, characterId: string, excludeEntityId?: string): Promise<boolean> {
  const rows = await db.withUserScope(userId, (session) =>
    session.query<{ entity_id: string }>(
      `select entity_id from visual_entities
       where user_id = $1 and layer_id = 'subject' and character_id = $2
         and ($3::uuid is null or entity_id <> $3::uuid)`,
      [userId, characterId, excludeEntityId ?? null],
    ),
  );
  return rows.length > 0;
}

// ---- Handlers -------------------------------------------------------------------

/** CRUD family on /v1/portraits/entities (user-scoped). */
export async function handlePortraitEntities(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  userId: string,
  url: URL,
): Promise<void> {
  const rest = url.pathname.slice('/v1/portraits/entities'.length);
  const segments = rest.split('/').filter(Boolean);

  if (segments.length === 0) {
    if (req.method === 'GET') {
      const rows = await deps.db.withUserScope(userId, (session) =>
        session.query<PortraitEntityRow>(
          `select entity_id, layer_id, character_id, name, slots, standing_instructions, template,
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
          error: 'expected { layerId: non-empty string, name: non-empty string, characterId?, slots?, standingInstructions?, template? }',
        });
        return;
      }
      const { manifest } = await resolveManifest(deps);
      if (!manifest.layers.some((l) => l.id === parsed.layerId)) {
        sendJson(res, 400, { error: `unknown layer "${parsed.layerId}" — see GET /v1/portraits/layers` });
        return;
      }
      if (parsed.layerId === 'subject' && !parsed.characterId) {
        sendJson(res, 400, { error: 'a subject entity requires characterId — subjects are created from an existing character (one per character)' });
        return;
      }
      if (parsed.characterId) {
        const char = await deps.db.withUserScope(userId, (session) =>
          session.query<{ character_id: string }>('select character_id from characters where character_id = $1 and user_id = $2', [
            parsed.characterId,
            userId,
          ]),
        );
        if (!char[0]) {
          sendJson(res, 404, { error: 'character not found' });
          return;
        }
        if (parsed.layerId === 'subject' && (await subjectExistsForCharacter(deps.db, userId, parsed.characterId))) {
          sendJson(res, 409, { error: 'a subject entity already exists for this character' });
          return;
        }
      }
      const created = await deps.db.withUserScope(userId, (session) =>
        session.query<PortraitEntityRow>(
          `insert into visual_entities (user_id, layer_id, character_id, name, slots, standing_instructions, template)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7)
           returning entity_id, layer_id, character_id, name, slots, standing_instructions, template,
                     last_image_url, current_best_candidate_id, created_at, updated_at`,
          [
            userId,
            parsed.layerId,
            parsed.characterId,
            parsed.name,
            JSON.stringify(parsed.slots),
            parsed.standingInstructions,
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
      // A subject entity's character can't be re-pointed onto a character that already has a
      // subject (the one-per-character rule), and any new characterId must exist.
      const newCharacterId = parsed.characterId !== undefined ? parsed.characterId : existing.character_id;
      if (newCharacterId && newCharacterId !== existing.character_id) {
        const char = await deps.db.withUserScope(userId, (session) =>
          session.query<{ character_id: string }>('select character_id from characters where character_id = $1 and user_id = $2', [
            newCharacterId,
            userId,
          ]),
        );
        if (!char[0]) {
          sendJson(res, 404, { error: 'character not found' });
          return;
        }
        if (existing.layer_id === 'subject' && (await subjectExistsForCharacter(deps.db, userId, newCharacterId, id))) {
          sendJson(res, 409, { error: 'a subject entity already exists for this character' });
          return;
        }
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
      push('character_id', parsed.characterId);
      push('slots', parsed.slots !== undefined ? JSON.stringify(parsed.slots) : undefined, '::jsonb');
      push('standing_instructions', parsed.standingInstructions);
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
           returning entity_id, layer_id, character_id, name, slots, standing_instructions, template,
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

/** Wiki family on /v1/portraits/wiki — list / edit / delete (creation is the Reflection pass's
 *  job, plan §Reflection Investigation). */
export async function handlePortraitWiki(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  userId: string,
  url: URL,
): Promise<void> {
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
  // is global, so any user's entities block a removal.
  const { manifest: current } = await resolveManifest(deps);
  const dropped = current.layers.filter((l) => !parsed.layers.some((n) => n.id === l.id));
  for (const layer of dropped) {
    const inUse = await deps.db.withSystemScope((session) =>
      session.query<{ entity_id: string }>('select entity_id from visual_entities where layer_id = $1 limit 1', [layer.id]),
    );
    if (inUse[0]) {
      sendJson(res, 409, { error: `cannot remove layer "${layer.id}" — entities are still attached to it` });
      return;
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
  let raw: unknown;
  try {
    raw = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'expected a JSON request body' });
    return;
  }
  const parsed = parseGenerateBody(raw);
  if (!parsed) {
    sendJson(res, 400, { error: 'expected { entityIds: { [layerId]: entityId }, goal: non-empty string, pendingFeedback? }' });
    return;
  }
  const result = await runPortraitGenerationRound({ db: deps.db, settings: deps.settings, imageConnections: deps.imageConnections }, deps.llm, userId, parsed);
  if (!result.ok) {
    sendJson(res, 400, { error: result.error ?? 'generation failed' });
    return;
  }
  sendJson(res, 200, { candidates: result.candidates });
}

/** POST /v1/portraits/feedback — record the human evaluation and run the Reflection
 *  Investigation for the calling user. */
export async function handlePortraitFeedback(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps, userId: string): Promise<void> {
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
        'expected { entityIds: { [layerId]: entityId }, goal, candidateIds: string[], winnerId, ratings?, notes?, rationale? }',
    });
    return;
  }
  const result = await submitPortraitFeedback({ db: deps.db, settings: deps.settings }, deps.llm, userId, parsed);
  if (!result.ok) {
    sendJson(res, 400, { error: result.error ?? 'feedback failed' });
    return;
  }
  sendJson(res, 200, { episodeId: result.episodeId, reflection: result.reflection });
}
