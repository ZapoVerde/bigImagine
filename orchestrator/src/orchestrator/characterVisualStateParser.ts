/**
 * @file orchestrator/src/orchestrator/characterVisualStateParser.ts
 * @stamp 2026-08-19
 * @architectural-role Pure Function — the deterministic footer grammar, zero IO
 * @description
 * docs/plans/character-visual-state-plan.md Pipeline §2: the pure, deterministic parse of the
 * Cleaner's hidden `<details><summary>▸</summary> … </details>` footer into one structured record
 * per character. The footer is the canonical current-status snapshot (inner thoughts, a one-word
 * expression, and the fixed six-slot outfit) and is deliberately a machine-guaranteed block, so
 * parsing makes no narrative decision (bi_principles.md §2): labels are exact and ordered,
 * `Inner thoughts:` / `Expression:` / `Outfit:` then the six `- Slot:` lines in canonical order,
 * every slot present (`none` = explicitly absent), the expression exactly one word, and the tag
 * names one-to-one with the trusted header's `Present:` roster (plan §Design: a footer tag never
 * creates or selects a character by itself — identity comes only from the roster).
 *
 * A malformed footer is a structured failure, not a partial parse: `parseCharacterVisualStateFooter`
 * returns `{ ok: false, reason }` and the caller fails open (logs, leaves existing visual state
 * unchanged, fires nothing — plan §Edge cases). This module owns no state and does no IO.
 *
 * Also exports the single normalization implementation used by the Stage-3 diff and the cache
 * keys (`visual_expression_definitions.word`, `character_visual_combinations.outfit_key` /
 * `expression_key`) — one normalization, not three copies (plan §2).
 *
 * @api-declaration
 * parseCharacterVisualStateFooter(text, header) -> CharacterVisualParseResult — pure; locates the
 *   ▸ details block in the turn text, parses one record per character block, and enforces the
 *   one-to-one roster match. ok:false (never throws) with a human-readable reason on any failure.
 * normalizeExpression(word) -> string — trim + casefold; the one-word expression's canonical form
 * normalizeOutfitField(value) -> string — trim + casefold ('none' canonicalizes to itself)
 * normalizeOutfitKey(outfit) -> string — the six normalized fields joined in canonical order
 * diffVisibleFields(before, after) -> VisibleFieldKey[] — the visibly changed fields
 *   (expression + outfit slots); inner-thoughts changes are never "visible"
 * innerThoughtsChanged(before, after) -> boolean — trimmed inner-thoughts comparison
 *
 * @contract
 *   assertions:
 *     purity:          pure — no IO, no shared mutable state; identical input, identical output
 *     state_ownership: []
 *     external_io:     []
 */

/** The `Present:` roster's character names live on the parsed header (plan §4: identity comes
 *  only from the trusted header, never from a footer tag alone). */
import type { StoryHeader } from './locationAndPresenceScraper.js';

/** The fixed six-slot outfit vocabulary (plan §Canonical footer format). Keys match the
 *  `character_visual_states` column names so the orchestrator's insert maps directly. */
export type OutfitFieldKey = 'outerwear' | 'top' | 'bottom' | 'underwear_top' | 'underwear_bottom' | 'accessory';

export const OUTFIT_SLOT_KEYS: readonly OutfitFieldKey[] = [
  'outerwear',
  'top',
  'bottom',
  'underwear_top',
  'underwear_bottom',
  'accessory',
] as const;

/** The exact, ordered slot labels the Cleaner emits after `Outfit:`. */
const OUTFIT_SLOT_LABELS: Record<OutfitFieldKey, string> = {
  outerwear: 'Outerwear',
  top: 'Top',
  bottom: 'Bottom',
  underwear_top: 'Underwear top',
  underwear_bottom: 'Underwear bottom',
  accessory: 'Accessory',
};

/** One character's structured snapshot, exactly as the footer authored it (raw, only trimmed). */
export interface OutfitFields {
  outerwear: string;
  top: string;
  bottom: string;
  underwear_top: string;
  underwear_bottom: string;
  accessory: string;
}

export interface CharacterVisualSnapshot {
  innerThoughts: string;
  expression: string;
  outfit: OutfitFields;
}

export interface CharacterVisualRecord extends CharacterVisualSnapshot {
  /** The block's tag name, validated one-to-one against the header roster. */
  name: string;
}

