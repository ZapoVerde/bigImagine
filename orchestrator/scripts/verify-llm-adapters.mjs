// Proves the tool-call history-replay fix for both real LlmProvider adapters: after a tool
// round, the *second* request sent to the provider must contain a well-formed assistant
// tool_use/tool_calls entry for the tool result to point back at — not an empty assistant turn,
// which a real API rejects with a 400. The stub provider used elsewhere doesn't care about
// message shape, so it never would have caught this. No live network access is available in
// this sandbox, so global fetch is mocked to capture outgoing requests and return canned valid
// responses; loop.ts and the adapters themselves run for real, unmodified.

import { createAnthropicLlmProvider } from '../dist/io/llm/anthropic.js';
import { createOpenAiCompatibleLlmProvider } from '../dist/io/llm/openaiCompatible.js';
import { createLlmProviderForProfile } from '../dist/io/llm/index.js';
import { createPostgresClient } from '../dist/io/postgres.js';
import { createToolRegistry } from '../dist/orchestrator/toolRegistry.js';
import { runTurn } from '../dist/orchestrator/loop.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function createFakePool() {
  return {
    async connect() {
      return {
        async query(sql) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

const echoTool = {
  definition: {
    name: 'echo_tool',
    description: 'echoes input',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
  },
  handler: async (args) => ({ echoed: args.text }),
};

async function withMockedFetch(responses, fn) {
  const originalFetch = globalThis.fetch;
  const capturedRequests = [];
  let callIndex = 0;
  globalThis.fetch = async (_url, init) => {
    capturedRequests.push({ body: JSON.parse(init.body) });
    const response = responses[callIndex++];
    if (!response) throw new Error('mock fetch called more times than scripted responses provided');
    // A real Response (streaming path) is passed through untouched so completeStream reads
    // response.body as a live ReadableStream; a plain object (non-streaming path) is wrapped the
    // way the existing fixtures expect. An { ok: false } object scripts an HTTP-level failure the
    // way a real upstream would surface it (fetchWithRetry only retries thrown, not non-ok, so
    // the adapter's own error handling owns the case).
    if (response instanceof Response) return response;
    if (response && response.ok === false) {
      return {
        ok: false,
        status: response.status ?? 500,
        json: async () => ({}),
        text: async () => response.errorBody ?? `mock error ${response.status}`,
      };
    }
    return { ok: true, json: async () => response, text: async () => JSON.stringify(response) };
  };
  try {
    await fn(capturedRequests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/** Build a mock SSE Response from raw SSE text — the byte-level framing the adapters'
 *  completeStream parses for real, so the fixtures exercise the same parsing path a live
 *  vendor stream would. */
function sseResponse(events) {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// RunTurnOptions now requires an embeddings provider (loop.ts threads it into every tool ctx).
const stubEmbeddings = { name: 'stub', dimension: 4, async embed(texts) { return texts.map(() => [0.1, 0.2, 0.3, 0.4]); } };

// --- Anthropic adapter ---
await withMockedFetch(
  [
    { content: [{ type: 'tool_use', id: 'call_1', name: 'echo_tool', input: { text: 'hi' } }] },
    { content: [{ type: 'text', text: 'final reply' }] },
  ],
  async (requests) => {
    const llm = createAnthropicLlmProvider({ apiKey: 'test-key', model: 'test-model' });
    const db = createPostgresClient(createFakePool());
    const tools = createToolRegistry([echoTool]);

    const result = await runTurn({
      userId: 'u1',
      taskId: 'task-anthropic-tool-round-trip',
      messages: [{ role: 'user', content: 'say hi' }],
      llm,
      db,
    tools,
    embeddings: stubEmbeddings,
  });

    assert(result.content === 'final reply', 'Anthropic: runTurn returns the final reply after a real tool round-trip');
    assert(requests.length === 2, 'Anthropic: exactly two API calls were made (one per round)');

    const secondRequestMessages = requests[1].body.messages;
    const assistantMsg = secondRequestMessages.find(
      (m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'),
    );
    assert(!!assistantMsg, 'Anthropic: the second request replays the assistant tool_use block');
    const toolUseBlock = assistantMsg?.content.find((b) => b.type === 'tool_use');
    assert(
      toolUseBlock?.id === 'call_1' && toolUseBlock?.name === 'echo_tool',
      'Anthropic: tool_use id/name match the original call',
    );

    const toolResultMsg = secondRequestMessages.find(
      (m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'),
    );
    const toolResultBlock = toolResultMsg?.content.find((b) => b.type === 'tool_result');
    assert(
      toolResultBlock?.tool_use_id === 'call_1',
      'Anthropic: tool_result correctly points back at the tool_use id',
    );
  },
);

// --- OpenAI-compatible adapter (OpenRouter / DeepSeek / etc.) ---
await withMockedFetch(
  [
    {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'echo_tool', arguments: '{"text":"hi"}' } },
            ],
          },
        },
      ],
    },
    { choices: [{ message: { content: 'final reply' } }] },
  ],
  async (requests) => {
    const llm = createOpenAiCompatibleLlmProvider({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://example.invalid/v1',
    });
    const db = createPostgresClient(createFakePool());
    const tools = createToolRegistry([echoTool]);

    const result = await runTurn({
      userId: 'u1',
      taskId: 'task-openai-tool-round-trip',
      messages: [{ role: 'user', content: 'say hi' }],
      llm,
      db,
    tools,
    embeddings: stubEmbeddings,
  });

    assert(result.content === 'final reply', 'OpenAI-compatible: runTurn returns the final reply after a real tool round-trip');
    assert(requests.length === 2, 'OpenAI-compatible: exactly two API calls were made (one per round)');

    const secondRequestMessages = requests[1].body.messages;
    const assistantMsg = secondRequestMessages.find((m) => m.role === 'assistant' && m.tool_calls);
    assert(!!assistantMsg, 'OpenAI-compatible: the second request replays the assistant tool_calls entry');
    assert(
      assistantMsg?.tool_calls?.[0]?.id === 'call_1' && assistantMsg?.tool_calls?.[0]?.function?.name === 'echo_tool',
      'OpenAI-compatible: tool_calls id/name match the original call',
    );

    const toolResultMsg = secondRequestMessages.find((m) => m.role === 'tool');
    assert(
      toolResultMsg?.tool_call_id === 'call_1',
      'OpenAI-compatible: tool result message correctly points back at the tool_call id',
    );
  },
);

// --- Sampling params (temperature/topP/maxTokens) — a chat session's own params, io/chatSessions.ts ---
await withMockedFetch([{ content: [{ type: 'text', text: 'ok' }] }], async (requests) => {
  const llm = createAnthropicLlmProvider({ apiKey: 'test-key', model: 'test-model' });
  const db = createPostgresClient(createFakePool());
  const tools = createToolRegistry([]);

  await runTurn({
    userId: 'u1',
    taskId: 'task-anthropic-sampling',
    messages: [{ role: 'user', content: 'hi' }],
    sampling: { temperature: 0.2, topP: 0.9, maxTokens: 256 },
    llm,
    db,
    tools,
    embeddings: stubEmbeddings,
  });

  const body = requests[0].body;
  assert(body.temperature === 0.2, 'Anthropic: temperature is forwarded when set');
  assert(body.top_p === 0.9, 'Anthropic: top_p is forwarded when set');
  assert(body.max_tokens === 256, 'Anthropic: max_tokens override wins over the provider default');
});

await withMockedFetch([{ content: [{ type: 'text', text: 'ok' }] }], async (requests) => {
  const llm = createAnthropicLlmProvider({ apiKey: 'test-key', model: 'test-model' });
  const db = createPostgresClient(createFakePool());
  const tools = createToolRegistry([]);

  await runTurn({ userId: 'u1', taskId: 'task-no-sampling', messages: [{ role: 'user', content: 'hi' }], llm, db, tools, embeddings: stubEmbeddings })

  const body = requests[0].body;
  assert(!('temperature' in body), 'Anthropic: temperature is omitted, not sent as null/undefined, when unset');
  assert(!('top_p' in body), 'Anthropic: top_p is omitted when unset');
  assert(body.max_tokens === 16384, 'Anthropic: max_tokens falls back to the 16384 default when unset');
});

await withMockedFetch([{ choices: [{ message: { content: 'ok' } }] }], async (requests) => {
  const llm = createOpenAiCompatibleLlmProvider({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://example.invalid/v1',
  });
  const db = createPostgresClient(createFakePool());
  const tools = createToolRegistry([]);

  await runTurn({
    userId: 'u1',
    taskId: 'task-openai-sampling',
    messages: [{ role: 'user', content: 'hi' }],
    sampling: { temperature: 0.5, topP: 0.8, maxTokens: 128 },
    llm,
    db,
    tools,
    embeddings: stubEmbeddings,
  });

  const body = requests[0].body;
  assert(body.temperature === 0.5, 'OpenAI-compatible: temperature is forwarded when set');
  assert(body.top_p === 0.8, 'OpenAI-compatible: top_p is forwarded when set');
  assert(body.max_tokens === 128, 'OpenAI-compatible: max_tokens override wins over the provider default');
});

await withMockedFetch([{ choices: [{ message: { content: 'ok' } }] }], async (requests) => {
  const llm = createOpenAiCompatibleLlmProvider({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://example.invalid/v1',
  });
  const db = createPostgresClient(createFakePool());
  const tools = createToolRegistry([]);

  await runTurn({ userId: 'u1', taskId: 'task-no-sampling', messages: [{ role: 'user', content: 'hi' }], llm, db, tools, embeddings: stubEmbeddings })

  const body = requests[0].body;
  assert(!('temperature' in body), 'OpenAI-compatible: temperature is omitted when unset');
  assert(!('top_p' in body), 'OpenAI-compatible: top_p is omitted when unset');
  assert(body.max_tokens === 16384, 'OpenAI-compatible: max_tokens falls back to the 16384 default when unset');
});

// --- Images/vision (Stage 5) ---
assert(
  createAnthropicLlmProvider({ apiKey: 'k', model: 'm' }).supportsVision === false,
  'Anthropic: supportsVision defaults to false when config omits it',
);
assert(
  createOpenAiCompatibleLlmProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://example.invalid/v1' }).supportsVision === false,
  'OpenAI-compatible: supportsVision defaults to false when config omits it',
);

await withMockedFetch([{ content: [{ type: 'text', text: 'I see a cat' }] }], async (requests) => {
  const llm = createAnthropicLlmProvider({ apiKey: 'test-key', model: 'test-model', supportsVision: true });
  assert(llm.supportsVision === true, 'Anthropic: supportsVision is set from config');

  await llm.complete(
    [{ role: 'user', content: 'what is this?', images: [{ mimeType: 'image/png', base64: 'AAAA' }] }],
    [],
  );

  const userMsg = requests[0].body.messages.find((m) => m.role === 'user');
  const imageBlock = userMsg.content.find((b) => b.type === 'image');
  const textBlock = userMsg.content.find((b) => b.type === 'text');
  assert(!!imageBlock, 'Anthropic: a user message with images produces an image content block');
  assert(
    imageBlock?.source?.type === 'base64' && imageBlock?.source?.media_type === 'image/png' && imageBlock?.source?.data === 'AAAA',
    'Anthropic: the image block carries the correct base64/media_type',
  );
  assert(textBlock?.text === 'what is this?', 'Anthropic: the text block is still present alongside the image');
  assert(
    userMsg.content.indexOf(imageBlock) < userMsg.content.indexOf(textBlock),
    'Anthropic: the image block precedes the text block',
  );
});

await withMockedFetch([{ content: [{ type: 'text', text: 'ok' }] }], async (requests) => {
  const llm = createAnthropicLlmProvider({ apiKey: 'test-key', model: 'test-model' });
  await llm.complete([{ role: 'user', content: 'hi' }], []);
  const userMsg = requests[0].body.messages.find((m) => m.role === 'user');
  assert(
    userMsg.content.length === 1 && userMsg.content[0].type === 'text',
    'Anthropic: no image block is added when a message carries no images',
  );
});

await withMockedFetch([{ choices: [{ message: { content: 'ok' } }] }], async (requests) => {
  const llm = createOpenAiCompatibleLlmProvider({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://example.invalid/v1',
    supportsVision: true,
  });
  assert(llm.supportsVision === true, 'OpenAI-compatible: supportsVision is set from config');

  await llm.complete(
    [{ role: 'user', content: 'what is this?', images: [{ mimeType: 'image/jpeg', base64: 'BBBB' }] }],
    [],
  );

  const userMsg = requests[0].body.messages.find((m) => m.role === 'user');
  assert(Array.isArray(userMsg.content), 'OpenAI-compatible: a user message with images has array-shaped content');
  const textBlock = userMsg.content.find((b) => b.type === 'text');
  const imageBlock = userMsg.content.find((b) => b.type === 'image_url');
  assert(textBlock?.text === 'what is this?', 'OpenAI-compatible: the text block is present');
  assert(
    imageBlock?.image_url?.url === 'data:image/jpeg;base64,BBBB',
    'OpenAI-compatible: the image block is a data URI with the correct mime/base64',
  );
});

await withMockedFetch([{ choices: [{ message: { content: 'ok' } }] }], async (requests) => {
  const llm = createOpenAiCompatibleLlmProvider({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://example.invalid/v1',
  });
  await llm.complete([{ role: 'user', content: 'hi' }], []);
  const userMsg = requests[0].body.messages.find((m) => m.role === 'user');
  assert(
    typeof userMsg.content === 'string',
    'OpenAI-compatible: content stays a plain string when a message carries no images',
  );
});

// --- Usage/token accounting (bb_principles.md §14's gate consumes this) ---
await withMockedFetch(
  [{ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 12, output_tokens: 34 } }],
  async () => {
    const llm = createAnthropicLlmProvider({ apiKey: 'test-key', model: 'test-model' });
    const turn = await llm.complete([{ role: 'user', content: 'hi' }], []);
    assert(
      turn.usage?.promptTokens === 12 && turn.usage?.completionTokens === 34 && turn.usage?.totalTokens === 46,
      'Anthropic: usage.input_tokens/output_tokens relay onto LlmTurn.usage, summed for totalTokens',
    );
  },
);

await withMockedFetch(
  [{ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }],
  async () => {
    const llm = createOpenAiCompatibleLlmProvider({ apiKey: 'test-key', model: 'test-model', baseUrl: 'https://example.invalid/v1' });
    const turn = await llm.complete([{ role: 'user', content: 'hi' }], []);
    assert(
      turn.usage?.promptTokens === 5 && turn.usage?.completionTokens === 7 && turn.usage?.totalTokens === 12,
      'OpenAI-compatible: usage.prompt_tokens/completion_tokens/total_tokens relay onto LlmTurn.usage unchanged',
    );
  },
);

// Prompt-cache accounting (docs/plans/completed/prompt-inspector-usage-cost.md): DeepSeek's responses carry
// prompt_cache_hit_tokens; prompt_tokens already includes the cached portion, so promptTokens is
// unchanged and the hit count lands on cacheReadTokens.
await withMockedFetch(
  [
    {
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16, prompt_cache_hit_tokens: 4 },
    },
  ],
  async () => {
    const llm = createOpenAiCompatibleLlmProvider({ apiKey: 'test-key', model: 'test-model', baseUrl: 'https://example.invalid/v1' });
    const turn = await llm.complete([{ role: 'user', content: 'hi' }], []);
    assert(
      turn.usage?.promptTokens === 9 &&
        turn.usage?.cacheReadTokens === 4 &&
        turn.usage?.completionTokens === 7 &&
        turn.usage?.totalTokens === 16,
      'OpenAI-compatible: prompt_cache_hit_tokens relays onto cacheReadTokens, promptTokens unchanged (already includes it)',
    );
  },
);

// A provider that reports no cache accounting at all (most OpenRouter-routed models): cacheReadTokens
// stays undefined, never zero — "no cache accounting", not "zero cache hit".
await withMockedFetch(
  [{ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }],
  async () => {
    const llm = createOpenAiCompatibleLlmProvider({ apiKey: 'test-key', model: 'test-model', baseUrl: 'https://example.invalid/v1' });
    const turn = await llm.complete([{ role: 'user', content: 'hi' }], []);
    assert(
      turn.usage?.promptTokens === 5 && turn.usage?.cacheReadTokens === undefined,
      'OpenAI-compatible: cacheReadTokens is undefined (not 0) when the response has no cache fields',
    );
  },
);

await withMockedFetch([{ content: [{ type: 'text', text: 'ok' }] }], async () => {
  const llm = createAnthropicLlmProvider({ apiKey: 'test-key', model: 'test-model' });
  const turn = await llm.complete([{ role: 'user', content: 'hi' }], []);
  assert(turn.usage === undefined, 'Anthropic: usage is undefined, not fabricated, when the response omits it');
});

// --- Empty messages array (recent_history carries the whole context in the system block) ---
// When the live-window turns live INSIDE the narrator stack, messagesForLlm is empty; the
// adapters must still emit a request the provider accepts — a single empty user turn, no
// instruction text ("send it as it is", 2026-08-10).
await withMockedFetch([{ choices: [{ message: { content: 'ok' } }] }], async (requests) => {
  const llm = createOpenAiCompatibleLlmProvider({ apiKey: 'test-key', model: 'test-model', baseUrl: 'https://example.invalid/v1' });
  const turn = await llm.complete([], []);
  assert(turn.message.content === 'ok', 'OpenAI-compatible: a turn with zero messages still completes');
  const sent = requests[0].body.messages;
  assert(
    sent.length === 1 && sent[0].role === 'user' && sent[0].content === '',
    'OpenAI-compatible: an empty messages array emits one empty user turn (shape-level placeholder only)',
  );
});

await withMockedFetch([{ content: [{ type: 'text', text: 'ok' }] }], async (requests) => {
  const llm = createAnthropicLlmProvider({ apiKey: 'test-key', model: 'test-model' });
  const turn = await llm.complete([], []);
  assert(turn.message.content === 'ok', 'Anthropic: a turn with zero messages still completes');
  const sent = requests[0].body.messages;
  assert(
    sent.length === 1 &&
      sent[0].role === 'user' &&
      sent[0].content.length === 1 &&
      sent[0].content[0].type === 'text' &&
      sent[0].content[0].text === '',
    'Anthropic: an empty messages array emits one empty user turn (shape-level placeholder only)',
  );
});

// --- Streaming (completeStream, docs/plans/completed/rp-streaming-plan.md) ---
// Anthropic: text_delta events drive onDelta in order; usage is merged from message_start's
// input_tokens and the terminal message_delta's output_tokens.
await withMockedFetch(
  [
    sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'streaming ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } },
      { type: 'message_delta', usage: { output_tokens: 34 } },
      { type: 'message_stop' },
    ]),
  ],
  async (requests) => {
    const llm = createAnthropicLlmProvider({ apiKey: 'test-key', model: 'test-model' });
    const deltas = [];
    const turn = await llm.completeStream([{ role: 'user', content: 'hi' }], [], (d) => deltas.push(d));
    assert(
      deltas.join('') === 'Hello streaming world' && turn.message.content === 'Hello streaming world',
      'Anthropic completeStream: text_delta events reach onDelta in order and concatenate to the full reply',
    );
    assert(
      turn.usage?.promptTokens === 12 && turn.usage?.completionTokens === 34 && turn.usage?.totalTokens === 46,
      'Anthropic completeStream: usage merged from message_start (input) + message_delta (output)',
    );
    assert(requests[0].body.stream === true, 'Anthropic completeStream: request carries stream: true');
  },
);

