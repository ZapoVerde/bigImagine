/**
 * @file orchestrator/src/io/chatMemory/parseDistillMemoryOutput.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function — parses the distill digest's raw text output into the existing
 *   ChatMemoryEntryDraft shape
 * @description
 * The 'chat'-kind sync lane's key-ideas distiller (distillChatMemory.ts) is an ordinary text
 * completion whose raw output follows this chunk's own plain-text OUTPUT FORMAT: `[topic_key]`
 * blocks with 1–3 sentence current-state content, and the exact `NO CHANGES NEEDED` sentinel for a
 * no-op. This parser turns that text back into the same { topicKey, content } draft shape the old
 * forced `distill_chat_memory` tool call produced, so nothing downstream (chatMemorySync.ts's
 * upsert_entries step) changes shape.
 *
 * Deliberately strict — the same posture parseWorldMemoryOutput.ts and parsePeopleMemoryOutput.ts
 * take: BI commits the parse result straight into SQL-backed canon state (chat_memory_entries,
 * keyed on (chat_id, topic_key)), so a single malformed block fails the entire distill response and
 * the sync stage (rollback and the sync-status machinery handle it). The parser does not repair
 * misspelled keys, empty content, duplicate keys, preamble prose, or stray text between/after
 * blocks (splitParagraphs — the same one-paragraph-per-block check parseWorldMemoryOutput.ts uses,
 * so trailing model chatter after the last block can't silently merge into that entry's content) —
 * the prompt's deterministic no-op value `NO CHANGES NEEDED` is the only accepted empty result, and
 * even that must be exact (tolerant only of case and enclosing fence).
 *
 * Two gates are new with this chunk (chat-memory-distill-plan.md §7/§8): topic keys must match
 * `[a-z0-9]+(?:_[a-z0-9]+)*` — the key is the stable SQL identity for the digest row, so malformed
 * keys directly damage the identity mechanism this stage relies on — and the same key may not
 * appear twice in one response (the model should produce one current-state replacement per idea;
 * "last one wins" would silently drop a change before the SQL upsert stage). Both are parser
 * integrity, not semantic judgment: the parser never decides whether a key already exists — that
 * remains the model's decision plus the existing SQL upsert behavior.
 *
 * @api-declaration
 * ParsedChatMemoryEntry
 * parseDistillMemoryOutput(raw) — returns an array of drafts or throws `distillChatMemory: ...` on
 *   empty, sentinel-less, or malformed output. Structurally identical to the IO wrapper's exported
 *   ChatMemoryEntryDraft; the local type mirrors it so no import cycle is needed between this pure
 *   module and the IO wrapper (same pattern parseWorldMemoryOutput.ts uses).
 *
 * @contract
 *   assertions:
 *     purity:          pure (operates only on the string it's given; no IO, no settings)
 *     state_ownership: []
 *     external_io:     []
 */

export interface ParsedChatMemoryEntry {
  topicKey: string;
  content: string;
}

const NO_CHANGES_SENTINEL = 'NO CHANGES NEEDED';
const TOPIC_KEY_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

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

function validateTopicKey(topicKey: string): void {
  if (!TOPIC_KEY_RE.test(topicKey)) {
    throw new Error(`distillChatMemory: invalid topic key "${topicKey}" — keys must be short, stable, lowercase snake_case identifiers`);
  }
}

// A block's own content is one unbroken paragraph (OUTPUT FORMAT: 1-3 sentences, no blank line
// inside it). Splitting a block's body into paragraphs and requiring exactly one is what lets the
// parser tell "this block's own content" apart from stray/conversational text a model tacked on
// after it (between two blocks, or trailing after the last one) — the same technique
// parseWorldMemoryOutput.ts uses for the identical failure mode. Without it, a second paragraph
// would silently merge into the previous block's content instead of failing the whole response.
function splitParagraphs(lines: string[]): string[][] {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const raw of lines) {
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

export function parseDistillMemoryOutput(raw: string): ParsedChatMemoryEntry[] {
  const text = normalize(raw);
  if (text.length === 0) {
    throw new Error('distillChatMemory: model returned an empty response');
  }
  if (text.toUpperCase() === NO_CHANGES_SENTINEL) {
    return [];
  }

  const entries: ParsedChatMemoryEntry[] = [];
  const seenKeys = new Set<string>();
  let currentKey: string | null = null;
  let currentContent: string[] = [];
  let started = false;

  const flush = () => {
    if (currentKey === null) return;
    const paragraphs = splitParagraphs(currentContent);
    if (paragraphs.length === 0) {
      throw new Error(`distillChatMemory: entry "${currentKey}" has empty content`);
    }
    if (paragraphs.length > 1) {
      throw new Error(`distillChatMemory: text outside any recognized block after entry "${currentKey}"`);
    }
    entries.push({ topicKey: currentKey, content: paragraphs[0]!.join('\n').trim() });
    currentKey = null;
    currentContent = [];
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const header = trimmed.match(/^\[(.+)\]$/);
    if (header) {
      flush();
      started = true;
      const topicKey = header[1]!.trim();
      if (topicKey.length === 0) {
        throw new Error('distillChatMemory: entry has an empty topic key');
      }
      validateTopicKey(topicKey);
      if (seenKeys.has(topicKey)) {
        throw new Error(`distillChatMemory: topic key "${topicKey}" appears more than once`);
      }
      seenKeys.add(topicKey);
      currentKey = topicKey;
    } else {
      if (!started) {
        if (trimmed !== '') {
          throw new Error('distillChatMemory: text outside any recognized block');
        }
        continue;
      }
      currentContent.push(line);
    }
  }
  flush();

  if (entries.length === 0) {
    throw new Error('distillChatMemory: no recognized blocks');
  }

  return entries;
}
