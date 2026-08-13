/**
 * @file orchestrator/src/orchestrator/describeLocation.ts
 * @stamp 2026-08-14
 * @architectural-role Orchestrator — the background room-description pass (endpoint.md §5, step
 *   1.5 between scrape and render)
 * @description
 * BigImagine's analogue of SillyTavern-Vistalyze's Step 3 Describer (logic/pipeline.js
 * handleUnknownLocation -> detector.js detectDescriber): the missing room-description LLM call.
 * VLZ's pipeline runs three LLM steps — Boolean gate, Classifier, Describer — and the Describer
 * is the one that turns a location *name* into a real visual description. BigImagine's scraper
 * is deliberately zero-token (segway.md §4, bi_principles.md §2), so its mint path can only seed
 * visual_description from the extracted name itself ("Bostaff's Apartment — Living Room"); until
 * now that name-string is exactly what synthesizeImagePrompt expanded into the bg prompt — a room
 * *name*, not a room *description*. This pass closes that gap:
 *
 *   scrape (mint row, visual_description = name) -> describe (this module, 1 LLM call) -> render
 *   (generateLocationImage, whose prompt hash now covers the real description)
 *
 * Skip rule (the sentinel): a row is "never described" iff its visual_description is empty or
 * still equals its name (the mint seed). Described rows — visual_description enriched by a prior
 * pass, or user-authored via create_location (bi_principles.md §3: an explicit signal outranks an
 * inferred one) — are skipped, making re-visits and the restart triggers no-ops. The same
 * name-seed sentinel is what §4.2.5's same-place carry relies on (the carry clones the prior
 * row's visual_description/definition when it's non-name, so the carried image hash matches and
 * the render stays a §5.1.2 cache hit).
 *
 * The call itself mirrors ensureFirstTurnHeader.ts's single-call pattern: config read from the
 * settings store (empty override = built-in default, bi_principles.md §17), the prompt recorded
 * to the trace before the call, one gated llm.complete under runWithCallContext (bi_principles.md
 * §14), the reply parsed for the Definition:/Visuals: markers (VLZ extractMarkerData's tolerant
 * label scan — Name: is ignored because the header name is authoritative and never overridden),
 * and each found marker written back to its own column. The context is the chat's last N
 * turn-pairs plus the turn that just landed (VLZ's buildDescriberContext shape, knob
 * location_describer_history_pairs default 1).
 *
 * Fail-open end to end (segway.md §1): any failure — config read, message read, LLM error, empty
 * reply, a reply with no markers, a DB write — logs and returns, leaving the row untouched. A
 * missing description is never worth a broken pass, and the image pass still renders with the
 * name-seed description exactly as it does today.
 *
 * @api-declaration
 * DEFAULT_LOCATION_DESCRIBER_PROMPT — the built-in prompt template (empty setting override = this)
 * DescribeLocationDeps — settings (OrchestratorSettingsStore)
 * describeLocationIfNeeded(deps, llm, userId, chatId, locationId) -> Promise<void> —
 *   the decoupled pass; never throws. Fires the describer LLM call only for a never-described
 *   eligible row, writes visual_description/definition, and otherwise does nothing.
 *
 * @contract
 *   assertions:
 *     purity:          impure (settings read, DB read/write, LLM call, prompt-trace write)
 *     state_ownership: [module-level describeInFlight — nothing else mutates it]
 *     external_io:     [Postgres (locations, chat_messages), orchestrator_settings (read), the
 *                       LLM via the injected provider, the prompt trace (recordPromptTrace)]
 *     never:           throws. Every failure path logs and returns; the caller (httpServer.ts's
 *                       fire chain) treats it as a no-op ahead of the render pass.
 */

import { log } from '../io/logger.js';
import { runWithCallContext } from '../io/llm/callContext.js';
import type { LlmProvider } from '../io/llm/types.js';
import { recordPromptTrace, type PromptTraceEntry } from '../io/promptTrace.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import type { PostgresClient } from '../io/postgres.js';

