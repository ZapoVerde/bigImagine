/**
 * @file orchestrator/src/io/llm/anthropic.ts
 * @stamp 2026-07-21
 * @architectural-role IO Wrapper — LlmProvider adapter for the Anthropic Messages API
 * @description
 * Translates the vendor-neutral LlmProvider contract onto Anthropic's specific request/response
 * shape: system prompt as a top-level field rather than a message, tool results sent back as
 * user-role `tool_result` content blocks rather than a `tool` role, tool calls arriving as
 * `tool_use` content blocks rather than a separate field. All of that stays inside this file —
 * per bb_principles.md §6, nothing outside io/llm/ may know this vendor's shape exists.
 *
 * @api-declaration
 * createAnthropicLlmProvider(config: AnthropicConfig) — config.apiKey and config.model are
 *   required and read from env by io/llm/index.ts, never hardcoded here
 *
 * @contract
 *   assertions:
 *     purity:          impure (network call)
 *     state_ownership: []
 *     external_io:     [Anthropic Messages API]
 */

import { fetchWithRetry } from '../httpRetry.js';
import type {
  LlmCompleteOptions,
  LlmMessage,
  LlmProvider,
  LlmTurn,
  ToolCall,
  ToolDefinition,
} from './types.js';

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  apiVersion?: string;
  baseUrl?: string;
  maxTokens?: number;
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

function toAnthropicMessages(messages: LlmMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  const system = messages.find((m) => m.role === 'system')?.content;
  const rest = messages.filter((m) => m.role !== 'system');

  const anthropicMessages: AnthropicMessage[] = rest.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      // Reconstruct the original tool_use blocks the API sent, not just the leftover text —
      // a follow-up tool_result is only valid if it points back at a tool_use block that
      // actually appears in a preceding assistant turn.
      const blocks: AnthropicContentBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      return { role: 'assistant', content: blocks };
    }
    return {
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: m.content }],
    };
  });

  return { system, messages: anthropicMessages };
}

function toAnthropicTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

function fromAnthropicResponse(content: AnthropicContentBlock[]): LlmTurn {
  const text = content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');

  const toolCalls: ToolCall[] = content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id ?? '', name: b.name ?? '', arguments: b.input }));

  return { message: { role: 'assistant', content: text }, toolCalls };
}

export function createAnthropicLlmProvider(config: AnthropicConfig): LlmProvider {
  const baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
  const apiVersion = config.apiVersion ?? '2023-06-01';

  return {
    name: 'anthropic',
    async complete(
      messages: LlmMessage[],
      tools: ToolDefinition[],
      options?: LlmCompleteOptions,
    ): Promise<LlmTurn> {
      const { system, messages: anthropicMessages } = toAnthropicMessages(messages);

      const response = await fetchWithRetry(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': apiVersion,
        },
        body: JSON.stringify({
          model: options?.model ?? config.model,
          max_tokens: config.maxTokens ?? 1024,
          system,
          messages: anthropicMessages,
          tools: tools.length > 0 ? toAnthropicTools(tools) : undefined,
          tool_choice: options?.forceTool ? { type: 'tool', name: options.forceTool } : undefined,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${body}`);
      }

      const payload = (await response.json()) as { content: AnthropicContentBlock[] };
      return fromAnthropicResponse(payload.content);
    },
  };
}