/** The visibly changeable fields — everything a snapshot has except inner thoughts. */
export type VisibleFieldKey = 'expression' | OutfitFieldKey;

export type CharacterVisualParseResult =
  | { ok: true; records: CharacterVisualRecord[] }
  | { ok: false; reason: string };

/** parseRecord's own result: one parsed block (or a structured failure), never a whole extraction. */
type CharacterVisualRecordResult =
  | ({ ok: true } & CharacterVisualRecord)
  | { ok: false; reason: string };

/** The hidden footer's only wrapper. The summary may carry whitespace or an `open` attribute. */
const DETAILS_BLOCK_RE = /<details[^>]*>\s*<summary[^>]*>[^<]*▸[^<]*<\/summary>([\s\S]*?)<\/details>/i;

/** An open tag for a roster-name block. Names are limited to the compact charset the plan's
 *  canonical format uses; any other name is a Cleaner format failure, not a guessable identity. */
const OPEN_TAG_RE = /<([A-Za-z][A-Za-z0-9 _-]*)\s*>/g;

const SLOT_LINE_RE = /^- ([A-Za-z][A-Za-z ]*):[ \t]*(.*)$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pure parse. Locates the ▸ details block in the turn text, parses each `<Name>…</Name>` block
 * into a structured record, and enforces the one-to-one roster match (every `Present:` name has
 * exactly one block; no unknown, duplicate, or missing character — any deviation rejects the
 * whole extraction, per plan §Edge cases). Returns a structured failure on any mismatch; never
 * throws. Roster order is not enforced — blocks are matched to characters by name, so a
 * well-formed reordering is still parsed — but the *set* must match exactly.
 */
export function parseCharacterVisualStateFooter(text: string, header: StoryHeader | null): CharacterVisualParseResult {
  if (!header || header.present.length === 0) {
    return { ok: false, reason: 'no-present' };
  }
  const details = DETAILS_BLOCK_RE.exec(text);
  if (!details) {
    return { ok: false, reason: 'no-footer' };
  }
  const content = details[1]!;

  const records: CharacterVisualRecord[] = [];
  const seen = new Set<string>();
  let scanFrom = 0;
  while (true) {
    OPEN_TAG_RE.lastIndex = scanFrom;
    const open = OPEN_TAG_RE.exec(content);
    if (!open) break;
    const name = open[1]!.trim();
    if (name === '') {
      return { ok: false, reason: 'empty-character-tag' };
    }
    // The block ends at the first matching close tag (no extra wrapper tags inside, per the
    // plan's canonical format — a stray literal close tag in authored text is a format failure).
    const closeRe = new RegExp(`</${escapeRegExp(name)}\\s*>`);
    closeRe.lastIndex = open.index + open[0].length;
    const close = closeRe.exec(content);
    if (!close) {
      return { ok: false, reason: `unclosed-character-block: ${name}` };
    }
    const blockContent = content.slice(open.index + open[0].length, close.index);

    const parsed = parseRecord(name, blockContent);
    if (!parsed.ok) {
      return parsed;
    }
    if (seen.has(parsed.name)) {
      return { ok: false, reason: `duplicate-character-block: ${parsed.name}` };
    }
    if (!header.present.includes(parsed.name)) {
      return { ok: false, reason: `character-not-in-present: ${parsed.name}` };
    }
    seen.add(parsed.name);
    records.push(parsed);
    scanFrom = close.index + close[0].length;
  }

  const missing = header.present.filter((p) => !seen.has(p));
  if (missing.length > 0) {
    return { ok: false, reason: `missing-character-block: ${missing.join(', ')}` };
  }
  if (records.length === 0) {
    return { ok: false, reason: 'no-character-blocks' };
  }
  return { ok: true, records };
}

/** One `<Name>…</Name>` block: the three fields in order, then the six slots exactly once each in
 *  canonical order. Returns the parsed record or a structured failure. */
