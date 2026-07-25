/**
 * @file orchestrator/src/io/llm/generateChatTitle.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — forced-schema LLM call, same shape as
 * plugins/lists/src/classifySection.ts / plugins/document-ingestion/src/classifyNote.ts
 * @description
 * Names a chat from its opening exchange. Called once, right after a still-untitled session's
 * first reply (server/httpServer.ts) — bigBrain doesn't retitle later, so this is the only shot a
 * chat gets at a real name instead of "New chat".
 *
 * @api-declaration
 * generateChatTitle(llm, userMessage, assistantReply) — throws if the model doesn't call
 *   set_title despite forceTool, or returns an empty title; caller falls back rather than let a
 *   naming failure break the turn.
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider, ToolDefinition } from './types.js';

const setTitleTool: ToolDefinition = {
  name: 'set_title',
  description: 'Set a short title summarizing what this conversation is about.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'A concise title, 3-6 words, no quotes and no trailing punctuation.',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

export async function generateChatTitle(llm: LlmProvider, userMessage: string, assistantReply: string): Promise<string> {
  const turn = await llm.complete(
    [
      {
        role: 'system',
        content:
          'Summarize this exchange as a short chat title: 3-6 words, no quotes, no trailing ' +
          'punctuation, a plain description of the topic. Always answer by calling set_title.',
      },
      { role: 'user', content: `User: ${userMessage}\n\nAssistant: ${assistantReply}` },
    ],
    [setTitleTool],
    { forceTool: 'set_title' },
  );

  const call = turn.toolCalls.find((c) => c.name === 'set_title');
  if (!call) {
    throw new Error('generateChatTitle: model did not call set_title despite forceTool');
  }
  const args = call.arguments as Record<string, unknown> | null;
  const title = args && typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) {
    throw new Error(`generateChatTitle: model's set_title call had an unexpected shape: ${JSON.stringify(call.arguments)}`);
  }
  return title;
}