// OpenAI-compatible: delta.content drives onDelta in order; usage comes off the terminal chunk
// (stream_options.include_usage) whose choices array is empty; [DONE] terminates cleanly.
await withMockedFetch(
  [
    sseResponse([
      { id: 'x', choices: [{ delta: { content: 'Hello ' } }] },
      { id: 'x', choices: [{ delta: { content: 'streaming ' } }] },
      { id: 'x', choices: [{ delta: { content: 'world' } }] },
      { id: 'x', choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } },
      { id: 'x', choices: [{ delta: {} }] },
    ]),
  ],
  async (requests) => {
    const llm = createOpenAiCompatibleLlmProvider({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://example.invalid/v1',
    });
    const deltas = [];
    const turn = await llm.completeStream([{ role: 'user', content: 'hi' }], [], (d) => deltas.push(d));
    assert(
      deltas.join('') === 'Hello streaming world' && turn.message.content === 'Hello streaming world',
      'OpenAI-compatible completeStream: delta.content reaches onDelta in order and concatenates to the full reply',
    );
    assert(
      turn.usage?.promptTokens === 5 && turn.usage?.completionTokens === 7 && turn.usage?.totalTokens === 12,
      'OpenAI-compatible completeStream: usage parsed off the terminal include_usage chunk',
    );
    assert(requests[0].body.stream === true, 'OpenAI-compatible completeStream: request carries stream: true');
    assert(
      requests[0].body.stream_options?.include_usage === true,
      'OpenAI-compatible completeStream: request carries stream_options.include_usage',
    );
  },
);

