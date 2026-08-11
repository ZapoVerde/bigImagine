/**
 * @file orchestrator/src/io/llm/openaiCompatible.ts
 * @stamp 2026-08-10
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
 * The response's own `usage.prompt_tokens`/`completion_tokens`/`total_tokens` are relayed onto
 * LlmTurn.usage unchanged — bb_principles.md §14's gate is what actually does anything with them,
 * this file just reports what the upstream API reported. DeepSeek's extra
 * `prompt_cache_hit_tokens` is relayed as LlmUsage.cacheReadTokens the same way (see the
 * parsing below); prompt_tokens already includes the cached portion, so promptTokens needs no
 * adjustment for it.
 *
 * A user message carrying LlmMessage.images gets `content` reshaped from a plain string into the
 * documented OpenAI vision block array (`text` + one `image_url` per image, base64 data URI) —
 * the shape OpenRouter and vision-capable DeepSeek-compatible models converge on, same "one shape
 * not one adapter per vendor" precedent as the rest of this file. Every message without images
 * keeps emitting a plain string, so a non-vision endpoint that might reject an array `content`
 * field is never handed one. config.supportsVision is set from the resolved LlmProfile
 * (io/llm/profiles.ts) by index.ts's createLlmProviderForProfile, never inferred here;
 * server/httpServer.ts is what actually gates a turn on it before any message reaches this file.
 *
 * @api-declaration
 * createOpenAiCompatibleLlmProvider(config: OpenAiCompatibleConfig) — apiKey, model, and baseUrl
 *   are all required and read from env by io/llm/index.ts, never hardcoded here
 * listOpenAiCompatibleModels(config) — the live catalog behind server/httpServer.ts's
 *   GET /v1/models, when the active profile is this kind
 * listOpenAiCompatibleModelProviders(config, modelId) — the live list of upstream inference
 *   providers OpenRouter can route a given model to (GET {baseUrl}/models/{id}/endpoints), behind
 *   server/httpServer.ts's GET /v1/admin/connections/:id/providers. Unlike /models, this route is
 *   an OpenRouter-only extension, not a standard OpenAI-compatible one — calling it against a
 *   native endpoint (DeepSeek, etc.) will simply 404 and surface as a normal fetch error to the caller.
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
  LlmUsage,
  ToolCall,
  ToolDefinition,
} from './types.js';

export interface OpenAiCompatibleConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens?: number;
  supportsVision?: boolean;
  /** OpenRouter's own per-request `provider` object — set from the resolved LlmProfile's own
   *  `provider` field (io/llm/profiles.ts) by io/llm/index.ts's createLlmProviderForProfile.
   *  Undefined means "send no provider override", the pre-existing behavior; a non-OpenRouter
   *  openai-compatible endpoint that doesn't recognize this field simply ignores it. */
  provider?: {
    order?: string[];
    allowFallbacks: boolean;
    quantizations?: string[];
  };
}

