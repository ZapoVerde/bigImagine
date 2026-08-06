/**
 * @file orchestrator/src/util/interpolateMacros.ts
 * @stamp 2026-08-05
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
 * @api-declaration
 * MacroSnapshot — the turn-scoped values macros resolve against
 * interpolateMacros(text, snapshot) — substitutes every recognized `{{...}}` token in text
 *
 * @contract
 *   assertions:
 *     purity:          pure
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
}

const TOKEN_PATTERN = /\{\{(\w+)(?:::([^}]*))?\}\}/g;
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

export function interpolateMacros(text: string, snapshot: MacroSnapshot): string {
  const substituted = text.replace(TOKEN_PATTERN, (match, name, arg) => {
    const resolved = resolveToken(name, arg, snapshot);
    return resolved ?? match;
  });
  // {{trim}} is structural, not a value substitution — handled as its own pass so it can collapse
  // the whitespace touching it, mirroring SillyTavern's non-scoped {{trim}} behavior.
  return substituted.replace(TRIM_PATTERN, '');
}
