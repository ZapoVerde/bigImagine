/**
 * @file orchestrator/src/orchestrator/describeCharacter.ts
 * @stamp 2026-08-15
 * @architectural-role Orchestrator — the background character-description pass (rp-cast-
 *   infrastructure-plan.md A2, the character-side analogue of describeLocation.ts)
 * @description
 * Locations and characters are both auto-registered synchronously, in-request, by the same
 * `scrapeTurnPresence` call in locationAndPresenceScraper.ts — but only locations got a
 * decoupled, fire-and-forget description pass (describeLocation.ts, fired off the response
 * 'finish' event). This module closes that parity gap: the character analogue that turns a
 * freshly-minted `characters` row's blank (or carried-forward) `persona` into a real persona/
 * appearance blurb from the narrative context, one LLM call, after the reply the user is
 * waiting on is already sent.
 *
 * Structurally identical to describeLocation.ts — same module-level in-flight guard, same
 * fail-open contract (any failure logs and returns, never throws), same settings-driven
 * prompt/history-pairs config (character_describer_prompt / character_describer_history_pairs,
 * empty override = built-in default per bi_principles.md §17), same ContextMessage read of the
 * chat's last N turn-pairs, same gated single llm.complete under runWithCallContext
 * (bi_principles.md §14) with the prompt recorded to the trace before the call.
 *
 * The differences from the location pass are the shape of what it fills and the skip rule:
 *
 *   - Skip rule: a character row is "never described" iff its `persona` is empty. A non-empty
 *     `persona` — user-authored, imported, or written by a prior pass — is always skipped
 *     (bi_principles.md §3: an explicit signal outranks an inferred one), which also makes the
 *     A1 carry-forward free: a minted row that carried a prior row's persona is immediately
 *     "already described" and never triggers a second LLM call.
 *   - The prompt asks for a short persona/appearance blurb and is parsed for a single
 *     `Persona:` marker (simpler than locations' two-marker Definition/Visuals split —
 *     characters only have one field to fill), written to `characters.persona`.
 *
 * Fail-open end to end (segway.md §1): any failure — config read, message read, LLM error,
 * empty reply, a reply with no `Persona:` marker, a DB write — logs and returns, leaving the
 * row untouched. A missing persona is never worth a broken pass.
 *
 * @api-declaration
 * DEFAULT_CHARACTER_DESCRIBER_PROMPT — the built-in prompt template (empty setting override = this)
 * DescribeCharacterDeps — settings (OrchestratorSettingsStore)
 * describeCharacterIfNeeded(deps, llm, userId, chatId, characterId) -> Promise<void> —
 *   the decoupled pass; never throws. Fires the describer LLM call only for a never-described
 *   eligible row, writes characters.persona, and otherwise does nothing.
 *
 * @contract
 *   assertions:
 *     purity:          impure (settings read, DB read/write, LLM call, prompt-trace write)
 *     state_ownership: [module-level describeInFlight — nothing else mutates it]
 *     external_io:     [Postgres (characters, chat_messages), orchestrator_settings (read), the
 *                       LLM via the injected provider, the prompt trace (recordPromptTrace)]
 *     never:           throws. Every failure path logs and returns; the caller
 *                      (server/characterDescription.ts's fire chain) treats it as a no-op.
 */

import { log } from '../io/logger.js';
import { runWithCallContext, withCallLabel } from '../io/llm/callContext.js';
import type { LlmProvider } from '../io/llm/types.js';
import { recordPromptTrace, type PromptTraceEntry } from '../io/promptTrace.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import type { PostgresClient } from '../io/postgres.js';

export const DEFAULT_CHARACTER_DESCRIBER_PROMPT = `[SYSTEM: TASK — CHARACTER ARCHIVIST]
The character is: {{character_name}}

NARRATIVE CONTEXT:
{{context}}

Write a short persona blurb for this character — who they are, their manner, and a couple of concrete appearance details as shown in the narrative (or plainly marked as unknown if the story hasn't shown them).

### OUTPUT FORMAT:
Persona: [Persona / Appearance Blurb]`;

/** The built-in number of trailing turn-pairs (same default as the location describer's
 *  describerHistory) used as narrative context when character_describer_history_pairs is unset
 *  or corrupt. */
const DEFAULT_DESCRIBER_HISTORY_PAIRS = 1;

export interface DescribeCharacterDeps {
  db: PostgresClient;
  settings: OrchestratorSettingsStore;
}

interface CharacterRow {
  character_id: string;
  name: string;
  persona: string;
  status: string | null;
}

interface ContextMessage {
  role: string;
  content: string;
}

/** One describe call in flight per character — the post-turn fire and any overlapping trigger
 *  can overlap each other through the never-described window; the guard makes the second caller
 *  skip instead of double-spending a text LLM round-trip. Cleared in `finally`, so a failed
 *  call can never wedge the character. */
const describeInFlight = new Set<string>();

/** The settings resolution behind the pass: empty prompt = built-in default (bi_principles.md
 *  §17), empty/corrupt history-pairs = 1 (same fail-open shape as every numeric setting). */
