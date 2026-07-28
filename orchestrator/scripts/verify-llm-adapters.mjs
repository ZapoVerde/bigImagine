// Proves the tool-call history-replay fix for both real LlmProvider adapters: after a tool
// round, the *second* request sent to the provider must contain a well-formed assistant
// tool_use/tool_calls entry for the tool result to point back at — not an empty assistant turn,
// which a real API rejects with a 400. The stub provider used elsewhere doesn't care about
// message shape, so it never would have caught this. No live network access is available in
// this sandbox, so global fetch is mocked to capture outgoing requests and return canned valid
// responses; loop.ts and the adapters themselves run for real, unmodified.

import { createAnthropicLlmProvider } from '../dist/io/llm/anthropic.js';
import { createOpenAiCompatibleLlmProvider } from '../dist/io/llm/openaiCompatible.js';
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
    return { ok: true, json: async () => response, text: async () => JSON.stringify(response) };
  };
  try {
    await fn(capturedRequests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

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

  await runTurn({ userId: 'u1', taskId: 'task-no-sampling', messages: [{ role: 'user', content: 'hi' }], llm, db, tools });

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

  await runTurn({ userId: 'u1', taskId: 'task-no-sampling', messages: [{ role: 'user', content: 'hi' }], llm, db, tools });

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

await withMockedFetch([{ content: [{ type: 'text', text: 'ok' }] }], async () => {
  const llm = createAnthropicLlmProvider({ apiKey: 'test-key', model: 'test-model' });
  const turn = await llm.complete([{ role: 'user', content: 'hi' }], []);
  assert(turn.usage === undefined, 'Anthropic: usage is undefined, not fabricated, when the response omits it');
});

if (process.exitCode) {
  console.error('\nLLM adapter verification FAILED');
  process.exit(1);
}
console.log('\nLLM adapter verification passed');
