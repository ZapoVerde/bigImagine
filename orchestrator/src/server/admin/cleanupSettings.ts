/**
 * @file orchestrator/src/server/admin/cleanupSettings.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (request parsing) + IO Wrapper (settings-store + slop-rules IO) —
 * the same dual-role split the original adminServer.ts cleanup block used; moved here verbatim as
 * part of the adminServer domain split
 * @description
 * The Cleanup page's setup surface: the four cleanup-config keys (header/footer trigger regex +
 * repair prompt — "the format expressed as a prompt"), the slop-rules table, and the reasoning
 * open/close tag pair. Slop rules are a full-set replace (delete-all + insert-each in one
 * system-scoped transaction via cleanupLoop.ts's replaceSlopRules) — there is no per-rule CRUD
 * surface. Cleanup execution logic itself stays in its own orchestrator modules (cleanupLoop.ts,
 * liveReasoning.ts); this module only reads/writes their config.
 *
 * @api-declaration
 * getCleanupSettings(store, db) — { headerRegex, headerPrompt, footerRegex, footerPrompt,
 *   slopRules, reasoningOpenTag, reasoningCloseTag }, each defaulting when unset
 * parseSetCleanupSettingsBody(raw) — validates a partial patch of those seven fields (slop_rules
 *   as a full-set array); undefined on any malformed shape or an empty body
 * setCleanupSettings(store, db, body) — upserts whichever fields the body names; a present
 *   slopRules array is a full-set replace
 *
 * @contract
 *   assertions:
 *     purity:          parseSetCleanupSettingsBody is pure; the rest are impure (Postgres IO via
 *                      the injected settings store and db)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected OrchestratorSettingsStore and PostgresClient)]
 */

import type { OrchestratorSettingsStore } from '../../io/orchestratorSettings.js';
import type { PostgresClient } from '../../io/postgres.js';
import { DEFAULT_CLEANUP_CONFIG } from '../../orchestrator/cleanupHeuristics.js';
import { DEFAULT_REASONING_CLOSE_TAG, DEFAULT_REASONING_OPEN_TAG } from '../../orchestrator/liveReasoning.js';
import { loadSlopRules, replaceSlopRules, type SlopRuleInput } from '../../orchestrator/cleanupLoop.js';

// --- Cleanup settings (migration 0072, plan v2 §3 — the Cleanup page's setup surface) ---
// The four cleanup config keys (the header/footer trigger regex + repair prompt — "the format
// expressed as a prompt") plus the slop-rules table, read/written together as the page's single
// settings block. Same live-read shape as the other Settings-tab fields: the subloop re-reads
// both every tick (cleanupLoop.ts's resolveCleanupConfig/loadSlopRules), so a save here takes
// effect on the very next poll, no restart. Slop rules are a full-set replace (delete-all +
// insert-each in one system-scoped transaction, cleanupLoop.ts's replaceSlopRules) — the page
// edits the whole set and saves; there is no per-rule CRUD surface.
//
// The reasoning tag pair (reasoning_open_tag / reasoning_close_tag, migration 0095,
// docs/plans/reasoning-blocks-plan.md) lives on this same block per the plan's §13/§17
// alignment with the cleanup config's existing scope — the Cleanup page is the "in-stream
// transform" surface, and the tags are another one. Like the header regex, an empty value is a
// deliberate override: the detector disables when either tag is blank (liveReasoning.ts's
// resolveReasoningTags), so saving '' here turns reasoning blocks off; the defaults ('<think>' /
// '</think>') are the built-in pair liveReasoning.ts falls back to when a key is unset. Because
// the values are read live at the start of every RP streaming turn, a save takes effect on the
// very next turn — no restart.

export interface CleanupSettings {
  headerRegex: string;
  headerPrompt: string;
  footerRegex: string;
  footerPrompt: string;
  slopRules: SlopRuleInput[];
  /** The reasoning-block tag pair (defaults '<think>' / '</think>'); either one blank =
   *  detection disabled. Same live-read shape as the header/footer regex fields. */
  reasoningOpenTag: string;
  reasoningCloseTag: string;
}

export async function getCleanupSettings(store: OrchestratorSettingsStore, db: PostgresClient): Promise<CleanupSettings> {
  const [headerRegex, headerPrompt, footerRegex, footerPrompt, reasoningOpenTag, reasoningCloseTag] = await Promise.all([
    store.get('cleanup_header_regex'),
    store.get('cleanup_header_prompt'),
    store.get('cleanup_footer_regex'),
    store.get('cleanup_footer_prompt'),
    store.get('reasoning_open_tag'),
    store.get('reasoning_close_tag'),
  ]);
  const slopRules = await loadSlopRules(db);
  return {
    headerRegex: headerRegex ?? DEFAULT_CLEANUP_CONFIG.headerRegex,
    headerPrompt: headerPrompt ?? DEFAULT_CLEANUP_CONFIG.headerPrompt,
    footerRegex: footerRegex ?? DEFAULT_CLEANUP_CONFIG.footerRegex,
    footerPrompt: footerPrompt ?? DEFAULT_CLEANUP_CONFIG.footerPrompt,
    slopRules,
    reasoningOpenTag: reasoningOpenTag ?? DEFAULT_REASONING_OPEN_TAG,
    reasoningCloseTag: reasoningCloseTag ?? DEFAULT_REASONING_CLOSE_TAG,
  };
}

