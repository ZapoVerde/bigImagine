/**
 * @file orchestrator/src/util/truncateForContext.ts
 * @stamp 2026-07-26
 * @architectural-role Pure Function — caps a chat attachment's text to a safe size for one turn
 * @description
 * Nothing in the orchestrator caps the size of what gets sent to a model today — maxTokens
 * (io/llm/types.ts) only bounds a reply's length, never the input. A file attachment is the first
 * thing whose size a household member controls directly by what they choose to upload, so this is
 * the first such guard. Character-based rather than token-based, on purpose: a token count needs a
 * per-provider tokenizer, which is exactly the vendor-specific coupling bb_principles.md §6 rules
 * out for anything on the reasoning-layer seam. This mirrors plugins/documents/src/chunkDocument.ts's
 * own CHUNK_CHAR_CAP — a plain ~4-chars/token heuristic, approximate by design.
 *
 * @api-declaration
 * DEFAULT_ATTACHMENT_CHAR_CAP — the default ceiling
 * truncateForContext(text, maxChars?) — {text, truncated, meta}; text is unchanged when it already
 *   fits within maxChars
 * buildTruncationBanner(meta, maxChars?) — the line told to the model when truncated is true
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export interface TruncationMeta {
  totalChars: number;
  totalLines: number;
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
  meta: TruncationMeta;
}

// ~100k characters, ~25k tokens at the same 4-chars/token heuristic chunkDocument.ts uses —
// generous for anything a household member would paste or attach, while still well short of any
// configured model's own context window.
export const DEFAULT_ATTACHMENT_CHAR_CAP = 100_000;

export function truncateForContext(text: string, maxChars: number = DEFAULT_ATTACHMENT_CHAR_CAP): TruncateResult {
  const meta: TruncationMeta = { totalChars: text.length, totalLines: text.split('\n').length };
  if (text.length <= maxChars) {
    return { text, truncated: false, meta };
  }
  return { text: text.slice(0, maxChars), truncated: true, meta };
}

export function buildTruncationBanner(meta: TruncationMeta, maxChars: number = DEFAULT_ATTACHMENT_CHAR_CAP): string {
  return `[truncated: showing the first ${maxChars} of ${meta.totalChars} characters, ${meta.totalLines} total lines]`;
}