// DeepSeek-style cache accounting on the streaming path: prompt_cache_hit_tokens relays onto
// cacheReadTokens exactly as the non-streaming path does.
await withMockedFetch(
  [
    sseResponse([
      { id: 'x', choices: [{ delta: { content: 'ok' } }] },
      {
        id: 'x',
        choices: [],
        usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16, prompt_cache_hit_tokens: 4 },
      },
    ]),
  ],
  async () => {
    const llm = createOpenAiCompatibleLlmProvider({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://example.invalid/v1',
    });
    const turn = await llm.completeStream([{ role: 'user', content: 'hi' }], [], () => {});
    assert(
      turn.usage?.cacheReadTokens === 4 && turn.usage?.promptTokens === 9,
      'OpenAI-compatible completeStream: prompt_cache_hit_tokens relays onto cacheReadTokens',
    );
  },
);

// A non-empty tools array throws on both adapters — the capability is RP-only by contract.
await withMockedFetch([sseResponse([{ type: 'message_stop' }])], async () => {
  const llm = createAnthropicLlmProvider({ apiKey: 'test-key', model: 'test-model' });
  let threw = false;
  try {
    await llm.completeStream([{ role: 'user', content: 'hi' }], [{ name: 'x', description: 'y', parameters: {} }], () => {});
  } catch {
    threw = true;
  }
  assert(threw, 'Anthropic completeStream: a non-empty tools array throws, never silently misbehaves');
});

