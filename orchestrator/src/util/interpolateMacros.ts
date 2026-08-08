/**
 * @file orchestrator/src/util/interpolateMacros.ts
 * @stamp 2026-08-07
 * @architectural-role Pure Function — Stage 1 inline `{{...}}` macro substitution
 * @description
 * docs/prompt-macros.md's Stage 1: `{{char}}`, `{{user}}`, `{{persona}}`, `{{description}}`,
 * `{{scenario}}`, `{{trim}}`, `{{reverse}}`, `{{newline}}`, `{{noop}}` — the deterministic core of
 * SillyTavern's macro system, deliberately not the whole thing (no nesting, no scoped blocks/
 * `{{if}}`, no CST parser — `stacks/sillytavern/st-source/public/scripts/macros/` is the reference
 * this was assessed against, not a porting target). A single non-recursive regex pass: it scans
 * `text` once and does not re-scan its own output, so this is a genuinely pure, terminating
 * function, and an unimplemented later-stage token (`{{getvar::x}}`, Stage 3) typed into a system
 * prompt today passes through unchanged rather than silently vanishing — only tokens this file
 * actually knows about get substituted.
 *
 * `MacroSnapshot` is named to match docs/prompt-macros.md §2's "turn-scoped snapshot" vocabulary
 * on purpose, even though at Stage 1 it's trivial (no clock/RNG/variables read yet) — Stage 2 adds
 * time/random fields to this same shape, Stage 3 adds a variables read, and neither changes this
 * function's signature or its one caller (server/httpServer.ts, resolved fresh every turn).
 *
 * `message` (docs/turn-loop-plan.md §4.1) is the one field so far that isn't a per-turn constant
 * like the others — it's the raw just-generated turn text, only ever set when resolving a cleanup
 * preset's slots (the caller building the narrator prompt never has a message yet). Added exactly
 * the way this file's own doc comment above anticipated: a new optional field plus a new switch
 * case, no change to the function's signature or its caller's shape.
 *
 * Macro arguments: the `{{name::arg}}` form (SillyTavern's convention) is the core syntax, and
 * `{{name, N}}` is accepted as an alternative for numeric arguments only (a comma, with optional
 * surrounding spaces, followed by digits — the form the cleanup pass's `{{prev_turns, 2}}` uses). Both forms land in the same
 * `arg` slot, so `{{newline::3}}` and `{{newline, 3}}` are equivalent. A token whose argument
 * matches neither form (e.g. `{{foo, bar}}`) fails the whole pattern and passes through verbatim.
 *
 * Cleanup-only macros: the registry below is the closed core. `{{prev_turns, N}}` is deliberately
 * NOT in it — it needs the turn's history messages, which only the cleanup repair prompts have, so
 * orchestrator/cleanupHeuristics.ts's buildRepairPrompt supplies it through the optional
 * `resolveArg` hook (pure: the resolver is an input, resolved deterministically like everything
 * else). The cleanup resolver sees every token and returns undefined for ones it doesn't own;
 * interpolation then falls through to the registry. Outside the cleanup prompts (no resolver),
 * `{{prev_turns, N}}` is an unrecognized token and passes through verbatim — diagnosable, never
 * silently deleted.
 *
 * @api-declaration
 * MacroSnapshot — the turn-scoped values macros resolve against
 * interpolateMacros(text, snapshot, resolveArg?) — substitutes every recognized `{{...}}` token in
 *   text; `resolveArg(name, arg)` (optional, cleanup-pass only) supplies values for tokens that
 *   need call-site data like history, returning undefined to fall through to the registry
 *
 * @contract
 *   assertions:
 *     purity:          pure (deterministic given text, snapshot and resolver — no IO, no state)
 *     state_ownership: []
 *     external_io:     []
 */

export interface MacroSnapshot {
  /** {{char}} — the chat's linked character's name, if any. */
  charName?: string;
  /** {{user}} — the household's persona_name setting. */
  userName?: string;
  /** {{persona}} — "name: description", or whichever half is set (applyPromptStackToChatTool.ts
   *  composes this the same way for the whole-slot 'persona' marker). */
  persona?: string;
  /** {{description}} — character.persona, the card's own description field (confusingly named;
   *  matches the existing marker-key convention in assemblePromptStack.ts). */
  description?: string;
  /** {{scenario}} — character.scenario. */
  scenario?: string;
  /** {{message}} — the raw just-generated turn text, set only when resolving a cleanup preset
   *  (server/httpServer.ts's post-runTurn cleanup pass). Unset for narrator/character resolution. */
  message?: string;
}

const TOKEN_PATTERN = /\{\{(\w+)(?:::([^}]*)|[ \t]*,[ \t]*(\d+))?\}\}/g;
const TRIM_PATTERN = /\s*\{\{trim\}\}\s*/g;

function resolveToken(name: string, arg: string | undefined, snapshot: MacroSnapshot): string | undefined {
  switch (name) {
    case 'char':
      return snapshot.charName ?? '';
    case 'user':
      return snapshot.userName ?? '';
    case 'persona':
      return snapshot.persona ?? '';
    case 'description':
      return snapshot.description ?? '';
    case 'scenario':
      return snapshot.scenario ?? '';
    case 'message':
      return snapshot.message ?? '';
    case 'noop':
      return '';
    case 'newline':
      return '\n'.repeat(arg ? Math.max(0, Number(arg) || 0) : 1);
    case 'reverse':
      return Array.from(arg ?? '').reverse().join('');
    default:
      // Unrecognized (a typo, literal user text, or a later-stage macro not yet implemented) —
      // leave it verbatim rather than deleting it.
      return undefined;
  }
}

export function interpolateMacros(
  text: string,
  snapshot: MacroSnapshot,
  resolveArg?: (name: string, arg: string | undefined) => string | undefined,
): string {
  const substituted = text.replace(TOKEN_PATTERN, (match, name, arg, commaArg) => {
    const effectiveArg = arg ?? commaArg;
    const resolved = resolveArg?.(name, effectiveArg) ?? resolveToken(name, effectiveArg, snapshot);
    return resolved ?? match;
  });
  // {{trim}} is structural, not a value substitution — handled as its own pass so it can collapse
  // the whitespace touching it, mirroring SillyTavern's non-scoped {{trim}} behavior.
  return substituted.replace(TRIM_PATTERN, '');
}
