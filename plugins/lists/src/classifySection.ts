/**
 * @file plugins/lists/src/classifySection.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — forced-schema LLM call, bounded to one list's own sections
 * @description
 * Mirrors document-ingestion's classifyNote.ts pattern, but the classification vocabulary isn't
 * fixed at build time — it's whatever section_order the target list itself defines (e.g. one
 * household's actual grocery-store aisle sequence), passed in as a JSON Schema `enum` so the
 * model can only return one of *that* list's real sections, never invent a new one. A list with
 * no section_order never calls this at all — see addListItemTool.ts / shoppingListFromMealPlanTool.ts.
 *
 * @api-declaration
 * classifySection(llm, sections, itemName) — throws if the model doesn't call classify_section,
 *   or returns something outside the given `sections` enum, rather than guessing
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider, ToolDefinition } from '@bigbrain/orchestrator/llm-types';

export async function classifySection(llm: LlmProvider, sections: string[], itemName: string): Promise<string> {
  const classifySectionTool: ToolDefinition = {
    name: 'classify_section',
    description: "Classify a grocery item into the single store section it belongs to.",
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: sections,
          description: 'The best-matching section for this item, from the given list.',
        },
      },
      required: ['section'],
      additionalProperties: false,
    },
  };

  const turn = await llm.complete(
    [
      {
        role: 'system',
        content:
          'Classify the grocery item into exactly one of the given store sections, in the order you would ' +
          'actually find it while shopping. Always answer by calling classify_section.',
      },
      { role: 'user', content: itemName },
    ],
    [classifySectionTool],
    { forceTool: 'classify_section' },
  );

  const call = turn.toolCalls.find((c) => c.name === 'classify_section');
  if (!call) {
    throw new Error('classifySection: model did not call classify_section despite forceTool');
  }
  const args = call.arguments as Record<string, unknown> | null;
  const section = args && typeof args.section === 'string' ? args.section : undefined;
  if (!section || !sections.includes(section)) {
    throw new Error(`classifySection: model's classify_section call had an unexpected shape: ${JSON.stringify(call.arguments)}`);
  }
  return section;
}