await withMockedFetch([sseResponse([{ id: 'x', choices: [{ delta: {} }] }])], async () => {
  const llm = createOpenAiCompatibleLlmProvider({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://example.invalid/v1',
  });
  let threw = false;
  try {
    await llm.completeStream([{ role: 'user', content: 'hi' }], [{ name: 'x', description: 'y', parameters: {} }], () => {});
  } catch {
    threw = true;
  }
  assert(threw, 'OpenAI-compatible completeStream: a non-empty tools array throws, never silently misbehaves');
});

// --- App-level fallback routing (always single provider, deliberate secondary on failure) ---
// The pin sends OpenRouter exactly ONE provider with allow_fallbacks: false — OR can never route
// across its own provider set, so the provider that served is always one the admin priced. When
// the primary fails (an error, or a blank reply) and a fallback is configured AND enabled, the
// adapter deliberately re-pins the secondary once. This is what keeps pricing honest.
const fallbackConfig = {
  apiKey: 'test-key',
  model: 'test-model',
  baseUrl: 'https://example.invalid/v1',
  provider: { order: ['Primary Co', 'Backup Co'], allowFallbacks: true },
};

// Primary errors (HTTP 503) -> fallback serves.
await withMockedFetch(
  [
    { ok: false, status: 503, errorBody: 'upstream down' },
    { choices: [{ message: { content: 'from backup' } }] },
  ],
  async (requests) => {
    const llm = createOpenAiCompatibleLlmProvider(fallbackConfig);
    const turn = await llm.complete([{ role: 'user', content: 'hi' }], []);
    assert(turn.message.content === 'from backup', 'openai-compatible: a failed primary falls back to the secondary');
    assert(requests.length === 2, 'openai-compatible: exactly two requests when the primary fails');
    assert(
      JSON.stringify(requests[0].body.provider) === JSON.stringify({ order: ['Primary Co'], allow_fallbacks: false }) &&
        JSON.stringify(requests[1].body.provider) === JSON.stringify({ order: ['Backup Co'], allow_fallbacks: false }),
      'openai-compatible: each request pins exactly one provider with allow_fallbacks: false',
    );
  },
);