interface OaiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OaiContentBlock {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

interface OaiMessage {
  role: string;
  content: string | OaiContentBlock[] | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}

function toOaiMessages(messages: LlmMessage[]): OaiMessage[] {
  // The stack can carry the whole active context (recent_history in the narrator stack, with the
  // live-window turns moved out of the messages array) — but OpenAI-compatible endpoints reject an
  // empty messages array outright, so emit a single empty user turn as a shape-level placeholder.
  // No instruction text: the actual context sits in the system block; this is only to keep the
  // request valid. (2026-08-10 user direction: "send it as it is".)
  if (messages.length === 0) return [{ role: 'user', content: '' }];
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
    if (m.role === 'user' && m.images && m.images.length > 0) {
      // Content becomes a block array only when images are present — every other message keeps
      // emitting a plain string exactly as before, so a non-vision-capable OpenAI-compatible
      // endpoint (which may reject an array-shaped content field outright) never sees this shape.
      const blocks: OaiContentBlock[] = [{ type: 'text', text: m.content }];
      for (const img of m.images) {
        blocks.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
      }
      return { role: m.role, content: blocks };
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

function fromOaiResponse(
  message: { content: string | null; tool_calls?: OaiToolCall[] },
  finishReason?: string,
  usage?: LlmUsage,
): LlmTurn {
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => {
    try {
      return { id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments) };
    } catch (err) {
      // The most common real cause here is truncation: a tool call whose arguments carry a large
      // payload (e.g. save_document's contentMarkdown) gets cut off mid-string once the response
      // hits max_tokens, leaving unparseable JSON. finish_reason === 'length' confirms that's what
      // happened instead of leaving callers to debug a bare SyntaxError.
      const reason = err instanceof Error ? err.message : String(err);
      const truncationHint =
        finishReason === 'length'
          ? ' — the response hit its max_tokens limit before the call finished; increase maxTokens or shorten the input'
          : '';
      throw new Error(`OpenAI-compatible API returned malformed arguments for tool call "${tc.function.name}"${truncationHint}: ${reason}`);
    }
  });

  return { message: { role: 'assistant', content: message.content ?? '' }, toolCalls, usage };
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

/** GET {baseUrl}/models/{modelId}/endpoints — OpenRouter's per-model routing table: every
 *  upstream inference provider currently serving `modelId`, in the shape the Settings tab needs
 *  to let an admin pin a provider (+ a fallback) instead of accepting whichever one OpenRouter's
 *  own default routing would pick across the full set. `name` is the provider's own display name
 *  (e.g. "OpenAI", "Fireworks") — the value OpenRouter's request-level `provider.order` expects;
 *  `tag` is its more specific routing slug (occasionally a region-qualified variant of the same
 *  provider, e.g. "azure/swedencentral"), kept alongside since `name` alone can collide. No auth
 *  required by OpenRouter for this route either, same as listOpenAiCompatibleModels, but the key
 *  is sent anyway for the same reason. */
export async function listOpenAiCompatibleModelProviders(
  config: Pick<OpenAiCompatibleConfig, 'baseUrl' | 'apiKey'>,
  modelId: string,
): Promise<{ name: string; tag: string; pricing?: { prompt: string; completion: string } }[]> {
  const response = await fetchWithRetry(`${config.baseUrl}/models/${modelId}/endpoints`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI-compatible API error ${response.status} listing providers for "${modelId}": ${body}`);
  }
  const payload = (await response.json()) as {
    data?: {
      endpoints?: { provider_name?: unknown; tag?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }[];
    };
  };
  const endpoints = payload.data?.endpoints ?? [];
  return endpoints
    .filter((e): e is typeof e & { provider_name: string } => typeof e.provider_name === 'string')
    .map((e) => {
      const pricing =
        typeof e.pricing?.prompt === 'string' && typeof e.pricing?.completion === 'string'
          ? { prompt: e.pricing.prompt, completion: e.pricing.completion }
          : undefined;
      const tag = typeof e.tag === 'string' ? e.tag : e.provider_name;
      return pricing ? { name: e.provider_name, tag, pricing } : { name: e.provider_name, tag };
    });
}

export function createOpenAiCompatibleLlmProvider(config: OpenAiCompatibleConfig): LlmProvider {
  return {
    name: 'openai-compatible',
    supportsVision: config.supportsVision ?? false,
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
        signal: options?.signal,
        body: JSON.stringify({
          model: options?.model ?? config.model,
          max_tokens: options?.maxTokens ?? config.maxTokens ?? 16384,
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
          ...(config.provider
            ? {
                provider: {
                  ...(config.provider.order ? { order: config.provider.order } : {}),
                  allow_fallbacks: config.provider.allowFallbacks,
                  ...(config.provider.quantizations ? { quantizations: config.provider.quantizations } : {}),
                },
              }
            : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI-compatible API error ${response.status}: ${body}`);
      }

      const payload = (await response.json()) as {
        choices: { message: { content: string | null; tool_calls?: OaiToolCall[] }; finish_reason?: string }[];
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          // DeepSeek's OpenAI-compatible endpoint reports which prompt tokens came from its
          // prompt cache; other OpenAI-compatible providers (most OpenRouter-routed models)
          // omit it entirely. Optional here so the two are distinguishable — see below.
          prompt_cache_hit_tokens?: number;
        };
      };
      const choice = payload.choices[0];
      if (!choice) throw new Error('OpenAI-compatible API returned no choices');
      const usage = payload.usage
        ? {
            promptTokens: payload.usage.prompt_tokens,
            completionTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens,
            // DeepSeek's prompt_tokens already includes the cached portion (verified against its
            // API reference), so promptTokens is unchanged — this is purely the hit/miss split for
            // the Prompt Inspector's receipt. Undefined (a provider that doesn't report it) stays
            // undefined, never zero: "no cache accounting", not "zero cache hit".
            ...(payload.usage.prompt_cache_hit_tokens !== undefined
              ? { cacheReadTokens: payload.usage.prompt_cache_hit_tokens }
              : {}),
          }
        : undefined;
      return fromOaiResponse(choice.message, choice.finish_reason, usage);
    },
    listModels: () => listOpenAiCompatibleModels(config),
    listProviders: (modelId: string) => listOpenAiCompatibleModelProviders(config, modelId),
  };
}
