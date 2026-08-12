/**
 * @file orchestrator/src/io/llm/stub.ts
 * @stamp 2026-08-11
 * @architectural-role IO Wrapper — deterministic LlmProvider for local verification, never
 * selected by createLlmProvider's config-driven dispatch (dev/test only)
 * @description
 * Exists so orchestrator/loop.ts can be verified end to end without network access or an API
 * key: no live provider is reachable from the sandbox this was built in. Scripted by the
 * caller as a queue of turns to return in order, so a verification script can assert the loop
 * drives a tool call, feeds the result back, and produces a final reply — the same control
 * flow a real provider would trigger, with no reasoning happening on either side.
 *
 * completeStream (the streaming path the RP lane uses) replays the scripted turn's
 * message.content as a handful of small deterministic chunks through onDelta before resolving
 * with the same scripted LlmTurn — no timers, no network, so a verification script can drive
 * runStreamingRpTurn and assert deltas arrive in order against a stub, exactly the way the real
 * adapters' streamed text would.
 *
 * @api-declaration
 * createStubLlmProvider(scriptedTurns: LlmTurn[], options?: {supportsVision?: boolean}) — returns
 *   an LlmProvider that yields scriptedTurns in order, one per complete()/completeStream() call;
 *   throws if called more times than scripted. supportsVision defaults to false, same as a real
 *   adapter's own default when a profile doesn't set it — pass true to test the images/vision-gate
 *   success path (server/httpServer.ts) without a real provider.
 *
 * @contract
 *   assertions:
 *     purity:          impure (mutable call counter)
 *     state_ownership: [its own call index]
 *     external_io:     []
 */

import type {
  LlmCompleteOptions,
  LlmMessage,
  LlmProvider,
  LlmTurn,
  ToolDefinition,
} from './types.js';

export function createStubLlmProvider(scriptedTurns: LlmTurn[], options?: { supportsVision?: boolean }): LlmProvider {
  let callIndex = 0;

  function nextScriptedTurn(): LlmTurn {
    if (callIndex >= scriptedTurns.length) {
      throw new Error(
        `stub LLM provider called ${callIndex + 1} times but only ${scriptedTurns.length} turns were scripted`,
      );
    }
    return scriptedTurns[callIndex++];
  }

  return {
    name: 'stub',
    supportsVision: options?.supportsVision ?? false,
    async complete(
      _messages: LlmMessage[],
      _tools: ToolDefinition[],
      _options?: LlmCompleteOptions,
    ): Promise<LlmTurn> {
      return nextScriptedTurn();
    },
    async completeStream(
      _messages: LlmMessage[],
      _tools: ToolDefinition[],
      onDelta: (textDelta: string) => void,
      _options?: LlmCompleteOptions,
    ): Promise<LlmTurn> {
      const turn = nextScriptedTurn();
      const content = turn.message.content;
      // Replay the whole reply as a handful of small deterministic chunks (no timers, no
      // network) so verification exercises the streaming path for real. Chunk boundaries are
      // arbitrary but stable — the contract only guarantees order and concatenation.
      const chunkSize = Math.max(1, Math.ceil(content.length / 5));
      for (let i = 0; i < content.length; i += chunkSize) {
        onDelta(content.slice(i, i + chunkSize));
      }
      return turn;
    },
  };
}