// Primary blank reply -> fallback serves.
await withMockedFetch(
  [
    { choices: [{ message: { content: '' } }] },
    { choices: [{ message: { content: 'from backup' } }] },
  ],
  async (requests) => {
    const llm = createOpenAiCompatibleLlmProvider(fallbackConfig);
    const turn = await llm.complete([{ role: 'user', content: 'hi' }], []);
    assert(turn.message.content === 'from backup', 'openai-compatible: a blank primary reply falls back to the secondary');
    assert(requests.length === 2, 'openai-compatible: exactly two requests when the primary is blank');
  },
);

// Healthy primary -> no fallback, single request pinned to the primary only.
await withMockedFetch([{ choices: [{ message: { content: 'from primary' } }] }], async (requests) => {
  const llm = createOpenAiCompatibleLlmProvider(fallbackConfig);
  const turn = await llm.complete([{ role: 'user', content: 'hi' }], []);
  assert(turn.message.content === 'from primary', 'openai-compatible: a healthy primary serves with no fallback');
  assert(requests.length === 1, 'openai-compatible: exactly one request when the primary serves');
});

// allowFallbacks off -> no secondary retry even on error; the error surfaces.
await withMockedFetch([{ ok: false, status: 503, errorBody: 'upstream down' }], async () => {
  const llm = createOpenAiCompatibleLlmProvider({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://example.invalid/v1',
    provider: { order: ['Primary Co', 'Backup Co'], allowFallbacks: false },
  });
  let threw = false;
  try {
    await llm.complete([{ role: 'user', content: 'hi' }], []);
  } catch {
    threw = true;
  }
  assert(threw, 'openai-compatible: allowFallbacks off means no secondary retry — the error surfaces');
});

