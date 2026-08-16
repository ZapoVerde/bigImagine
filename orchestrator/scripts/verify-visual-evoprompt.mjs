// Proves the pure mutation-prompt builder + candidate response parser
// (orchestrator/src/portraits/evoprompt.ts, plan §Tests) — prompt construction against a fake
// layer stack, and a parse round-trip against a fake tool-call response. Pure functions: no DB,
// no network.

import {
  buildMutationPrompt,
  DEFAULT_MUTATION_SYSTEM_PROMPT,
  mutationToolDefinition,
  parseCandidateResponse,
} from '../dist/portraits/evoprompt.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// A fake layer stack — boundary prose per layer, promptable and non-promptable alike.
const layers = [
  { id: 'subject', label: 'Subject', promptable: true, boundary: 'Who the subject is. Never identity-mutating.' },
  { id: 'outfit', label: 'Outfit', promptable: true, boundary: 'Clothing and accessories.' },
  { id: 'style', label: 'Style', promptable: false, boundary: 'Art direction; owned by the trained style layer.' },
  { id: 'expression', label: 'Expression', promptable: true, boundary: 'Facial expression only.' },
];
const layerDefinitions =
  '- subject ("Subject"): Who the subject is. Never identity-mutating.\n' +
  '- outfit ("Outfit"): Clothing and accessories.\n' +
  '- expression ("Expression"): Facial expression only.';

const ctx = {
  goal: 'A calmer evening variant of Rin at the teahouse.',
  parentSlots: {
    subject: { subject_identity: 'Rin V2', age: '20' },
    outfit: { outfit_style: 'red coat' },
    expression: { expression_emotion: 'calm confidence' },
  },
  standingInstructions: {
    subject: 'Keep the teal streak.',
    outfit: '',
    expression: 'Never angry.',
  },
  wikiEntries: '## Keep coats short\nCoats read bulky below the knee.\n\n## Amber eyes carry\nAmber reads warmest under teahouse light.',
  layerDefinitions,
  pendingFeedback: 'The last round over-caffeinated the pose; prefer stillness.',
};

// --- System prompt: default + bespoke (bi_principles.md §17). ---
const pDefault = buildMutationPrompt(ctx, 3);
assert(pDefault.messages[0].role === 'system' && pDefault.messages[0].content === DEFAULT_MUTATION_SYSTEM_PROMPT, 'evoprompt: empty override → built-in system prompt');
const override = 'You are a bespoke mutation engine.';
const pOverride = buildMutationPrompt(ctx, 3, override);
assert(pOverride.messages[0].content === override, 'evoprompt: non-empty override used verbatim');
const pOverrideBlank = buildMutationPrompt(ctx, 3, '   ');
assert(pOverrideBlank.messages[0].content === DEFAULT_MUTATION_SYSTEM_PROMPT, 'evoprompt: whitespace-only override falls back to built-in');

// --- User content carries the full context. ---
const user = pDefault.messages[1].content;
assert(user.includes('Goal: A calmer evening variant of Rin at the teahouse.'), 'evoprompt: user prompt carries the goal');
assert(user.includes('- subject: subject_identity: Rin V2, age: 20'), 'evoprompt: user prompt carries parent slots per layer');
assert(user.includes('Standing instructions:\n\n- subject: Keep the teal streak.\n- expression: Never angry.'), 'evoprompt: standing instructions included (empty ones filtered)');
assert(!user.includes('Standing instructions:\n\n- subject: Keep the teal streak.\n- outfit:'), 'evoprompt: empty standing instruction for a layer filtered out');
assert(user.includes('## Keep coats short\nCoats read bulky below the knee.') && user.includes('## Amber eyes carry'), 'evoprompt: wiki lessons included');
assert(user.includes('- subject ("Subject"): Who the subject is. Never identity-mutating.'), 'evoprompt: layer boundaries included');
assert(user.includes('Produce exactly 3 mutated candidate chromosomes via propose_candidates.'), 'evoprompt: exact candidate count stated');
const pNoFeedback = buildMutationPrompt({ ...ctx, pendingFeedback: undefined }, 3);
assert(!pNoFeedback.messages[1].content.includes('Feedback from the last round:'), 'evoprompt: pendingFeedback absent when not set');

const pWithFeedback = buildMutationPrompt({ ...ctx, pendingFeedback: 'Prefer stillness.' }, 3);
assert(pWithFeedback.messages[1].content.includes('Feedback from the last round:\nPrefer stillness.'), 'evoprompt: pendingFeedback included when set');