export interface SetCleanupSettingsBody {
  headerRegex?: string;
  headerPrompt?: string;
  footerRegex?: string;
  footerPrompt?: string;
  /** Present = full-set replace (the page always sends its whole edited set). */
  slopRules?: SlopRuleInput[];
  /** The reasoning-block tag pair; either one '' = detection disabled. Optional, like the
   *  header/footer fields — omitted fields are left untouched. */
  reasoningOpenTag?: string;
  reasoningCloseTag?: string;
}

export function parseSetCleanupSettingsBody(raw: unknown): SetCleanupSettingsBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { header_regex, header_prompt, footer_regex, footer_prompt, slop_rules, reasoning_open_tag, reasoning_close_tag } = raw as Record<string, unknown>;
  if (
    header_regex === undefined &&
    header_prompt === undefined &&
    footer_regex === undefined &&
    footer_prompt === undefined &&
    slop_rules === undefined &&
    reasoning_open_tag === undefined &&
    reasoning_close_tag === undefined
  ) {
    return undefined;
  }
  if (header_regex !== undefined && typeof header_regex !== 'string') return undefined;
  if (header_prompt !== undefined && typeof header_prompt !== 'string') return undefined;
  if (footer_regex !== undefined && typeof footer_regex !== 'string') return undefined;
  if (footer_prompt !== undefined && typeof footer_prompt !== 'string') return undefined;
  if (reasoning_open_tag !== undefined && typeof reasoning_open_tag !== 'string') return undefined;
  if (reasoning_close_tag !== undefined && typeof reasoning_close_tag !== 'string') return undefined;
  if (slop_rules !== undefined) {
    if (!Array.isArray(slop_rules)) return undefined;
    const rules: SlopRuleInput[] = [];
    for (const r of slop_rules) {
      if (typeof r !== 'object' || r === null) return undefined;
      const {
        set_name,
        position,
        pattern,
        flags,
        action,
        replacement,
        llm_prompt,
        enabled,
      } = r as Record<string, unknown>;
      if (typeof set_name !== 'string' || set_name.length === 0) return undefined;
      if (typeof position !== 'number' || !Number.isInteger(position) || position < 0) return undefined;
      if (typeof pattern !== 'string' || pattern.length === 0) return undefined;
      if (flags !== undefined && typeof flags !== 'string') return undefined;
      if (action !== 'remove' && action !== 'replace-paragraph' && action !== 'llm') return undefined;
      if (replacement !== undefined && replacement !== null && typeof replacement !== 'string') return undefined;
      if (llm_prompt !== undefined && llm_prompt !== null && typeof llm_prompt !== 'string') return undefined;
      if (enabled !== undefined && typeof enabled !== 'boolean') return undefined;
      rules.push({
        setName: set_name,
        position,
        pattern,
        flags: typeof flags === 'string' ? flags : '',
        action,
        replacement: typeof replacement === 'string' ? replacement : null,
        llmPrompt: typeof llm_prompt === 'string' ? llm_prompt : null,
        enabled: typeof enabled === 'boolean' ? enabled : true,
      });
    }
    return {
      headerRegex: h(header_regex),
      headerPrompt: h(header_prompt),
      footerRegex: h(footer_regex),
      footerPrompt: h(footer_prompt),
      slopRules: rules,
      reasoningOpenTag: h(reasoning_open_tag),
      reasoningCloseTag: h(reasoning_close_tag),
    };
  }
  return {
    headerRegex: h(header_regex),
    headerPrompt: h(header_prompt),
    footerRegex: h(footer_regex),
    footerPrompt: h(footer_prompt),
    reasoningOpenTag: h(reasoning_open_tag),
    reasoningCloseTag: h(reasoning_close_tag),
  };
}

function h(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export async function setCleanupSettings(
  store: OrchestratorSettingsStore,
  db: PostgresClient,
  body: SetCleanupSettingsBody,
): Promise<void> {
  if (body.headerRegex !== undefined) await store.set('cleanup_header_regex', body.headerRegex);
  if (body.headerPrompt !== undefined) await store.set('cleanup_header_prompt', body.headerPrompt);
  if (body.footerRegex !== undefined) await store.set('cleanup_footer_regex', body.footerRegex);
  if (body.footerPrompt !== undefined) await store.set('cleanup_footer_prompt', body.footerPrompt);
  if (body.slopRules !== undefined) await replaceSlopRules(db, body.slopRules);
  if (body.reasoningOpenTag !== undefined) await store.set('reasoning_open_tag', body.reasoningOpenTag);
  if (body.reasoningCloseTag !== undefined) await store.set('reasoning_close_tag', body.reasoningCloseTag);
}