export const DEFAULT_LOCATION_DESCRIBER_PROMPT = `[SYSTEM: TASK — LOCATION VISUAL ARCHIVIST]
The scene is: {{location_name}}

NARRATIVE CONTEXT:
{{context}}

Write the location's Definition (a brief conceptual statement of what this place is) and its Visuals (2–3 sentences of concrete visual detail for an image generator — lighting, materials, layout, color).

### OUTPUT FORMAT:
Definition: [Logical Definition]
Visuals: [Image Generation Prompt]

Exclude mention of humans, animals, and any other living creatures from the Visuals.`;

/** The built-in number of trailing turn-pairs (VLZ's describerHistory default) used as narrative
 *  context when location_describer_history_pairs is unset or corrupt. */
const DEFAULT_DESCRIBER_HISTORY_PAIRS = 1;

export interface DescribeLocationDeps {
  db: PostgresClient;
  settings: OrchestratorSettingsStore;
}

interface LocationRow {
  location_id: string;
  name: string;
  visual_description: string;
  definition: string | null;
  status: string | null;
}

interface ContextMessage {
  role: string;
  content: string;
}

/** One describe call in flight per location — the post-turn fire and the chat-load/cycle-back
 *  restart triggers can overlap each other through the never-described window; the guard makes
 *  the second caller skip instead of double-spending a text LLM round-trip. Cleared in `finally`,
 *  so a failed call can never wedge the location. */
const describeInFlight = new Set<string>();

/** The settings resolution behind the pass: empty prompt = built-in default (bi_principles.md
 *  §17), empty/corrupt history-pairs = 1 (same fail-open shape as every numeric setting). */
async function resolveDescriberConfig(settings: OrchestratorSettingsStore): Promise<{
  prompt: string;
  historyPairs: number;
}> {
  const [prompt, pairsRaw] = await Promise.all([
    settings.get('location_describer_prompt'),
    settings.get('location_describer_history_pairs'),
  ]);
  const pairs = pairsRaw ? Number(pairsRaw) : NaN;
  return {
    prompt: (prompt ?? '').trim() || DEFAULT_LOCATION_DESCRIBER_PROMPT,
    historyPairs: Number.isInteger(pairs) && pairs > 0 ? pairs : DEFAULT_DESCRIBER_HISTORY_PAIRS,
  };
}

/** VLZ extractMarkerData's tolerant label scan, reduced to the two markers this pass writes back
 *  (Name: is deliberately ignored — the header name is authoritative). Each field is parsed
 *  independently, so a reply with only one marker still lands the one it has. */
function extractDescriptionMarkers(raw: string): { definition?: string; visuals?: string } {
  const text = String(raw || '');
  const result: { definition?: string; visuals?: string } = {};
  const fieldMap = { definition: 'Definition', visuals: 'Visuals' } as const;
  for (const [key, marker] of Object.entries(fieldMap)) {
    const regex = new RegExp(`\\*?\\*?${marker}\\*?\\*?:\\s*([\\s\\S]*?)(?=\\n\\*?\\*?(?:Name|Definition|Visuals)\\*?\\*?:|$)`, 'i');
    const match = text.match(regex);
    if (match) {
      const value = match[1]!.trim().replace(/^\*+|\*+$/g, '').trim();
      if (value) result[key as 'definition' | 'visuals'] = value;
    }
  }
  return result;
}

/** Build the describer's narrative context: the chat's last N turn-pairs plus the turn that just
 *  landed — the same shape VLZ's buildDescriberContext produces (the trigger message is the final
 *  entry, so the model sees what led up to this moment). Reads chat_messages ordered like every
 *  other read in the platform (created_at, message_id). */
async function readDescriberContext(
  db: PostgresClient,
  userId: string,
  chatId: string | undefined,
  historyPairs: number,
): Promise<string> {
  if (!chatId) return '';
  const rows = await db.withUserScope(userId, (session) =>
    session.query<ContextMessage>(
      'select role, content from chat_messages where chat_id = $1 order by created_at, message_id',
      [chatId],
    ),
  );
  if (rows.length === 0) return '';
  const window = rows.slice(-(historyPairs * 2 + 1));
  return window.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
}