function parseRecord(name: string, blockContent: string): CharacterVisualRecordResult {
  const lines = blockContent.split(/\r?\n/);
  const findLabel = (label: string): number => lines.findIndex((l) => l.trim().startsWith(label));
  const innerIdx = findLabel('Inner thoughts:');
  const exprIdx = findLabel('Expression:');
  const outfitIdx = findLabel('Outfit:');
  if (innerIdx < 0 || exprIdx < 0 || outfitIdx < 0) {
    return { ok: false, reason: `missing-field-in-block: ${name}` };
  }
  if (!(innerIdx < exprIdx && exprIdx < outfitIdx)) {
    return { ok: false, reason: `field-order-in-block: ${name}` };
  }

  const innerSuffix = lines[innerIdx]!.replace(/^[ \t]*Inner thoughts:[ \t]*/, '');
  const innerThoughts = [innerSuffix, ...lines.slice(innerIdx + 1, exprIdx)].join('\n').trim();

  const expressionRaw = lines[exprIdx]!.replace(/^[ \t]*Expression:[ \t]*/, '').trim();
  if (expressionRaw === '' || /\s/.test(expressionRaw)) {
    return { ok: false, reason: `expression-not-one-word: ${name}` };
  }

  const outfitLines = lines.slice(outfitIdx + 1).map((l) => l.trim()).filter((l) => l !== '');
  const values: Partial<OutfitFields> = {};
  const consumed: OutfitFieldKey[] = [];
  for (const line of outfitLines) {
    const m = SLOT_LINE_RE.exec(line);
    if (!m) {
      return { ok: false, reason: `outfit-line-not-a-slot: ${name}` };
    }
    const label = m[1]!.trim();
    const key = (Object.keys(OUTFIT_SLOT_LABELS) as OutfitFieldKey[]).find((k) => OUTFIT_SLOT_LABELS[k] === label);
    if (!key) {
      return { ok: false, reason: `unknown-outfit-slot: ${name}` };
    }
    if (consumed.includes(key)) {
      return { ok: false, reason: `duplicate-outfit-slot: ${name}` };
    }
    consumed.push(key);
    values[key] = m[2]!.trim();
  }
  if (consumed.length !== OUTFIT_SLOT_KEYS.length) {
    const missingSlots = OUTFIT_SLOT_KEYS.filter((k) => !consumed.includes(k)).map((k) => OUTFIT_SLOT_LABELS[k]);
    return { ok: false, reason: `missing-outfit-slot: ${name} (${missingSlots.join(', ')})` };
  }
  for (let i = 0; i < OUTFIT_SLOT_KEYS.length; i++) {
    if (consumed[i] !== OUTFIT_SLOT_KEYS[i]) {
      return { ok: false, reason: `outfit-slots-out-of-order: ${name}` };
    }
  }

  return { ok: true, name, innerThoughts, expression: expressionRaw, outfit: values as OutfitFields };
}

/** trim + casefold — the one-word expression's canonical form. 'none'-style case variants need no
 *  special handling here: an expression is a word, never the 'none' sentinel. */
export function normalizeExpression(word: string): string {
  return word.trim().toLowerCase();
}

/** trim + casefold. 'none' (the explicit-absence sentinel) canonicalizes to itself via casefold,
 *  so "None" / "NONE" / " nOne " all land on the same key. */
export function normalizeOutfitField(value: string): string {
  return value.trim().toLowerCase();
}

/** The canonical outfit key: the six normalized fields joined in the fixed slot order. The
 *  separator is a control character no authored slot value will contain. */
export function normalizeOutfitKey(outfit: OutfitFields): string {
  return OUTFIT_SLOT_KEYS.map((k) => normalizeOutfitField(outfit[k])).join('\u0001');
}

/** The visibly changed fields between two snapshots — the expression and/or outfit slots whose
 *  normalized values differ. Inner thoughts are never "visible", so they never appear here. */
export function diffVisibleFields(before: CharacterVisualSnapshot, after: CharacterVisualSnapshot): VisibleFieldKey[] {
  const changed: VisibleFieldKey[] = [];
  if (normalizeExpression(before.expression) !== normalizeExpression(after.expression)) {
    changed.push('expression');
  }
  for (const key of OUTFIT_SLOT_KEYS) {
    if (normalizeOutfitField(before.outfit[key]) !== normalizeOutfitField(after.outfit[key])) {
      changed.push(key);
    }
  }
  return changed;
}

/** Whether the inner-thoughts text changed (trimmed comparison — authored free text, no
 *  normalization beyond trimming). */
export function innerThoughtsChanged(before: CharacterVisualSnapshot, after: CharacterVisualSnapshot): boolean {
  return before.innerThoughts.trim() !== after.innerThoughts.trim();
}