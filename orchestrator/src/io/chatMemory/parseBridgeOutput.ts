/**
 * @file orchestrator/src/io/chatMemory/parseBridgeOutput.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function — parses the chronicler bridge's raw text output into the
 *   existing BridgeResult draft shape
 * @description
 * The 'rp'-kind sync lane's bridge call (bridgeChatMemory.ts) is an ordinary text completion whose
 * raw output follows Canonize's own "OUTPUT FORMAT" convention: an EVENTS markdown table, a SCENE
 * prose block, and zero or more `**NEW: Name**` plot blocks each ending in one arc tag. This parser
 * turns that raw text back into the same { events, scene, plotEntries } draft shape the old forced
 * `bridge_chat_memory` tool call produced, so nothing downstream (chatMemorySync.ts's SQL writes,
 * canon_facts, memoryInjection.ts) changes shape.
 *
 * Deliberately stricter than Canonize's own hookseeker-output.js, which tolerates partial and
 * malformed entries silently: BI commits the parse result straight into SQL, so EVENTS, SCENE, and
 * every `**NEW:` block must parse or the whole parse throws and the sync stage fails — rollback
 * and the sync-status machinery handle it, and a plot development is never silently dropped.
 *
 * Stored SCENE/EVENTS text carries no redundant heading: the parser slices past the `SCENE:` and
 * `EVENTS:` headings before storing, matching Canonize's behavior and resolving the doubled-
 * `SCENE:` defect the forced-tool schema's scene field used to produce (docs/plans/
 * chat-memory-structured-output-plan.md, Chunk 2 §3).
 *
 * @api-declaration
 * ParsedBridgeOutput, ParsedBridgePlotEntry
 * parseBridgeOutput(raw) — returns { events, scene, plotEntries } or throws `bridgeChatMemory: ...`
 *   on empty, missing-section, or malformed output. Structurally equivalent to BridgeResult minus
 *   its `prompt` snapshot field; the local plot-entry type mirrors BridgePlotEntryDraft so no
 *   import cycle is needed between this pure module and the IO wrapper.
 *
 * @contract
 *   assertions:
 *     purity:          pure (operates only on the string it's given; no IO, no settings)
 *     state_ownership: []
 *     external_io:     []
 */

export interface ParsedBridgePlotEntry {
  name: string;
  content: string;
  arcTag: string;
}

export interface ParsedBridgeOutput {
  events: string;
  scene: string;
  plotEntries: ParsedBridgePlotEntry[];
}

const EVENTS_HEADER_RE = /^EVENTS:/m;
const SCENE_HEADER_RE = /^SCENE:/m;
const TABLE_HEADER_RE = /^\|.*\|$/;
const TABLE_SEPARATOR_RE = /^\|(?:\s*:?-+:?\s*\|)+$/;
const ARC_TAG_RE = /^#[a-z0-9]+(?:_[a-z0-9]+)*$/;
const NEW_BLOCK_MARKER = '**NEW:';

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

function requireEventsTable(table: string): void {
  const lines = table
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length < 2) {
    throw new Error('bridgeChatMemory: EVENTS table is missing its header or separator row');
  }
  if (!TABLE_HEADER_RE.test(lines[0] ?? '')) {
    throw new Error('bridgeChatMemory: EVENTS table has no header row');
  }
  if (!TABLE_SEPARATOR_RE.test(lines[1] ?? '')) {
    throw new Error('bridgeChatMemory: EVENTS table has no separator row');
  }
}

function parsePlotEntries(text: string): ParsedBridgePlotEntry[] {
  const blocks = text.split(/\*\*NEW:/g).slice(1);
  const entries: ParsedBridgePlotEntry[] = [];
  for (const block of blocks) {
    const newline = block.indexOf('\n');
    const headerLine = (newline === -1 ? block : block.slice(0, newline)).trim();
    const body = newline === -1 ? '' : block.slice(newline);

    let name = headerLine;
    if (name.endsWith('**')) name = name.slice(0, -2);
    name = name.trim();
    if (name.length === 0) {
      throw new Error('bridgeChatMemory: plot entry has an empty name');
    }

    const lines = body.split('\n');
    const nonEmpty: { text: string; index: number }[] = [];
    for (const [i, line] of lines.entries()) {
      const text = line.trim();
      if (text !== '') nonEmpty.push({ text, index: i });
    }
    if (nonEmpty.length === 0) {
      throw new Error('bridgeChatMemory: plot entry has empty content');
    }
    const last = nonEmpty[nonEmpty.length - 1]!;
    if (!ARC_TAG_RE.test(last.text)) {
      throw new Error(`bridgeChatMemory: plot entry "${name}" has no valid arc tag`);
    }
    if (nonEmpty.slice(0, -1).some((l) => ARC_TAG_RE.test(l.text))) {
      throw new Error(`bridgeChatMemory: plot entry "${name}" has multiple arc tags`);
    }
    const content = lines.slice(0, last.index).join('\n').trim();
    if (content.length === 0) {
      throw new Error('bridgeChatMemory: plot entry has empty content');
    }
    entries.push({ name, content, arcTag: last.text.slice(1) });
  }
  return entries;
}

export function parseBridgeOutput(raw: string): ParsedBridgeOutput {
  const text = normalize(raw);
  if (text.length === 0) {
    throw new Error('bridgeChatMemory: model returned an empty response');
  }

  const eventsMatch = text.search(EVENTS_HEADER_RE);
  const sceneMatch = text.search(SCENE_HEADER_RE);
  if (eventsMatch === -1) {
    throw new Error('bridgeChatMemory: output is missing the EVENTS section');
  }
  if (sceneMatch === -1) {
    throw new Error('bridgeChatMemory: output is missing the SCENE section');
  }
  if (eventsMatch > sceneMatch) {
    throw new Error('bridgeChatMemory: the EVENTS section must appear before SCENE');
  }

  const eventsTable = text.slice(eventsMatch + 'EVENTS:'.length, sceneMatch).trim();
  requireEventsTable(eventsTable);

  const afterScene = text.slice(sceneMatch + 'SCENE:'.length);
  const newIdx = afterScene.indexOf(NEW_BLOCK_MARKER);
  // Strip a leading `SCENE:` from the body as well as the heading line, mirroring Canonize's own
  // hookseeker-output.js `/^SCENE:\s*/i` strip — a model trained on the old forced-tool schema
  // could begin its body with `SCENE:` on its own line, and without this second strip the stored
  // scene would double the heading on every later PREVIOUS OUTPUT round-trip.
  let scene = (newIdx === -1 ? afterScene : afterScene.slice(0, newIdx)).trim().replace(/^SCENE:\s*/i, '').trim();
  if (scene.length === 0) {
    throw new Error('bridgeChatMemory: output has an empty SCENE');
  }

  const plotEntries = newIdx === -1 ? [] : parsePlotEntries(afterScene.slice(newIdx));
  return { events: eventsTable, scene, plotEntries };
}
