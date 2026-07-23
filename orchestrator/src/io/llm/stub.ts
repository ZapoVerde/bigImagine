/**
 * @file orchestrator/src/io/llm/stub.ts
 * @stamp 2026-07-21
 * @architectural-role IO Wrapper — deterministic LlmProvider for local verification, never
 * selected by createLlmProvider's config-driven dispatch (dev/test only)
 * @description
 * Exists so orchestrator/loop.ts can be verified end to end without network access or an API
 * key: no live provider is reachable from the sandbox this was built in. Scripted by the
 * caller as a queue of turns to return in order, so a verification script can assert the loop
 * drives a tool call, feeds the result back, and produces a final reply — the same control
 * flow a real provider would trigger, with no reasoning happening on either side.
 *
 * @api-declaration
 * createStubLlmProvider(scriptedTurns: LlmTurn[]) — returns an LlmProvider that yields
 *   scriptedTurns in order, one per complete() call; throws if called more times than scripted
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

export function createStubLlmProvider(scriptedTurns: LlmTurn[]): LlmProvider {
  let callIndex = 0;

  return {
    name: 'stub',
    async complete(
      _messages: LlmMessage[],
      _tools: ToolDefinition[],
      _options?: LlmCompleteOptions,
    ): Promise<LlmTurn> {
      if (callIndex >= scriptedTurns.length) {
        throw new Error(
          `stub LLM provider called ${callIndex + 1} times but only ${scriptedTurns.length} turns were scripted`,
        );
      }
      return scriptedTurns[callIndex++];
    },
  };
}