// Streaming: a blank primary stream -> fallback; deltas come only from the secondary.
await withMockedFetch(
  [
    sseResponse([
      { id: 'x', choices: [{ delta: {} }] },
      { id: 'x', choices: [{ finish_reason: 'stop' }] },
    ]),
    sseResponse([
      { id: 'x', choices: [{ delta: { content: 'streamed from backup' } }] },
      { id: 'x', choices: [] },
    ]),
  ],
  async (requests) => {
    const llm = createOpenAiCompatibleLlmProvider(fallbackConfig);
    const deltas = [];
    const turn = await llm.completeStream([{ role: 'user', content: 'hi' }], [], (d) => deltas.push(d));
    assert(
      deltas.join('') === 'streamed from backup' && turn.message.content === 'streamed from backup',
      'openai-compatible completeStream: a blank primary stream falls back; deltas come only from the secondary',
    );
    assert(requests.length === 2, 'openai-compatible completeStream: two requests when the primary stream is blank');
    assert(
      JSON.stringify(requests[0].body.provider) === JSON.stringify({ order: ['Primary Co'], allow_fallbacks: false }) &&
        JSON.stringify(requests[1].body.provider) === JSON.stringify({ order: ['Backup Co'], allow_fallbacks: false }),
      'openai-compatible completeStream: both requests pin a single provider with allow_fallbacks: false',
    );
  },
);

