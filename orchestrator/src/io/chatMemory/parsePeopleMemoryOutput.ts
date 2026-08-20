/**
 * @file orchestrator/src/io/chatMemory/parsePeopleMemoryOutput.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function — parses the people curator's raw text output into the existing
 *   PeopleCuratorEntryDraft shape
 * @description
 * The 'rp'-kind sync lane's people curator (curatePeople.ts) is an ordinary text completion whose
 * raw output follows this chunk's own plain-text OUTPUT FORMAT: `**NEW: Two Word Name**` /
 * `**UPDATE: Two Word Name**` blocks containing a full six-section person card (## Appearance, ##
 * Personality, ## Core Misread, ## Connections, ## Relationship with ..., ## Goals), `**DUPLICATE:
 * Name**` blocks with a `Duplicate of:` line, and the exact `NO CHANGES NEEDED` sentinel for a
 * no-op. This parser turns that text back into the same { action, name, content, appearance,
 * duplicateOf } draft shape the old forced `curate_people` tool call produced, so nothing
 * downstream (chatMemorySync.ts's upsert_people step) changes shape.
 *
 * The one BI-specific split: ## Appearance is carved out of the card into its own `appearance`
 * field (Portrait Studio consumes the physical treatment independently), and the remaining five
 * sections stay together, headings included, as one markdown `content` block — reproducing the old
 * forced tool's two-field contract without ever asking the model to emit an artificial
 * BI serialization format.
 *
 * Deliberately strict — the same posture parseWorldMemoryOutput.ts takes: BI commits the parse
 * result straight into SQL-backed canon state, so a single malformed block fails the entire curator
 * response and the sync stage (rollback and the sync-status machinery handle it). The parser does
 * not repair misspelled actions, guessed person names, missing sections, or missing duplicate
 * targets. Two gates are new with this chunk and enforced hard: the exactly-two-word naming rule
 * (the prompt always stated it, the old tool schema never enforced it) and the Goals
 * one-Major / exactly-three-Minors shape (docs/plans/chat-memory-people-curator-plan.md §6/§10).
 * The parser stays context-free — it never compares an UPDATE against a previous card, which is
 * prompt behaviour by design (§13).
 *
 * @api-declaration
 * ParsedPeopleMemoryEntry
 * parsePeopleMemoryOutput(raw) — returns an array of drafts or throws `curatePeople: ...` on
 *   empty, sentinel-less, or malformed output. Structurally identical to the IO wrapper's exported
 *   PeopleCuratorEntryDraft; the local type mirrors it so no import cycle is needed between this
 *   pure module and the IO wrapper (same pattern parseWorldMemoryOutput.ts uses for
 *   WorldMemoryCuratorEntryDraft).
 *
 * @contract
 *   assertions:
 *     purity:          pure (operates only on the string it's given; no IO, no settings)
 *     state_ownership: []
 *     external_io:     []
 */

export interface ParsedPeopleMemoryEntry {
  action: 'update' | 'new' | 'duplicate';
  name: string;
  content?: string;
  appearance?: string;
  duplicateOf?: string;
}

const NO_CHANGES_SENTINEL = 'NO CHANGES NEEDED';
const BLOCK_HEADER_RE = /^\s*\*\*(NEW|UPDATE|DUPLICATE):(.*)$/;
const DUPLICATE_OF_LINE_RE = /^Duplicate of:\s*(.+)$/;

