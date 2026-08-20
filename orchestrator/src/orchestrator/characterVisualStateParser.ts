/**
 * @file orchestrator/src/orchestrator/characterVisualStateParser.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function — the deterministic footer grammar, zero IO
 * @description
 * docs/plans/character-visual-state-plan.md Pipeline §2: the pure, deterministic parse of the
 * Cleaner-owned footer region into one structured record per character. The footer is the
 * canonical current-status snapshot (inner thoughts, a one-word expression, and the six-slot
 * outfit vocabulary) and is deliberately a machine-guaranteed block, so parsing makes no
 * narrative decision (bi_principles.md §2): labels are exact, `Inner thoughts:` /
 * `Expression:` / `Outfit:` appear in order, the expression is exactly one word, and the tag
 * names are one-to-one with the trusted header's `Present:` roster (plan §Design: a footer tag
 * never creates or selects a character by itself — identity comes only from the roster).
 *
 * Outfit slots are a partial update (plan §Partial outfit state), not a complete snapshot:
 * zero or more `- Slot: value` lines after `Outfit:`, each exactly once, in canonical relative
 * order (present slots must appear in the same Outerwear/Top/Bottom/Underwear top/Underwear
 * bottom/Accessory sequence as the full vocabulary, just with gaps allowed) — an omitted slot
 * carries no information (the caller merges it against the prior state), and `- Slot: none` is
 * the explicit "wearing nothing there" value. Empty slot values are a format failure (they would
 * be ambiguous between "unknown" and "none").
 *
 * The parser does not hardcode the `<details>` / `<summary>▸</summary>` wrapper — locating the
 * footer region is the Cleaner's job (cleanup_footer_regex, resolved into the region text before
 * this parse). For robustness it only treats leaf blocks carrying the field markers as character
 * blocks, so a wrapper anchored by the region regex is tolerated without re-encoding that
 * wrapper here.
 *
 * A malformed footer is a structured failure, not a partial parse: `parseCharacterVisualStateFooter`
 * returns `{ ok: false, reason }` and the caller fails open (logs, leaves existing visual state
 * unchanged, fires nothing — plan §Edge cases). This module owns no state and does no IO.
 *
 * Also exports the single normalization implementation used by the Stage-3 diff and the cache
 * keys (`visual_expression_definitions.word`, `character_visual_combinations.outfit_key` /
 * `expression_key`) — one normalization, not three copies (plan §2). `''` (unknown), `none`
 * (explicitly not worn) and a concrete value are three distinct normalized keys.
 *
 * @api-declaration
 * parseCharacterVisualStateFooter(footerText, header) -> CharacterVisualParseResult — pure; parses
 *   the already-extracted footer region (not the whole turn), one record per character block, and
 *   enforces the one-to-one roster match. ok:false (never throws) with a human-readable reason on
 *   any failure.
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

/** One character's structured snapshot, exactly as the footer authored it (raw, only trimmed).
 *  The canonical six-slot vocabulary (plan §Canonical footer format). Keys match the
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

/** The full six-slot outfit a persisted snapshot carries (every slot always has a value: a
 *  concrete worn item, 'none', or '' when nothing was ever parsed for it). */
export interface OutfitFields {
  outerwear: string;
  top: string;
  bottom: string;
  underwear_top: string;
  underwear_bottom: string;
  accessory: string;
}

/** A parsed footer's outfit is a partial update — zero or more slots; an omitted slot carries no
 *  information (the caller merges it against the prior state). */
export type OutfitUpdate = Partial<OutfitFields>;

export interface CharacterVisualSnapshot {
  innerThoughts: string;
  expression: string;
  outfit: OutfitFields;
}

