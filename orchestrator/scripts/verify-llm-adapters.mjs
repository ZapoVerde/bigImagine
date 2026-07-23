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

    const reply = await runTurn({
      userId: 'u1',
      messages: [{ role: 'user', content: 'say hi' }],
      llm,
      db,
      tools,
    });

    assert(reply === 'final reply', 'Anthropic: runTurn returns the final reply after a real tool round-trip');
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

    const reply = await runTurn({
      userId: 'u1',
      messages: [{ role: 'user', content: 'say hi' }],
      llm,
      db,
      tools,
    });

    assert(reply === 'final reply', 'OpenAI-compatible: runTurn returns the final reply after a real tool round-trip');
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

if (process.exitCode) {
  console.error('\nLLM adapter verification FAILED');
  process.exit(1);
}
console.log('\nLLM adapter verification passed');
