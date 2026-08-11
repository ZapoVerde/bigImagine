/**
 * @file orchestrator/src/util/parseCharacterBookEntries.ts
 * @stamp 2026-08-11
 * @architectural-role Pure Function — parses a Character Card V2/V3 `character_book` into
 *   lorebook entry drafts
 * @description
 * The Character Card V2/V3 spec allows an embedded lorebook at `data.character_book` — `{ name?,
 * description?, scan_depth?, token_budget?, recursive_scanning?, entries: CharacterBookEntry[] }`,
 * each entry shaped close to (not identical to) an ST world-info entry. chub-lorebook-import-plan.md
 * §A turns that inert block into real `lorebooks`/`lorebook_entries`/`lorebook_character_links`
 * rows; this module is the parse half, and it lives in core rather than plugins/characters because
 * docs/lorebook-plan.md §8a's ST-world-info-JSON importer needs the identical target shape
 * (`LorebookEntryDraft`) for its own, differently-sourced parse — same reasoning
 * assemblePromptStack.ts's preamble gives for why it lives in core: a pure function with no
 * plugin-specific state, needed by more than one caller.
 *
 * Deliberately not part of cardCodec.ts: parseCardJson normalizes the *character* columns and is
 * plugin-local; this is the *lorebook* half, whose output shape belongs to core's lorebook domain,
 * not to the character-card plugin.
 *
 * @api-declaration
 * parseCharacterBookEntries(cardJson) — returns LorebookEntryDraft[] or null when the card has no
 *   character_book (or an empty entries array) — the common case, a fast obvious no-op
 * characterBookName(cardJson) — returns the book's `name` field, or null when absent
 * LorebookEntryDraft — the shared target shape (also produced by adminServer.ts's ST importer)
 *
 * @contract
 *   assertions:
 *     purity:          pure (operates only on the object it's given; no IO, no settings)
 *     state_ownership: []
 *     external_io:     []
 */

export interface LorebookEntryDraft {
  uid: number;
  key: string[];
  keysecondary: string[];
  comment: string;
  content: string;
  constant: boolean;
  selective: boolean;
  disable: boolean;
  orderValue: number;
  position: number;
  probability: number;
  depth: number | null;
  groupName: string;
  useProbability: boolean;
  groupWeight: number;
  groupOverride: boolean;
  sticky: number;
  cooldown: number;
  delay: number;
  sourceJson: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** `data.character_book` wins when both are present, mirroring parseCardJson's own precedence. */
function characterBookOf(cardJson: unknown): Record<string, unknown> | null {
  const top = asRecord(cardJson);
  if (!top) return null;
  const data = asRecord(top.data);
  const inData = data ? asRecord(data.character_book) : null;
  if (inData) return inData;
  return asRecord(top.character_book);
}

/** Reads the embedded book's `name`, or null when there's no character_book at all. */
export function characterBookName(cardJson: unknown): string | null {
  const book = characterBookOf(cardJson);
  if (!book) return null;
  const name = asString(book.name);
  return name.trim() ? name : null;
}

/**
 * Maps one spec entry to a draft. Unknown fields (case_sensitive, scan_depth, token_budget,
 * recursive_scanning, …) are deliberately ignored — they survive verbatim in source_json
 * (lorebook-plan.md §3c dropped case_sensitive as an evaluated column; this plan doesn't reopen
 * that). Non-numeric/invalid fields fall back to the column defaults so a hand-edited card can't
 * poison the row. position maps 'before_char'→0 / 'after_char'→1, the 0051 position smallint.
 */
function parseCharacterBookEntry(raw: unknown, uid: number): LorebookEntryDraft | null {
  const e = asRecord(raw);
  if (!e) return null;
  const comment = asString(e.comment) || asString(e.name);
  const position = e.position === 'before_char' ? 0 : e.position === 'after_char' ? 1 : 0;
  return {
    uid,
    key: asStringArray(e.keys),
    keysecondary: asStringArray(e.secondary_keys),
    comment,
    content: asString(e.content),
    constant: asBool(e.constant, false),
    selective: asBool(e.selective, true),
    disable: e.enabled === false, // !enabled → disable; missing enabled means "on"
    orderValue: typeof e.insertion_order === 'number' ? e.insertion_order : 100,
    position,
    probability: 100,
    depth: null,
    groupName: '',
    useProbability: false,
    groupWeight: 1,
    groupOverride: false,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    sourceJson: e,
  };
}

/** Returns the embedded lorebook as entry drafts, or null when there is none / it is empty. */
export function parseCharacterBookEntries(cardJson: unknown): LorebookEntryDraft[] | null {
  const book = characterBookOf(cardJson);
  if (!book || !Array.isArray(book.entries)) return null;
  if (book.entries.length === 0) return null;

  // uid synthesis mirrors ST's getFreeWorldEntryUid for a fresh book: valid explicit `id`s are
  // honored, and anything else — a missing id, a non-integer/negative one, or a duplicate — gets
  // the lowest non-negative integer not already taken, in order. lorebook_entries has
  // unique (lorebook_id, uid), so a wild hand-edited card must never be able to collide uids and
  // roll back the whole import (character included).
  const used = new Set<number>();
  let cursor = 0;
  const nextFree = (): number => {
    while (used.has(cursor)) cursor++;
    const uid = cursor;
    used.add(uid);
    cursor++;
    return uid;
  };
  const pickUid = (raw: unknown): number => {
    const explicit = asRecord(raw)?.id;
    if (typeof explicit === 'number' && Number.isInteger(explicit) && explicit >= 0 && !used.has(explicit)) {
      used.add(explicit);
      return explicit;
    }
    return nextFree();
  };

  const drafts: LorebookEntryDraft[] = [];
  for (const raw of book.entries) {
    const draft = parseCharacterBookEntry(raw, pickUid(raw));
    if (draft) drafts.push(draft);
  }
  return drafts.length > 0 ? drafts : null;
}
