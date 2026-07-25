/**
 * @file orchestrator/src/io/llm/openaiCompatible.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — LlmProvider adapter for any OpenAI-shaped chat completions
 * API (OpenRouter, DeepSeek's native endpoint, and most other current providers converge on
 * this shape)
 * @description
 * One adapter instead of one per vendor, since the request/response shape itself — not the
 * vendor — is what needs translating. baseUrl is required config, not defaulted, so switching
 * between OpenRouter and a provider's native endpoint (e.g. DeepSeek directly) is a config
 * change, per bb_principles.md §6. Unlike Anthropic, tool call arguments arrive as a JSON
 * *string*, not a raw object — that parsing lives entirely in this file so nothing downstream
 * needs to know which shape the underlying wire format used.
 *
 * @api-declaration
 * createOpenAiCompatibleLlmProvider(config: OpenAiCompatibleConfig) — apiKey, model, and baseUrl
 *   are all required and read from env by io/llm/index.ts, never hardcoded here
 * listOpenAiCompatibleModels(config) — the live catalog behind server/httpServer.ts's
 *   GET /v1/models, when the active profile is this kind
 *
 * @contract
 *   assertions:
 *     purity:          impure (network call)
 *     state_ownership: []
 *     external_io:     [an OpenAI-compatible chat completions API]
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

export interface OpenAiCompatibleConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens?: number;
}

interface OaiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OaiMessage {
  role: string;
  content: string | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}

function toOaiMessages(messages: LlmMessage[]): OaiMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function toOaiTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function fromOaiResponse(message: { content: string | null; tool_calls?: OaiToolCall[] }): LlmTurn {
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments),
  }));

  return { message: { role: 'assistant', content: message.content ?? '' }, toolCalls };
}

/** GET {baseUrl}/models — the live catalog behind the "dynamic model picker": whatever a
 *  client's own model dropdown shows (Open WebUI included) comes from this, not a value baked
 *  into config. Standard on OpenAI-compatible APIs; OpenRouter's listing in particular needs no
 *  auth, but the key is sent anyway since some other providers do require it for this route.
 *
 *  `pricing` is OpenRouter's own extension to this otherwise-standard shape (confirmed live:
 *  DeepSeek's /models entries carry only {id, object, owned_by}, no pricing field at all) — read
 *  straight through when present, left undefined otherwise. Not validated beyond "is it an
 *  object with string prompt/completion" since it's display-only, never computed on. */
export async function listOpenAiCompatibleModels(
  config: Pick<OpenAiCompatibleConfig, 'baseUrl' | 'apiKey'>,
): Promise<{ id: string; pricing?: { prompt: string; completion: string } }[]> {
  const response = await fetchWithRetry(`${config.baseUrl}/models`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI-compatible API error ${response.status} listing models: ${body}`);
  }
  const payload = (await response.json()) as {
    data: { id: string; pricing?: { prompt?: unknown; completion?: unknown } }[];
  };
  return payload.data.map((m) => {
    const pricing =
      typeof m.pricing?.prompt === 'string' && typeof m.pricing?.completion === 'string'
        ? { prompt: m.pricing.prompt, completion: m.pricing.completion }
        : undefined;
    return pricing ? { id: m.id, pricing } : { id: m.id };
  });
}

export function createOpenAiCompatibleLlmProvider(config: OpenAiCompatibleConfig): LlmProvider {
  return {
    name: 'openai-compatible',
    async complete(
      messages: LlmMessage[],
      tools: ToolDefinition[],
      options?: LlmCompleteOptions,
    ): Promise<LlmTurn> {
      const response = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: options?.model ?? config.model,
          max_tokens: options?.maxTokens ?? config.maxTokens ?? 1024,
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
          messages: toOaiMessages(messages),
          tools: tools.length > 0 ? toOaiTools(tools) : undefined,
          tool_choice: options?.forceTool
            ? { type: 'function', function: { name: options.forceTool } }
            : undefined,
          // DeepSeek-specific, harmless elsewhere: reasoning models reject a forced tool_choice
          // while "thinking" — ST's own DeepSeek integration (st-source/src/endpoints/backends/
          // chat-completions.js) hits the same conflict and disables thinking the same way.
          ...(options?.forceTool ? { thinking: { type: 'disabled' } } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI-compatible API error ${response.status}: ${body}`);
      }

      const payload = (await response.json()) as {
        choices: { message: { content: string | null; tool_calls?: OaiToolCall[] } }[];
      };
      const choice = payload.choices[0];
      if (!choice) throw new Error('OpenAI-compatible API returned no choices');
      return fromOaiResponse(choice.message);
    },
    listModels: () => listOpenAiCompatibleModels(config),
  };
}
