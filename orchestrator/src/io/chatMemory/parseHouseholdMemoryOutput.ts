/**
 * @file orchestrator/src/io/chatMemory/parseHouseholdMemoryOutput.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function — parses household-memory classifier text
 * @description Accepts only the classifier's exact sentinel or a complete, unique bullet list.
 * @api-declaration parseHouseholdMemoryOutput(raw) — returns household memory strings or throws.
 * @contract purity: pure; state_ownership: []; external_io: []
 */

const NO_MEMORIES_SENTINEL = 'NO MEMORIES';

function normalize(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim();
  if (text.startsWith('```') && text.endsWith('```')) {
    text = text.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '').trim();
  }
  return text;
}

export function parseHouseholdMemoryOutput(raw: string): string[] {
  const text = normalize(raw);
  if (text.toUpperCase() === NO_MEMORIES_SENTINEL) return [];
  if (text.length === 0) throw new Error('classifyHouseholdMemory: model returned an empty response');

  const memories: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.startsWith('- ')) {
      throw new Error('classifyHouseholdMemory: model returned malformed output; expected only bullet lines');
    }
    const memory = line.slice(2).trim();
    if (!memory) throw new Error('classifyHouseholdMemory: model returned an empty memory bullet');
    if (seen.has(memory)) throw new Error('classifyHouseholdMemory: model returned duplicate memories');
    seen.add(memory);
    memories.push(memory);
  }
  return memories;
}
