/**
 * @file orchestrator/src/io/llm/sse.ts
 * @stamp 2026-08-11
 * @architectural-role Pure Function — SSE byte-stream framing shared by the two streaming adapters
 * @description
 * Both anthropic.ts's and openaiCompatible.ts's completeStream parse a vendor SSE response body.
 * The framing — decode UTF-8 bytes, split on CRLF/LF, keep the `data:` field payloads (skipping
 * `event:`/`id:`/comment lines) — is byte-identical across vendors; only what each vendor puts
 * inside a `data:` payload differs. That shared part lives here rather than being copied into
 * both adapters (bb_principles.md §10: one purpose per file, split along the fault line).
 *
 * Multi-line `data:` fields are deliberately NOT joined across lines: neither Anthropic nor
 * OpenAI-compatible streaming splits a JSON payload across `data:` lines, so a payload is exactly
 * one `data:` line — joining would be untested complexity, not a real vendor behavior.
 *
 * @api-declaration
 * readSseDataPayloads(body: ReadableStream<Uint8Array>) — async generator yielding each `data:`
 *   field's payload in arrival order, with the optional single leading space stripped per the
 *   SSE spec
 *
 * @contract
 *   assertions:
 *     purity:          pure (byte stream in, strings out)
 *     state_ownership: []
 *     external_io:     []
 */

export async function* readSseDataPayloads(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5);
          yield payload.startsWith(' ') ? payload.slice(1) : payload;
        }
      }
    }
    // The last line may arrive without a trailing newline — handle it the same way.
    const finalLine = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
    if (finalLine.startsWith('data:')) {
      const payload = finalLine.slice(5);
      yield payload.startsWith(' ') ? payload.slice(1) : payload;
    }
  } finally {
    reader.releaseLock();
  }
}
