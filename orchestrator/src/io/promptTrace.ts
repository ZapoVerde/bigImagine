/**
 * @file orchestrator/src/io/promptTrace.ts
 * @stamp 2026-08-07
 * @architectural-role IO Wrapper — in-memory per-chat record of the actual prompts a turn fired
 * @description
 * The Prompt Inspector's source for everything that is NOT deterministically reconstructable from
 * persisted chat state. The main turn prompt is, in principle, reconstructable (same
 * memory/preset/character reads, live) — and buildPromptPreview does fall back to exactly that
 * live assembly while no capture exists yet (bi_principles.md §13's live-read guarantee, and it
 * stays fresh while you compose). But once a turn has fired, the 'main' entry recorded here is the
 * exact text that turn sent — including attachment text appended ephemerally to the latest user
 * message (util/attachmentContext.ts), which is deliberately never persisted and would otherwise
 * be unrecoverable. And the cleanup pass text embeds {{message}} = the raw pre-cleanup reply,
 * which is discarded the moment cleanup rewrites it — nothing on disk can ever recover it. Same
 * for any future background prompt (kind 'title' today, more later): once fired, the exact text
 * exists nowhere except here.
 *
 * Ephemeral by design, in-memory only: prompt text is debug data, deliberately NOT persisted
 * (llm_calls stores token counts, never prompts — 0035/0041/0056). A restart loses the trace, and
 * the inspector falls back to showing just the live main-prompt preview until the next turn
 * records fresh entries. Bounded both ways: entries per chat (a few turns of background prompts,
 * then the oldest drop) and total chats (FIFO) — a long-lived household server can't grow without
 * bound.
 *
 * The capture pattern for a background prompt — or the main turn prompt itself: build the exact
 * messages array you're about to send, then `recordPromptTrace(chatId, { kind, title, items })`
 * immediately before the llm.complete() call — record before, regardless of whether the call later
 * throws (the prompt was sent either way). handleChatCompletions/regenerateSwipe record kind
 * 'main' this way (system prompt prepended, in send order); the cleanup subloop's repair prompts
 * (orchestrator/cleanupLoop.ts's dispatchStep) record kind 'cleanup'. A background prompt's entry
 * may also pick up a `reply` after the call returns — the model's output, which for a cleanup
 * repair is discarded the instant the cleaned text replaces it, so the trace is its only home.
 *
 * @api-declaration
 * recordPromptTrace(chatId, entry) — append one fired prompt to the chat's trace
 * getPromptTrace(chatId) — the chat's entries, oldest first
 * clearPromptTrace(chatId) — drop a chat's trace (chat deletion)
 *
 * @contract
 *   assertions:
 *     purity:          impure (module-level in-memory state)
 *     state_ownership: [this module's Map — nothing else mutates it]
 *     external_io:     []
 */

export interface PromptTraceItem {
  role: 'system' | 'user' | 'assistant';
  /** Optional cosmetic label (mirrors PromptPreviewItem.label for custom slots). */
  label?: string;
  content: string;
  chars: number;
  /** ~4 chars/token estimate — same rule as httpServer.ts's estimateTokens (bi_principles.md §6). */
  estimatedTokens: number;
}

export interface PromptTraceEntry {
  /** Stable kind tag: 'cleanup', 'title', or any future background prompt's own tag. */
  kind: string;
  /** Human heading shown in the inspector, e.g. 'Cleanup Prompt'. */
  title: string;
  items: PromptTraceItem[];
  /** The model's reply to this prompt, when the call produced one — attached after the call
   *  returns (the entry object stays live in the trace). For a cleanup repair this is the only
   *  place the reply ever exists: the cleaned text replaces it in the message, and the raw LLM
   *  output is otherwise unrecoverable. Absent when the call failed or replied empty. */
  reply?: string;
  capturedAt: number;
}

/** A few turns' worth of background prompts per chat before the oldest drop. */
const MAX_ENTRIES_PER_CHAT = 12;
/** Total chats traced before the oldest chat's trace is evicted (FIFO). */
const MAX_CHATS = 200;

const traces = new Map<string, PromptTraceEntry[]>();

export function recordPromptTrace(chatId: string, entry: PromptTraceEntry): void {
  let list = traces.get(chatId);
  if (!list) {
    list = [];
    traces.set(chatId, list);
    if (traces.size > MAX_CHATS) {
      const oldest = traces.keys().next().value;
      if (oldest !== undefined) traces.delete(oldest);
    }
  }
  list.push(entry);
  if (list.length > MAX_ENTRIES_PER_CHAT) {
    list.splice(0, list.length - MAX_ENTRIES_PER_CHAT);
  }
}

export function getPromptTrace(chatId: string): PromptTraceEntry[] {
  return traces.get(chatId) ?? [];
}

export function clearPromptTrace(chatId: string): void {
  traces.delete(chatId);
}