/** The decoupled room-description pass. Returns a promise that always resolves (never throws):
 *  every failure path logs and returns, and the caller's chain treats a returned value as "done,
 *  whether or not anything was written". */
export async function describeLocationIfNeeded(
  deps: DescribeLocationDeps,
  llm: LlmProvider,
  userId: string,
  chatId: string | undefined,
  locationId: string,
): Promise<void> {
  try {
    // One describe call per location at a time — same waste-prevention guard as
    // generateLocationImage.ts's renderInFlight, so overlapping triggers (post-turn fire +
    // chat-load restart) can't double-spend a text LLM round-trip.
    if (describeInFlight.has(locationId)) {
      log.debug('describeLocation: describe already in flight, skipping duplicate', { locationId });
      return;
    }
    describeInFlight.add(locationId);
    try {
      const [row] = await deps.db.withUserScope(userId, (session) =>
        session.query<LocationRow>(
          `select location_id, name, visual_description, definition, status
           from locations where location_id = $1 and user_id = $2`,
          [locationId, userId],
        ),
      );
      if (!row) {
        log.debug('describeLocation: location not found, skipping', { locationId });
        return;
      }
      // The never-described sentinel: the mint path seeds visual_description = name, and
      // create_location writes an explicit description (possibly '' — which is also never-
      // described). A row whose description no longer equals its name has been described — by a
      // prior pass or by the user — and is left alone (bi_principles.md §3).
      const described = row.visual_description.trim() !== '' && row.visual_description.trim() !== row.name;
      if (described) {
        log.debug('describeLocation: location already described, skipping', { locationId, name: row.name });
        return;
      }

      const config = await resolveDescriberConfig(deps.settings);
      const context = await readDescriberContext(deps.db, userId, chatId, config.historyPairs);
      const prompt = config.prompt
        .replace(/\{\{\s*location_name\s*\}\}/g, row.name)
        .replace(/\{\{\s*context\s*\}\}/g, context);

      const entry: PromptTraceEntry = {
        kind: 'describer',
        title: 'Location Describer — room description',
        items: [{ role: 'user', content: prompt, chars: prompt.length, estimatedTokens: Math.ceil(prompt.length / 4) }],
        capturedAt: Date.now(),
      };
      recordPromptTrace(chatId ?? locationId, entry);
      log.info('describeLocation: describer fired', { locationId, name: row.name, promptChars: prompt.length });
      const turn = await runWithCallContext({ taskId: chatId ?? locationId, kind: 'system', userId }, () =>
        llm.complete([{ role: 'user', content: prompt }], []),
      );
      const out = turn.message.content;
      if (!out || !out.trim()) {
        log.warn('describeLocation: describer replied empty, leaving row untouched', { locationId });
        return;
      }
      entry.reply = out.trim();

      const markers = extractDescriptionMarkers(out);
      if (!markers.definition && !markers.visuals) {
        log.warn('describeLocation: describer reply had no Definition/Visuals markers, leaving row untouched', {
          locationId,
        });
        return;
      }

      // Write each marker independently — a reply missing one half leaves that column as-is
      // (visual_description stays the name-seed if Visuals is absent, so a later visit retries).
      await deps.db.withUserScope(userId, (session) =>
        session.query(
          `update locations set
             visual_description = coalesce($2, visual_description),
             definition = coalesce($3, definition)
           where location_id = $1 and user_id = $4`,
          [locationId, markers.visuals ?? null, markers.definition ?? null, userId],
        ),
      );
      log.info('describeLocation: location described', { locationId, name: row.name, wroteDefinition: !!markers.definition, wroteVisuals: !!markers.visuals });
    } finally {
      describeInFlight.delete(locationId);
    }
  } catch (err) {
    // bi_principles.md §11: log the seam. A failed describe must never take a pass down — the
    // render still runs with the name-seed description, exactly as before this feature.
    log.error('describeLocation: description failed, leaving row untouched', { locationId, err });
  }
}
