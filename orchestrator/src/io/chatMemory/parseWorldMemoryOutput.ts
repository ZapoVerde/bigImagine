/**
 * @file orchestrator/src/io/chatMemory/parseWorldMemoryOutput.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function — parses the world curator's raw text output into the existing
 *   WorldMemoryCuratorEntryDraft shape
 * @description
 * The 'rp'-kind sync lane's world curator (curateWorldMemory.ts) is an ordinary text completion
 * whose raw output follows this chunk's own plain-text OUTPUT FORMAT: `**UPDATE: Name**` /
 * `**NEW: Name**` blocks with a `Category:` metadata line, `**DUPLICATE: Name**` blocks with a
 * `Duplicate of:` line, and the exact `NO CHANGES NEEDED` sentinel for a no-op. This parser turns
 * that text back into the same { action, name, category, content, duplicateOf } draft shape the old
 * forced `curate_lorebook` tool call produced, so nothing downstream (chatMemorySync.ts's
 * upsert_world_memory step) changes shape.
 *
 * Deliberately strict — the same posture parseBridgeOutput.ts takes for the bridge: BI commits the
 * parse result straight into SQL-backed canon state, so a single malformed block fails the entire
 * curator response and the sync stage (rollback and the sync-status machinery handle it). The
 * parser does not repair misspelled actions, invented categories, missing names, or missing
 * duplicate targets — the prompt's deterministic no-op value `NO CHANGES NEEDED` is the only
 * accepted empty result, and even that must be exact (tolerant only of case and enclosing fence).
 *
 * @api-declaration
 * ParsedWorldMemoryEntry
 * parseWorldMemoryOutput(raw) — returns an array of drafts or throws `curateWorldMemory: ...` on
 *   empty, sentinel-less, or malformed output. Structurally identical to the IO wrapper's exported
 *   WorldMemoryCuratorEntryDraft; the local type mirrors it so no import cycle is needed between
 *   this pure module and the IO wrapper (same pattern parseBridgeOutput.ts uses for
 *   BridgePlotEntryDraft).
 *
 * @contract
 *   assertions:
 *     purity:          pure (operates only on the string it's given; no IO, no settings)
 *     state_ownership: []
 *     external_io:     []
 */

export interface ParsedWorldMemoryEntry {
  action: 'update' | 'new' | 'duplicate';
  name: string;
  category?: 'place' | 'thing' | 'concept';
  content?: string;
  duplicateOf?: string;
}

const BLOCK_HEADER_RE = /^\s*\*\*(UPDATE|NEW|DUPLICATE):(.*)$/;
const CATEGORY_LINE_RE = /^Category:\s*(.+)$/;
const DUPLICATE_OF_LINE_RE = /^Duplicate of:\s*(.+)$/;
const VALID_CATEGORIES = ['place', 'thing', 'concept'];
const NO_CHANGES_SENTINEL = 'NO CHANGES NEEDED';

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

interface WorldBlock {
  action: 'update' | 'new' | 'duplicate';
  name: string;
  body: string[];
}

// The OUTPUT FORMAT puts a block's Category/Duplicate-of line and its content in one unbroken
// paragraph, with a blank line only ever separating one block from the next (curateWorldMemory.ts's
// DEFAULT_WORLD_MEMORY_CURATOR_PROMPT). Splitting the body into paragraphs and requiring exactly one
// is what lets the parser tell "this block's own content" apart from stray/conversational text a
// model tacked on after it (between two blocks, or trailing after the last one) — without this, a
// second paragraph silently merges into the previous block's content instead of failing the whole
// response, the exact "arbitrary text between structured blocks" case §8 requires to throw.
function splitParagraphs(body: string[]): string[][] {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const raw of body) {
    const line = raw.trim();
    if (line === '') {
      if (current.length > 0) {
        paragraphs.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current);
  return paragraphs;
}

function parseBlock(block: WorldBlock): ParsedWorldMemoryEntry {
  if (block.name.length === 0) {
    throw new Error(`curateWorldMemory: ${block.action} entry has an empty name`);
  }

  const paragraphs = splitParagraphs(block.body);
  if (paragraphs.length > 1) {
    throw new Error(`curateWorldMemory: text outside any recognized block after entry "${block.name}"`);
  }
  const lines = paragraphs[0] ?? [];

  if (block.action === 'update' || block.action === 'new') {
    const categoryMatch = lines[0]?.match(CATEGORY_LINE_RE);
    if (!categoryMatch) {
      throw new Error(`curateWorldMemory: ${block.action} entry "${block.name}" has no Category line`);
    }
    const category = categoryMatch[1]!.trim();
    if (!VALID_CATEGORIES.includes(category)) {
      throw new Error(`curateWorldMemory: ${block.action} entry "${block.name}" has an invalid category "${category}"`);
    }
    const content = lines.slice(1).join('\n').trim();
    if (content.length === 0) {
      throw new Error(`curateWorldMemory: ${block.action} entry "${block.name}" has empty content`);
    }
    return { action: block.action, name: block.name, category: category as 'place' | 'thing' | 'concept', content };
  }

  const dupLines = lines.filter((l) => DUPLICATE_OF_LINE_RE.test(l));
  if (dupLines.length !== 1) {
    throw new Error(`curateWorldMemory: duplicate entry "${block.name}" requires exactly one "Duplicate of:" line`);
  }
  if (lines.length !== 1) {
    throw new Error(`curateWorldMemory: duplicate entry "${block.name}" must not carry a content body`);
  }
  const duplicateOf = dupLines[0]!.match(DUPLICATE_OF_LINE_RE)![1]!.trim();
  if (duplicateOf.length === 0) {
    throw new Error(`curateWorldMemory: duplicate entry "${block.name}" has an empty "Duplicate of:" target`);
  }
  return { action: 'duplicate', name: block.name, duplicateOf };
}

export function parseWorldMemoryOutput(raw: string): ParsedWorldMemoryEntry[] {
  const text = normalize(raw);
  if (text.length === 0) {
    throw new Error('curateWorldMemory: model returned an empty response');
  }
  if (text.toUpperCase() === NO_CHANGES_SENTINEL) {
    return [];
  }

  const blocks: WorldBlock[] = [];
  let current: WorldBlock | null = null;
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
          throw new Error('curateWorldMemory: text outside any recognized block');
        }
        continue;
      }
      current.body.push(line);
    }
  }
  if (current) blocks.push(current);

  if (blocks.length === 0) {
    throw new Error('curateWorldMemory: no recognized blocks');
  }

  return blocks.map(parseBlock);
}