export interface CharacterVisualRecord {
  /** The block's tag name, validated one-to-one against the header roster. */
  name: string;
  innerThoughts: string;
  expression: string;
  /** The partial outfit the footer actually declared — merged against the prior state by the
   *  caller, which then builds the full OutfitFields snapshot. */
  outfit: OutfitUpdate;
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

/** An open tag for a roster-name block. Names are limited to the compact charset the plan's
 *  canonical format uses; any other name is a Cleaner format failure, not a guessable identity. */
const OPEN_TAG_RE = /<([A-Za-z][A-Za-z0-9 _-]*)\s*>/g;

/** A `<Tag>` inside a block — the evidence the block is a wrapper, not a leaf character block. */
const NESTED_TAG_RE = /<[A-Za-z][A-Za-z0-9 _-]*\s*>/;

/** The mandatory field markers a leaf character block must carry. */
const FIELD_MARKER_RE = /(?:Inner\s*thoughts:|Expression:|Outfit:)/i;

const SLOT_LINE_RE = /^- ([A-Za-z][A-Za-z ]*):[ \t]*(.*)$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A candidate character block: no nested tags (a wrapper like <details>/<summary> carries the
 *  character blocks) and at least one of the three mandatory field markers. */
function isCharacterBlock(content: string): boolean {
  return !NESTED_TAG_RE.test(content) && FIELD_MARKER_RE.test(content);
}

/**
 * Pure parse of an already-extracted footer region (located by the Cleaner's cleanup_footer_regex
 * before this function runs — never the whole turn text). Parses each leaf `<Name>…</Name>` block
 * carrying the field markers into a structured record and enforces the one-to-one roster match
 * (every `Present:` name has exactly one block; no unknown, duplicate, or missing character — any
 * deviation rejects the whole extraction, per plan §Edge cases). Wrapper tags (the region regex's
 * optional `<details>` / `<summary>▸</summary>` around the character blocks) are skipped by
 * rescanning from just past their open tag, so their interior content is never lost. Returns a
 * structured failure on any mismatch; never throws. Roster order is not enforced — blocks are
 * matched to characters by name, so a well-formed reordering is still parsed — but the *set* must
 * match exactly.
 */
export function parseCharacterVisualStateFooter(footerText: string, header: StoryHeader | null): CharacterVisualParseResult {
  if (!header || header.present.length === 0) {
    return { ok: false, reason: 'no-present' };
  }
  if (footerText.trim() === '') {
    return { ok: false, reason: 'no-footer' };
  }

  const records: CharacterVisualRecord[] = [];
  const seen = new Set<string>();
  let scanFrom = 0;
  while (true) {
    OPEN_TAG_RE.lastIndex = scanFrom;
    const open = OPEN_TAG_RE.exec(footerText);
    if (!open) break;
    const name = open[1]!.trim();
    if (name === '') {
      return { ok: false, reason: 'empty-character-tag' };
    }
    // The block ends at the first matching close tag (no extra wrapper tags inside a leaf block,
    // per the plan's canonical format — a stray literal close tag in authored text is a format
    // failure).
    const closeRe = new RegExp(`</${escapeRegExp(name)}\\s*>`);
    closeRe.lastIndex = open.index + open[0].length;
    const close = closeRe.exec(footerText);
    if (!close) {
      return { ok: false, reason: `unclosed-character-block: ${name}` };
    }
    const blockContent = footerText.slice(open.index + open[0].length, close.index);

    // Wrapper tolerance: only leaf blocks with the field markers are character blocks. For a
    // skipped wrapper we rescan from just past its open tag so the character blocks it contains
    // are still parsed.
    if (!isCharacterBlock(blockContent)) {
      scanFrom = open.index + open[0].length;
      continue;
    }
    scanFrom = close.index + close[0].length;

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

/** One `<Name>…</Name>` block: the three fields in order, then zero or more `- Slot: value` lines
 *  — each known slot exactly once, in canonical relative order, non-empty value. Returns the
 *  parsed record or a structured failure. Omitted slots are a partial update, never a failure. */
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
  const values: OutfitUpdate = {};
  const seenSlots = new Set<OutfitFieldKey>();
  let lastSlotIdx = -1;
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
    if (seenSlots.has(key)) {
      return { ok: false, reason: `duplicate-outfit-slot: ${name}` };
    }
    const value = m[2]!.trim();
    if (value === '') {
      return { ok: false, reason: `empty-outfit-slot-value: ${name}` };
    }
    const slotIdx = OUTFIT_SLOT_KEYS.indexOf(key);
    if (slotIdx < lastSlotIdx) {
      return { ok: false, reason: `outfit-slots-out-of-order: ${name}` };
    }
    lastSlotIdx = slotIdx;
    seenSlots.add(key);
    values[key] = value;
  }

  return { ok: true, name, innerThoughts, expression: expressionRaw, outfit: values };
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
 *  separator is a control character no authored slot value will contain. `''` (unknown), `none`
 *  (explicitly not worn) and a concrete item are three distinct keys — the merge that builds a
 *  full snapshot never converts between them. */
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