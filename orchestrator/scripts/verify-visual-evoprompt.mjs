// Proves the pure mutation-prompt builder + candidate response parser
// (orchestrator/src/portraits/evoprompt.ts, plan §Tests) — prompt construction against a fake
// layer stack, and a parse round-trip against a fake plain-text mutation reply. Pure functions:
// no DB, no network.
//
// 2026-08-17: propose_candidates stopped being a forced tool call (OpenRouter routing filtered
// out otherwise-healthy pinned providers on a forced named-function tool_choice, and providers
// that did accept it returned malformed JSON for this nested a schema) — the mutation reply is
// now plain marker text, and this script was rewritten to match (evoprompt.ts file header).

import { buildMutationPrompt, DEFAULT_MUTATION_SYSTEM_PROMPT, parseCandidateResponse } from '../dist/portraits/evoprompt.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// A fake layer stack — boundary prose per layer, promptable and non-promptable alike.
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

// --- Built-in system prompt states the marker format, not a tool call. ---
assert(DEFAULT_MUTATION_SYSTEM_PROMPT.includes('### Candidate 1'), 'evoprompt: built-in system prompt states the marker format');
assert(!DEFAULT_MUTATION_SYSTEM_PROMPT.toLowerCase().includes('propose_candidates'), 'evoprompt: built-in system prompt no longer references a tool call');

// --- No tools: buildMutationPrompt returns only messages. ---
assert(!('tools' in pDefault), 'evoprompt: buildMutationPrompt no longer returns a tools array');

// --- User content carries the full context. ---
const user = pDefault.messages[1].content;
assert(user.includes('Goal: A calmer evening variant of Rin at the teahouse.'), 'evoprompt: user prompt carries the goal');
assert(user.includes('- subject: subject_identity: Rin V2, age: 20'), 'evoprompt: user prompt carries parent slots per layer');
assert(!user.includes('Standing instructions'), 'evoprompt: standing instructions no longer appear in the mutation prompt (migration 0114)');
assert(user.includes('## Keep coats short\nCoats read bulky below the knee.') && user.includes('## Amber eyes carry'), 'evoprompt: wiki lessons included');
assert(user.includes('- subject ("Subject"): Who the subject is. Never identity-mutating.'), 'evoprompt: layer boundaries included');
assert(user.includes('Produce exactly 3 mutated candidate chromosomes in the format described above.'), 'evoprompt: exact candidate count stated');
const pNoFeedback = buildMutationPrompt({ ...ctx, pendingFeedback: undefined }, 3);
assert(!pNoFeedback.messages[1].content.includes('Feedback from the last round:'), 'evoprompt: pendingFeedback absent when not set');

const pWithFeedback = buildMutationPrompt({ ...ctx, pendingFeedback: 'Prefer stillness.' }, 3);
assert(pWithFeedback.messages[1].content.includes('Feedback from the last round:\nPrefer stillness.'), 'evoprompt: pendingFeedback included when set');

// --- Parse round-trip: a well-formed plain-text reply. ---
function turn(content) {
  return { message: { role: 'assistant', content }, toolCalls: [] };
}

const wellFormed = turn(
  [
    '### Candidate 1',
    '[subject]',
    'subject_identity: Rin V3',
    'age: 20',
    '[outfit]',
    'outfit_style: green kimono',
    '[expression]',
    'expression_emotion: soft smile',
    'Negative: blurry',
    '',
    '### Candidate 2',
    '[subject]',
    'subject_identity: Rin V2',
    'age: 21',
    '[outfit]',
    'outfit_style: red coat',
    '[expression]',
    'expression_emotion: calm',
  ].join('\n'),
);
const parsed = parseCandidateResponse(wellFormed);
assert(parsed.length === 2, `evoprompt: parses the requested number of candidates -> ${parsed.length}`);
assert(parsed[0].slots.subject.subject_identity === 'Rin V3' && parsed[0].slots.expression.expression_emotion === 'soft smile', 'evoprompt: per-layer slots round-trip');
assert(parsed[0].negative_prompt === 'blurry', 'evoprompt: negative_prompt round-trips');
assert(!('negative_prompt' in parsed[1]), 'evoprompt: candidate without negative_prompt parses without the key');

// --- A looser heading style ("## Candidate 1", trailing text) still matches. ---
const looseHeading = turn('## Candidate 1 (mutated)\n[subject]\nsubject_identity: Rin V4\n');
const parsedLoose = parseCandidateResponse(looseHeading);
assert(parsedLoose.length === 1 && parsedLoose[0].slots.subject.subject_identity === 'Rin V4', 'evoprompt: a looser "## Candidate N ..." heading still parses');

// --- Parse failures: loud, descriptive, only for reply-level failures. ---
let threw = false;
try {
  parseCandidateResponse(turn(''));
} catch (err) {
  threw = err.message.includes('no content');
}
assert(threw, 'evoprompt: empty reply throws a descriptive error');

threw = false;
try {
  parseCandidateResponse(turn('Sure, here are some ideas about the character.'));
} catch (err) {
  threw = err.message.includes('no "### Candidate N" block');
}
assert(threw, 'evoprompt: a reply with no recognizable candidate block throws');

// --- Lenient normalization: stray lines, lines with no layer yet, and lines with no colon are
//     skipped rather than fatal — reconcile.ts is the strict per-layer gate downstream. ---
const lenient = parseCandidateResponse(
  turn(
    [
      '### Candidate 1',
      'a stray line before any [layerId] block',
      '[subject]',
      'subject_identity: Rin V3',
      'not a key-value line',
      'age: 21',
    ].join('\n'),
  ),
);
assert(lenient.length === 1 && lenient[0].slots.subject.subject_identity === 'Rin V3' && lenient[0].slots.subject.age === '21', 'evoprompt: valid slot lines parse even alongside stray/malformed lines');

// --- A candidate block with no [layerId] blocks at all still parses to { slots: {} } rather ---
// --- than throwing — reconcile.ts backfills every slot from the parent (plan §Edge Cases). ---
const emptyCandidate = parseCandidateResponse(turn('### Candidate 1\nsome stray text, no layer headers at all\n'));
assert(emptyCandidate.length === 1 && Object.keys(emptyCandidate[0].slots).length === 0, 'evoprompt: candidate with no [layerId] blocks parses to { slots: {} }');