// Streaming: once content is relayed, a retry could never reconcile — no fallback fires.
await withMockedFetch(
  [
    sseResponse([
      { id: 'x', choices: [{ delta: { content: 'partial' } }] },
      { id: 'x', choices: [{ delta: { content: 'more' } }] },
    ]),
  ],
  async (requests) => {
    const llm = createOpenAiCompatibleLlmProvider(fallbackConfig);
    const deltas = [];
    const turn = await llm.completeStream([{ role: 'user', content: 'hi' }], [], (d) => deltas.push(d));
    assert(
      deltas.join('') === 'partialmore' && turn.message.content === 'partialmore' && requests.length === 1,
      'openai-compatible completeStream: a producing primary never triggers the fallback',
    );
  },
);

// Provider kinds (deepseek/openrouter, db/migrations/0117) both dispatch to the openai-compatible
// adapter — the kind names the provider (and where its shared key lives), not a different wire
// shape, so createLlmProviderForProfile must route them exactly like a freeform openai-compatible
// profile. Prove the real dispatch resolves to an openai-compatible provider (its name is the
// adapter's identity; canonical baseUrl handling is covered by verify-llm-connections.mjs and
// profiles.ts).
{
  const deepseek = createLlmProviderForProfile({
    kind: 'deepseek',
    model: 'deepseek-v4-flash',
    apiKey: 'sk-shared-deepseek',
    baseUrl: 'https://api.deepseek.com',
    supportsVision: false,
  });
  assert(
    deepseek.name === 'openai-compatible' && deepseek.supportsVision === false,
    'a deepseek profile dispatches to the openai-compatible adapter',
  );

  const openrouter = createLlmProviderForProfile({
    kind: 'openrouter',
    model: 'deepseek/deepseek-chat',
    apiKey: 'sk-shared-openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    supportsVision: false,
  });
  assert(
    openrouter.name === 'openai-compatible' && openrouter.supportsVision === false,
    'an openrouter profile dispatches to the openai-compatible adapter',
  );
}

if (process.exitCode) {
  console.error('\nLLM adapter verification FAILED');
  process.exit(1);
}
console.log('\nLLM adapter verification passed');
