// Proves the Portrait Studio slot bootstrapper (orchestrator/src/orchestrator/describeStudioSlots.ts)
// against a fake settings store and a stub LLM — no DB, no network. Structurally mirrors
// verify-visual-evoprompt.mjs's marker-text parsing tests, one layer down: the "type a name, get
// slots" default path fired at entity creation whenever no slots were explicitly supplied.

import { describeStudioSlots, DEFAULT_PORTRAIT_SLOT_BOOTSTRAP_PROMPT } from '../dist/orchestrator/describeStudioSlots.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function fakeSettings(overrides = new Map()) {
  return { get: async (key) => overrides.get(key), set: async (key, value) => overrides.set(key, value) };
}

function stubLlm(reply) {
  const calls = [];
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages);
      if (reply instanceof Error) throw reply;
      return { message: { role: 'assistant', content: reply }, toolCalls: [] };
    },
  };
}

const input = {
  layerId: 'subject',
  layerLabel: 'Subject',
  layerBoundary: 'Permanent physical identity — body, face, hair, skin, distinguishing features.',
  name: 'Italian woman',
  context: 'A statuesque Italian woman with an unmistakably hourglass silhouette.',
};

// --- Well-formed reply: parses every "slot: value" line. ---
const llm1 = stubLlm('build: hourglass, curvaceous\nheight: 5\'6"\nskin_tone: warm olive, sun-kissed\nhair: jet black, thick, voluminous curls');
const slots1 = await describeStudioSlots(fakeSettings(), llm1, 'user-1', input);
assert(Object.keys(slots1).length === 4, `evoprompt bootstrap: parses every slot line -> ${Object.keys(slots1).length}`);
assert(slots1.build === 'hourglass, curvaceous', 'evoprompt bootstrap: slot values round-trip verbatim');
assert(slots1.height === '5\'6"', 'evoprompt bootstrap: a value containing a colon-free quote parses intact');

// --- Prompt interpolation: layer/name/context all land in the filled prompt sent to the LLM. ---
const llm2 = stubLlm('build: tall');
await describeStudioSlots(fakeSettings(), llm2, 'user-1', input);
const sent = llm2.calls[0][0].content;
assert(sent.includes('Layer: Subject (subject)'), 'evoprompt bootstrap: prompt carries layer label + id');
assert(sent.includes(input.layerBoundary), 'evoprompt bootstrap: prompt carries the layer boundary');
assert(sent.includes('Entity name: Italian woman'), 'evoprompt bootstrap: prompt carries the entity name');
assert(sent.includes(input.context), 'evoprompt bootstrap: prompt carries the context');

// --- Empty context renders as "(none)", not a blank line the model could misread. ---
const llm3 = stubLlm('build: tall');
await describeStudioSlots(fakeSettings(), llm3, 'user-1', { ...input, context: '' });
assert(llm3.calls[0][0].content.includes('(none)'), 'evoprompt bootstrap: empty context renders as "(none)"');

// --- System prompt override: non-empty override used verbatim; whitespace-only falls back. ---
const llmOverride = stubLlm('build: tall');
await describeStudioSlots(fakeSettings(new Map([['portrait_slot_bootstrap_prompt', 'Bespoke: {{name}}']])), llmOverride, 'user-1', input);
assert(llmOverride.calls[0][0].content === 'Bespoke: Italian woman', 'evoprompt bootstrap: non-empty override used verbatim, interpolated');

const llmBlankOverride = stubLlm('build: tall');
await describeStudioSlots(fakeSettings(new Map([['portrait_slot_bootstrap_prompt', '   ']])), llmBlankOverride, 'user-1', input);
assert(llmBlankOverride.calls[0][0].content.startsWith(DEFAULT_PORTRAIT_SLOT_BOOTSTRAP_PROMPT.slice(0, 20)), 'evoprompt bootstrap: whitespace-only override falls back to built-in');

// --- Lenient parsing: stray/malformed lines skipped, valid ones still land. ---
const llmLenient = stubLlm('a stray line with no colon\nbuild: hourglass\nanother stray line\nheight: 5\'6"\n: no key before the colon');
const lenient = await describeStudioSlots(fakeSettings(), llmLenient, 'user-1', input);
assert(Object.keys(lenient).length === 2 && lenient.build === 'hourglass' && lenient.height === '5\'6"', 'evoprompt bootstrap: valid slot lines parse even alongside stray/malformed lines');

// --- Fail-open: empty reply, LLM throw, and a reply with no parseable lines all resolve to {} without throwing. ---
const empty = await describeStudioSlots(fakeSettings(), stubLlm(''), 'user-1', input);
assert(Object.keys(empty).length === 0, 'evoprompt bootstrap: empty reply resolves to {}');

const noLines = await describeStudioSlots(fakeSettings(), stubLlm('Sure, here is a description with no slot lines at all.'), 'user-1', input);
assert(Object.keys(noLines).length === 0, 'evoprompt bootstrap: a reply with no parseable "slot: value" lines resolves to {}');

let threw = false;
try {
  await describeStudioSlots(fakeSettings(), stubLlm(new Error('provider exploded')), 'user-1', input);
} catch {
  threw = true;
}
assert(!threw, 'evoprompt bootstrap: an LLM failure never throws — resolves to {} instead');
const failed = await describeStudioSlots(fakeSettings(), stubLlm(new Error('provider exploded')), 'user-1', input);
assert(Object.keys(failed).length === 0, 'evoprompt bootstrap: an LLM failure resolves to {}');