// --- Tools: exactly the one forced propose_candidates tool, count baked into the schema. ---
assert(pDefault.tools.length === 1 && pDefault.tools[0].name === 'propose_candidates', 'evoprompt: tools = exactly [propose_candidates]');
assert(pDefault.tools[0].description.includes('exactly 3'), 'evoprompt: tool description states the requested cardinality');
assert(mutationToolDefinition(5).description.includes('exactly 5'), 'evoprompt: mutationToolDefinition(5) → description says exactly 5');
assert(pDefault.tools[0].parameters.properties.candidates.type === 'array', 'evoprompt: candidates is an array schema');

// --- Parse round-trip: string-encoded arguments (the JSON-string adapter shape). ---
function turn(callArgs) {
  return {
    message: { role: 'assistant', content: '' },
    toolCalls: [{ id: 'call-1', name: 'propose_candidates', arguments: callArgs }],
  };
}

const stringArgsTurn = turn(
  JSON.stringify({
    candidates: [
      {
        slots: {
          subject: { subject_identity: 'Rin V3', age: '20' },
          outfit: { outfit_style: 'green kimono' },
          expression: { expression_emotion: 'soft smile' },
        },
        negative_prompt: 'blurry',
      },
      {
        slots: {
          subject: { subject_identity: 'Rin V2', age: '21' },
          outfit: { outfit_style: 'red coat' },
          expression: { expression_emotion: 'calm' },
        },
      },
    ],
  }),
);
const parsed = parseCandidateResponse(stringArgsTurn);
assert(parsed.length === 2, `evoprompt: parses the requested number of candidates -> ${parsed.length}`);
assert(parsed[0].slots.subject.subject_identity === 'Rin V3' && parsed[0].slots.expression.expression_emotion === 'soft smile', 'evoprompt: per-layer slots round-trip');
assert(parsed[0].negative_prompt === 'blurry', 'evoprompt: negative_prompt round-trips');
assert(!('negative_prompt' in parsed[1]), 'evoprompt: candidate without negative_prompt parses without the key');

// --- Parse: object-encoded arguments (the object-adapter shape) — same result. ---
const objectArgsTurn = turn({
  candidates: [
    { slots: { subject: { subject_identity: 'Rin V3' } } },
  ],
});
const parsedObj = parseCandidateResponse(objectArgsTurn);
assert(parsedObj.length === 1 && parsedObj[0].slots.subject.subject_identity === 'Rin V3', 'evoprompt: object-encoded arguments parse identically');

// --- Parse failures: loud, descriptive. ---
let threw = false;
try {
  parseCandidateResponse({ message: { role: 'assistant', content: 'no call' }, toolCalls: [{ id: 'c', name: 'other_tool', arguments: {} }] });
} catch (err) {
  threw = err.message.includes('did not call propose_candidates');
}
assert(threw, 'evoprompt: missing propose_candidates call throws a descriptive error');

threw = false;
try {
  parseCandidateResponse(turn('not json'));
} catch (err) {
  threw = err.message.includes('not valid JSON');
}
assert(threw, 'evoprompt: undecodable JSON-string arguments throw');

threw = false;
try {
  parseCandidateResponse(turn(42));
} catch (err) {
  threw = err.message.includes('not an object');
}
assert(threw, 'evoprompt: non-object arguments throw');

threw = false;
try {
  parseCandidateResponse(turn({ no_candidates: true }));
} catch (err) {
  threw = err.message.includes('no candidates array');
}
assert(threw, 'evoprompt: missing candidates array throws');

threw = false;
try {
  parseCandidateResponse(turn({ candidates: [42] }));
} catch (err) {
  threw = err.message.includes('non-object candidate');
}
assert(threw, 'evoprompt: non-object candidate throws');

// --- Lenient normalization: missing slots object → { slots: {} }; non-string values coerced;
//     empty negative_prompt omitted. Reconcile.ts is the strict per-layer gate downstream. ---
const lenient = parseCandidateResponse(
  turn({
    candidates: [
      {},
      { slots: { subject: { subject_identity: 'Rin V3', age: 21 } }, negative_prompt: '' },
    ],
  }),
);
assert(lenient[0].slots && Object.keys(lenient[0].slots).length === 0, 'evoprompt: candidate without slots parses to { slots: {} }');
assert(lenient[1].slots.subject.age === '21', `evoprompt: non-string slot value coerced -> "${lenient[1].slots.subject.age}"`);
assert(!('negative_prompt' in lenient[1]), 'evoprompt: empty negative_prompt omitted from the parsed chromosome');