// The six card sections, in the exact order a valid card must present them. The relationship
// heading is matched structurally (`## Relationship with <anything>`) because {{user}} is
// interpolated before the prompt is sent — the parser must not depend on the real user's name
// (chat-memory-people-curator-plan.md §7). Only a heading that matches one of these six, whole
// line, is recognized; anything else starting a markdown heading inside a card is malformed.
const SECTION_HEADINGS = [
  { key: 'appearance', re: /^##\s*Appearance\s*$/ },
  { key: 'personality', re: /^##\s*Personality\s*$/ },
  { key: 'coreMisread', re: /^##\s*Core Misread\s*$/ },
  { key: 'connections', re: /^##\s*Connections\s*$/ },
  { key: 'relationship', re: /^##\s*Relationship with\s+(.+)\s*$/ },
  { key: 'goals', re: /^##\s*Goals\s*$/ },
];

// Connections special case (plan §9): an empty table (no data rows) is legitimate for a character
// with no named connections yet, but the table skeleton must be present. Match structurally rather
// than byte-for-byte — models vary pipe/dash spacing.
const CONNECTIONS_HEADER_RE = /^\s*\|?\s*Person\b.*\bRelation\b.*\bTone\b.*$/i;
const TABLE_SEPARATOR_RE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;

// Goals shape (plan §10): one Major line and exactly three Minor lines. Non-empty values are
// inherent — a line whose value is empty doesn't match, so the count check rejects it.
const MAJOR_GOAL_RE = /^Major:\s*(.+)$/;
const MINOR_GOAL_RE = /^Minor:\s*(.+)$/;

function normalize(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim();
  if (text.startsWith('```') && text.endsWith('```')) {
    text = text
      .replace(/^```[^\n]*\n/, '')
      .replace(/\n```\s*$/, '')
      .trim();
  }
  return text;
}

// Exactly two whitespace-separated tokens — the rule is token count, not ASCII letters, so names
// may legitimately carry apostrophes or non-English characters. Parenthetical qualifiers are
// rejected outright: the prompt's "no parenthetical qualifiers — ever" is part of the naming
// contract. This is a NEW hard gate this chunk introduces (plan §6), not a carried-over one.
function validateTwoWordName(name: string): void {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('curatePeople: entry has an empty name');
  }
  if (trimmed.includes('(') || trimmed.includes(')')) {
    throw new Error(`curatePeople: name "${trimmed}" carries a parenthetical qualifier`);
  }
  const words = trimmed.split(/\s+/);
  if (words.length !== 2) {
    throw new Error(`curatePeople: name "${trimmed}" is not exactly two words`);
  }
}

interface PeopleBlock {
  action: 'update' | 'new' | 'duplicate';
  name: string;
  body: string[];
}

interface ParsedSection {
  key: string;
  heading: string;
  bodyLines: string[];
}

function matchSectionHeading(line: string): { index: number; key: string } | null {
  const trimmed = line.trim();
  for (let i = 0; i < SECTION_HEADINGS.length; i++) {
    if (SECTION_HEADINGS[i]!.re.test(trimmed)) {
      return { index: i, key: SECTION_HEADINGS[i]!.key };
    }
  }
  return null;
}

function validateConnectionsTable(body: string): void {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const headerIdx = lines.findIndex((l) => CONNECTIONS_HEADER_RE.test(l));
  if (headerIdx === -1) {
    throw new Error('curatePeople: Connections section has no "| Person | Relation | Tone |" header row');
  }
  const separator = lines[headerIdx + 1];
  if (!separator || !TABLE_SEPARATOR_RE.test(separator)) {
    throw new Error('curatePeople: Connections section has no separator row beneath its header');
  }
}

function validateGoals(body: string): void {
  const lines = body.split('\n').map((l) => l.trim());
  const majorLines = lines.filter((l) => MAJOR_GOAL_RE.test(l));
  const minorLines = lines.filter((l) => MINOR_GOAL_RE.test(l));
  if (majorLines.length !== 1) {
    throw new Error(`curatePeople: Goals section requires exactly one "Major:" line (found ${majorLines.length})`);
  }
  if (minorLines.length !== 3) {
    throw new Error(`curatePeople: Goals section requires exactly three "Minor:" lines (found ${minorLines.length})`);
  }
}

function parsePersonBlock(action: 'update' | 'new', name: string, body: string[]): ParsedPeopleMemoryEntry {
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;
  let seenIndex = -1;
  let personalityIndex = -1;

  for (let i = 0; i < body.length; i++) {
    const line = body[i]!;
    const heading = matchSectionHeading(line);
    if (heading) {
      if (current) sections.push(current);
      if (heading.index <= seenIndex) {
        throw new Error(
          `curatePeople: ${action} entry "${name}" has duplicate or out-of-order section heading "${line.trim()}"`,
        );
      }
      seenIndex = heading.index;
      if (heading.key === 'personality') personalityIndex = i;
      current = { key: heading.key, heading: line.trim(), bodyLines: [] };
    } else {
      if (!current) {
        if (line.trim() !== '') {
          throw new Error(`curatePeople: ${action} entry "${name}" has text before its ## Appearance section`);
        }
        continue;
      }
      current.bodyLines.push(line);
    }
  }
  if (current) sections.push(current);

  if (sections.length !== SECTION_HEADINGS.length) {
    throw new Error(`curatePeople: ${action} entry "${name}" is missing one or more required sections`);
  }
  const sectionKeys = sections.map((s) => s.key);
  const expectedKeys = SECTION_HEADINGS.map((s) => s.key);
  if (sectionKeys.join(',') !== expectedKeys.join(',')) {
    throw new Error(`curatePeople: ${action} entry "${name}" has sections out of order`);
  }

  const appearance = sections[0]!.bodyLines.join('\n').trim();
  if (appearance.length === 0) {
    throw new Error(`curatePeople: ${action} entry "${name}" has an empty ## Appearance section`);
  }

  const personality = sections[1]!.bodyLines.join('\n').trim();
  const coreMisread = sections[2]!.bodyLines.join('\n').trim();
  const relationship = sections[4]!.bodyLines.join('\n').trim();
  if (personality.length === 0) {
    throw new Error(`curatePeople: ${action} entry "${name}" has an empty ## Personality section`);
  }
  if (coreMisread.length === 0) {
    throw new Error(`curatePeople: ${action} entry "${name}" has an empty ## Core Misread section`);
  }
  if (relationship.length === 0) {
    throw new Error(`curatePeople: ${action} entry "${name}" has an empty ## Relationship with ... section`);
  }

  validateConnectionsTable(sections[3]!.bodyLines.join('\n'));
  validateGoals(sections[5]!.bodyLines.join('\n'));

  // Content is the raw card from the ## Personality heading onward, headings and bodies included —
  // Appearance is carved out as its own field, everything else stays one markdown document.
  const content = body.slice(personalityIndex).join('\n').trim();

  return { action, name, appearance, content };
}

function parseDuplicateBlock(name: string, body: string[]): ParsedPeopleMemoryEntry {
  const dupLines: string[] = [];
  const otherLines: string[] = [];
  for (const line of body) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (DUPLICATE_OF_LINE_RE.test(trimmed)) dupLines.push(trimmed);
    else otherLines.push(trimmed);
  }
  if (dupLines.length !== 1) {
    throw new Error(`curatePeople: duplicate entry "${name}" requires exactly one "Duplicate of:" line`);
  }
  if (otherLines.length !== 0) {
    throw new Error(`curatePeople: duplicate entry "${name}" must not carry a person-card body`);
  }
  const duplicateOf = dupLines[0]!.match(DUPLICATE_OF_LINE_RE)![1]!.trim();
  validateTwoWordName(duplicateOf);
  return { action: 'duplicate', name, duplicateOf };
}

function parseBlock(block: PeopleBlock): ParsedPeopleMemoryEntry {
  validateTwoWordName(block.name);
  if (block.action === 'duplicate') {
    return parseDuplicateBlock(block.name, block.body);
  }
  return parsePersonBlock(block.action, block.name, block.body);
}

export function parsePeopleMemoryOutput(raw: string): ParsedPeopleMemoryEntry[] {
  const text = normalize(raw);
  if (text.length === 0) {
    throw new Error('curatePeople: model returned an empty response');
  }
  if (text.toUpperCase() === NO_CHANGES_SENTINEL) {
    return [];
  }

  const blocks: PeopleBlock[] = [];
  let current: PeopleBlock | null = null;
  for (const line of text.split('\n')) {
    const match = line.match(BLOCK_HEADER_RE);
    if (match) {
      if (current) blocks.push(current);
      const action = match[1]!.toLowerCase() as 'update' | 'new' | 'duplicate';
      const name = match[2]!.trim().replace(/\*\*+\s*$/, '').trim();
      current = { action, name, body: [] };
    } else {
      if (!current) {
        if (line.trim() !== '') {
          throw new Error('curatePeople: text outside any recognized block');
        }
        continue;
      }
      current.body.push(line);
    }
  }
  if (current) blocks.push(current);

  if (blocks.length === 0) {
    throw new Error('curatePeople: no recognized blocks');
  }

  return blocks.map(parseBlock);
}