async function resolveDescriberConfig(settings: OrchestratorSettingsStore): Promise<{
  prompt: string;
  historyPairs: number;
}> {
  const [prompt, pairsRaw] = await Promise.all([
    settings.get('character_describer_prompt'),
    settings.get('character_describer_history_pairs'),
  ]);
  const pairs = pairsRaw ? Number(pairsRaw) : NaN;
  return {
    prompt: (prompt ?? '').trim() || DEFAULT_CHARACTER_DESCRIBER_PROMPT,
    historyPairs: Number.isInteger(pairs) && pairs > 0 ? pairs : DEFAULT_DESCRIBER_HISTORY_PAIRS,
  };
}

/** The tolerant label scan, reduced to the single marker this pass writes back — the same
 *  shape as describeLocation.ts's extractDescriptionMarkers, minus the Definition/Visuals pair. */
function extractPersonaMarker(raw: string): string | undefined {
  const text = String(raw || '');
  const regex = /Persona:\s*([\s\S]*?)(?=\n\*?\*?(?:Name|Persona)\*?\*?:|$)/i;
  const match = text.match(regex);
  if (!match) return undefined;
  const value = match[1]!.trim().replace(/^\*+|\*+$/g, '').trim();
  return value || undefined;
}

/** Build the describer's narrative context: the chat's last N turn-pairs plus the turn that
 *  just landed — the same shape readDescriberContext in describeLocation.ts produces (the
 *  trigger message is the final entry, so the model sees what led up to this moment). Reads
 *  chat_messages ordered like every other read in the platform (created_at, message_id). */
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

/** The decoupled character-description pass. Returns a promise that always resolves (never
 *  throws): every failure path logs and returns, and the caller's chain treats a returned value
 *  as "done, whether or not anything was written". */
export async function describeCharacterIfNeeded(
  deps: DescribeCharacterDeps,
  llm: LlmProvider,
  userId: string,
  chatId: string | undefined,
  characterId: string,
): Promise<void> {
  try {
    // One describe call per character at a time — same waste-prevention guard as
    // describeLocation.ts's describeInFlight, so overlapping triggers can't double-spend a
    // text LLM round-trip.
    if (describeInFlight.has(characterId)) {
      log.debug('describeCharacter: describe already in flight, skipping duplicate', { characterId });
      return;
    }
    describeInFlight.add(characterId);
    try {
      const [row] = await deps.db.withUserScope(userId, (session) =>
        session.query<CharacterRow>(
          `select character_id, name, persona, status
           from characters where character_id = $1 and user_id = $2`,
          [characterId, userId],
        ),
      );
      if (!row) {
        log.debug('describeCharacter: character not found, skipping', { characterId });
        return;
      }
      // The never-described sentinel: the mint path seeds persona = '' (or carries a prior
      // row's real persona forward — A1, which this rule then treats as already-described).
      // Any non-empty persona — written by the user, an import, or a prior pass — is left
      // alone (bi_principles.md §3).
      if (row.persona.trim() !== '') {
        log.debug('describeCharacter: character already described, skipping', { characterId, name: row.name });
        return;
      }

      const config = await resolveDescriberConfig(deps.settings);
      const context = await readDescriberContext(deps.db, userId, chatId, config.historyPairs);
      const prompt = config.prompt
        .replace(/\{\{\s*character_name\s*\}\}/g, row.name)
        .replace(/\{\{\s*context\s*\}\}/g, context);

      const entry: PromptTraceEntry = {
        kind: 'describer',
        title: 'Character Describer — persona blurb',
        items: [{ role: 'user', content: prompt, chars: prompt.length, estimatedTokens: Math.ceil(prompt.length / 4) }],
        capturedAt: Date.now(),
      };
      recordPromptTrace(chatId ?? characterId, entry);
      log.info('describeCharacter: describer fired', { characterId, name: row.name, promptChars: prompt.length });
      const turn = await runWithCallContext({ taskId: chatId ?? characterId, kind: 'system', userId }, () =>
        withCallLabel('bg:character-description', () => llm.complete([{ role: 'user', content: prompt }], [])),
      );
      const out = turn.message.content;
      if (!out || !out.trim()) {
        log.warn('describeCharacter: describer replied empty, leaving row untouched', { characterId });
        return;
      }
      entry.reply = out.trim();

      const persona = extractPersonaMarker(out);
      if (!persona) {
        log.warn('describeCharacter: describer reply had no Persona: marker, leaving row untouched', {
          characterId,
        });
        return;
      }

      await deps.db.withUserScope(userId, (session) =>
        session.query(
          'update characters set persona = $2, updated_at = now() where character_id = $1 and user_id = $3',
          [characterId, persona, userId],
        ),
      );
      log.info('describeCharacter: character described', { characterId, name: row.name, personaChars: persona.length });
    } finally {
      describeInFlight.delete(characterId);
    }
  } catch (err) {
    // bi_principles.md §11: log the seam. A failed describe must never take a pass down.
    log.error('describeCharacter: description failed, leaving row untouched', { characterId, err });
  }
}
