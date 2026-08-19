// Proves the async-cleanup heuristic engine (orchestrator/src/orchestrator/cleanupHeuristics.ts,
// migration 0072, plan v2) — pure functions, no server, no network, no LLM, no fake pool needed.
// The suite exercises:
//   - paragraph utilities (TRG ports): newline-bounded extraction, dedupe-by-start, document order;
//   - evaluateSlopRules: 'remove' (global, optional replacement) applied in set/position order,
//     replace-paragraph / llm steps captured with fully-resolved prompts, invalid + disabled rules;
//   - inspectHeader / inspectFooter: the canonical two-line header and <details> inner-thoughts
//     block recognize, malformed/missing/suspected statuses gate correctly, and a turn with no
//     inner thoughts (footer 'missing') still fires a repair step that builds a fresh footer
//     (0066 rule 3 reversed 2026-08-11);
//   - {{history, N}} / {{message}} resolution (mirrors the retired {{prev_turns, N}} contract);
//   - planCleanup assembly + the pure executor applyRepairSteps (splice, first-rule-wins overlap
//     skip, llm-message terminal, header insert/replace, footer append/replace, fail-open).

import {
  extractParagraph,
  collectUniqueParagraphs,
  nextCompletedParagraph,
  compileRulePattern,
  evaluateSlopRules,
  inspectHeader,
  inspectFooter,
  formatHistoryPairs,
  parseHistoryPairs,
  buildRepairPrompt,
  planCleanup,
  applyRepairSteps,
  DEFAULT_CLEANUP_CONFIG,
} from '../dist/orchestrator/cleanupHeuristics.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fixtures: canonical shapes (locationAndPresenceScraper.ts + character-visual-state-plan.md) --
const CANONICAL_HEADER = `[ Early Morning | 🗓️ Tuesday, August 7, 2026 AD | 📍 The Keep - Main Hall ]
Present: Kael, Mira
The fire crackled in the hearth.`;
// The canonical inner-thoughts footer (character-visual-state-plan.md §Canonical footer format):
// <details><summary>▸</summary> + one <Name> block per roster character, each carrying
// Inner thoughts:/Expression:/Outfit: in order and the six canonical `- Slot:` lines in canonical
// order, closed by </details>. This is the ONLY shape the structure-aware footer regex accepts.
const CANONICAL_FOOTER = `Kael turned the cup in his hands.

<details><summary>▸</summary>
<Kael>
Inner thoughts: Nervous about the gathering.
Expression: calm
Outfit:
- Outerwear: none
- Top: shirt
- Bottom: trousers
- Underwear top: none
- Underwear bottom: none
- Accessory: none
</Kael>
</details>`;
// The legacy 0066 inner-thoughts block (no field markers) — deliberately NOT conforming under the
// structure-aware footer check: it lands as 'malformed' and gets repaired into the canonical shape.
const LEGACY_FOOTER = `Kael turned the cup in his hands.

<details><summary>▸</summary>
<inner thoughts>
Kael:
Nervous about the gathering.
</inner thoughts>
</details>`;

const HEADER_CFG = {
  regex: DEFAULT_CLEANUP_CONFIG.headerRegex,
  flags: DEFAULT_CLEANUP_CONFIG.headerFlags,
  prompt: DEFAULT_CLEANUP_CONFIG.headerPrompt,
};
const FOOTER_CFG = {
  regex: DEFAULT_CLEANUP_CONFIG.footerRegex,
  flags: DEFAULT_CLEANUP_CONFIG.footerFlags,
  prompt: DEFAULT_CLEANUP_CONFIG.footerPrompt,
};

const SLOP = [
  { ruleId: 'r1', setName: 'ai-cliches', position: 0, pattern: '\\b(?:as an AI|as a language model)\\b', flags: 'i', action: 'remove', replacement: null, llmPrompt: null, enabled: true },
  { ruleId: 'r2', setName: 'formatting', position: 0, pattern: '\\s*[\\u2026]{2,}\\s*', flags: '', action: 'remove', replacement: ' ', llmPrompt: null, enabled: true },
  { ruleId: 'r3', setName: 'ai-cliches', position: 1, pattern: '\\bdelve\\b', flags: 'i', action: 'replace-paragraph', replacement: null, llmPrompt: 'The paragraph contains "{{keyword}}". Fix it.\n\n{{paragraph}}', enabled: true },
  { ruleId: 'r4', setName: 'custom', position: 0, pattern: '(', flags: '', action: 'remove', replacement: null, llmPrompt: null, enabled: true },
  { ruleId: 'r5', setName: 'custom', position: 1, pattern: '\\bno-no-phrase\\b', flags: 'i', action: 'llm', replacement: null, llmPrompt: 'Remove "{{keyword}}" from:\n{{message}}', enabled: true },
  { ruleId: 'r6', setName: 'custom', position: 2, pattern: '\\bwhatever\\b', flags: 'i', action: 'remove', replacement: null, llmPrompt: null, enabled: false },
];

// --- Paragraph utilities (TRG semantics) --------------------------------------------------------
{
  const text = 'first line\nsecond line\nthird line';
  const mid = extractParagraph(text, 13); // inside "second"
  assert(mid.text === 'second line' && mid.start === 11 && mid.end === 22, 'extractParagraph: middle paragraph bounds');
  const last = extractParagraph(text, 25); // inside "third" (no trailing newline)
  assert(last.text === 'third line' && last.start === 23 && last.end === 33, 'extractParagraph: last paragraph runs to end of text');
  const first = extractParagraph(text, 2);
  assert(first.text === 'first line' && first.start === 0, 'extractParagraph: first paragraph starts at 0');

  const re = /delve/gi;
  const multi = collectUniqueParagraphs('a delve here\nb c\nc delve again\nd delve', re);
  assert(multi.length === 3, 'collectUniqueParagraphs: one paragraph per distinct line containing a match');
  assert(multi[0].start === 0 && multi[2].start > multi[1].start && multi[1].start > multi[0].start, 'collectUniqueParagraphs: document order (ascending start)');

  const dup = collectUniqueParagraphs('delve once and delve twice in one line', re);
  assert(dup.length === 1, 'collectUniqueParagraphs: two matches in the same paragraph dedupe to one');
}

// --- nextCompletedParagraph (live streaming cursor) --------------------------------------------
{
  // Streaming: "first line\n" closes -> returns it; the open tail is not returned until it closes.
  const streaming = 'first line\nsecond li';
  const p1 = nextCompletedParagraph(streaming, 0);
  assert(p1 && p1.text === 'first line' && p1.start === 0 && p1.end === 10, 'nextCompletedParagraph: closed paragraph returned with end at the newline');
  assert(nextCompletedParagraph(streaming, p1.end + 1) === null, 'nextCompletedParagraph: unterminated tail is not completed (deferred to finishStream)');

  // The tail closes on the next delta -> cursor advances across paragraphs in order.
  const closed = 'first line\nsecond line\n';
  const p2 = nextCompletedParagraph(closed, p1.end + 1);
  assert(p2 && p2.text === 'second line' && p2.start === 11 && p2.end === 22, 'nextCompletedParagraph: cursor advances to the next closed paragraph');
  assert(nextCompletedParagraph(closed, p2.end + 1) === null, 'nextCompletedParagraph: buffer exhausted after the last newline');

  // The engine's streaming invariant: every closed paragraph is visited exactly once.
  const multi = 'alpha\nbeta\ngamma\n';
  let cursor = 0;
  const seen = [];
  for (let p = nextCompletedParagraph(multi, cursor); p !== null; p = nextCompletedParagraph(multi, cursor)) {
    seen.push(p.text);
    cursor = p.end + 1;
  }
  assert(seen.join(',') === 'alpha,beta,gamma', 'nextCompletedParagraph: all closed paragraphs visited exactly once, in order');

  // Blank paragraph ("\n\n") is a valid completed paragraph, matching extractParagraph's semantics.
  const blank = 'one\n\nthree\n';
  const pb = nextCompletedParagraph(blank, 4);
  assert(pb && pb.text === '' && pb.start === 4 && pb.end === 4, 'nextCompletedParagraph: an empty paragraph is completed at its own newline');

  // Empty buffer / exhausted cursor -> null, never an empty paragraph.
  assert(nextCompletedParagraph('', 0) === null, 'nextCompletedParagraph: empty buffer yields null');
  assert(nextCompletedParagraph('x', 1) === null, 'nextCompletedParagraph: cursor past the end yields null');
}

// --- compileRulePattern ------------------------------------------------------------------------
{
  const g = compileRulePattern({ ruleId: 'x', setName: 's', position: 0, pattern: '\\bfoo\\b', flags: 'i', action: 'remove', replacement: null, llmPrompt: null, enabled: true });
  assert(g instanceof RegExp && g.flags.includes('g') && g.flags.includes('i'), 'compileRulePattern: global flag is implied, other flags preserved');
  const bad = compileRulePattern({ ruleId: 'x', setName: 's', position: 0, pattern: '(', flags: '', action: 'remove', replacement: null, llmPrompt: null, enabled: true });
  assert(bad === null, 'compileRulePattern: invalid pattern returns null');
}

// --- evaluateSlopRules -------------------------------------------------------------------------
{
  const dirty = 'As an AI, I cannot. But as a language model I must. Hmm…… and so.\n\nI must not delve into forbidden lore. no-no-phrase.';
  const out = evaluateSlopRules(dirty, SLOP);
  assert(!out.text.includes('as an AI') && !out.text.includes('as a language model'), "remove: 'as an AI' / 'as a language model' stripped case-insensitively, all occurrences");
  assert(!out.text.includes('……'), 'remove: multi-ellipsis run collapsed via static replacement');
  assert(out.invalidRules.length === 1 && out.invalidRules[0].ruleId === 'r4', 'invalid rule is reported, does not abort the pass');
  assert(out.text.includes('no-no-phrase'), 'llm rules do not mutate text (their output replaces it at execution)');
  assert(out.steps.filter((s) => s.kind === 'llm-message' && s.ruleId === 'r5').length === 1, 'llm rule fires once on first match, prompt captured');
  assert(out.steps.filter((s) => s.kind === 'llm-message' && s.ruleId === 'r5')[0].prompt.includes('Remove "no-no-phrase" from:'), 'llm rule prompt resolves {{keyword}} at plan time');

  const para = out.steps.find((s) => s.kind === 'replace-paragraph' && s.ruleId === 'r3');
  assert(para && para.prompt.includes('The paragraph contains "delve"'), 'replace-paragraph prompt resolves {{keyword}} at plan time');
  assert(para && para.prompt.endsWith('Fix it.\n\n' + para.span.text), 'replace-paragraph prompt resolves {{paragraph}} at plan time');
  assert(para && para.span.text.includes('delve') && para.span.start < para.span.end, 'replace-paragraph step carries the paragraph span');
}

// --- inspectHeader -----------------------------------------------------------------------------
{
  assert(inspectHeader(CANONICAL_HEADER, HEADER_CFG).status === 'ok', 'header: canonical two-line header is ok');
  const noEmoji = '[ Early Morning | Tuesday, August 7, 2026 AD | The Keep - Main Hall ]\nPresent: Kael\nx';
  assert(inspectHeader(noEmoji, HEADER_CFG).status === 'ok', 'header: emoji prefixes are optional');
  assert(inspectHeader('The fire crackled.\nPresent: Kael', HEADER_CFG).status === 'malformed', 'header: Present: without the bracket line is malformed');
  assert(inspectHeader('[ Early Morning | The Keep ]\nKael entered.', HEADER_CFG).status === 'malformed', 'header: a bracket line missing the Present line is malformed');
  assert(inspectHeader('Just a plain reply with no header at all.', HEADER_CFG).status === 'missing', 'header: a plain reply is missing');
  const brokenCfg = { ...HEADER_CFG, regex: '(' };
  assert(inspectHeader(CANONICAL_HEADER, brokenCfg).status === 'missing', 'header: an unparseable configured regex degrades to missing, never ok');
}

// --- inspectFooter -----------------------------------------------------------------------------
{
  assert(inspectFooter(CANONICAL_FOOTER, FOOTER_CFG).status === 'ok', 'footer: canonical details block is ok');
  assert(inspectFooter(LEGACY_FOOTER, FOOTER_CFG).status === 'malformed', 'footer: the legacy 0066 <inner thoughts> block (no field markers) is malformed under the structure-aware check (character-visual-state-plan.md)');
  assert(inspectFooter(CANONICAL_FOOTER.replace('<details>', '<DETAILS>').replace('</details>', '</DETAILS>'), FOOTER_CFG).status === 'ok', 'footer: matching is case-insensitive');
  assert(inspectFooter('Kael smiled.\n\n<details><summary>▸</summary>\n<inner thoughts>\nTrailing, unclosed.', FOOTER_CFG).status === 'malformed', 'footer: an unclosed details block is malformed');
  assert(inspectFooter('Kael smiled.\n\n*She hesitated, her heart racing.*', FOOTER_CFG).status === 'suspected', 'footer: whole-line italic narration is suspected (stray inner thoughts)');
  assert(inspectFooter('Kael smiled and set the cup down.', FOOTER_CFG).status === 'missing', 'footer: a clean reply with no thought evidence stays missing (must not gain one)');
}

// --- formatHistoryPairs / parseHistoryPairs ----------------------------------------------------
{
  const h = [
    { role: 'user', content: 'Where are we?' },
    { role: 'assistant', content: '[ Evening | The Keep ]\nPresent: Kael\nIn the hall.' },
    { role: 'user', content: 'Who else?' },
  ];
  const two = formatHistoryPairs(h, 2);
  assert(two === 'User: Where are we?\nAssistant: [ Evening | The Keep ]\nPresent: Kael\nIn the hall.\nUser: Who else?', 'history: last 2 turn pairs render as labeled User:/Assistant: lines, oldest first');
  assert(formatHistoryPairs(h, 1) === 'Assistant: [ Evening | The Keep ]\nPresent: Kael\nIn the hall.\nUser: Who else?', 'history: a 1-pair window renders the last two messages (a mid-pair window renders what it has)');
  assert(formatHistoryPairs(h, 0) === '', 'history: 0 pairs renders nothing');
  assert(parseHistoryPairs('3') === 3 && parseHistoryPairs(undefined) === 2 && parseHistoryPairs('x') === 2 && parseHistoryPairs('-1') === 2, 'history: pair-count argument parses with a default of 2');
}

// --- buildRepairPrompt -------------------------------------------------------------------------
{
  const h = [
    { role: 'user', content: 'Where are we?' },
    { role: 'assistant', content: 'In the hall.' },
  ];
  const prompt = buildRepairPrompt('History:\n{{history, 1}}\n\nMessage:\n{{message}}', { message: 'Hi.', history: h });
  assert(prompt.includes('History:\nUser: Where are we?\nAssistant: In the hall.'), 'repair prompt: {{history, N}} expands');
  assert(prompt.includes('Message:\nHi.'), 'repair prompt: {{message}} expands');
  const alias = buildRepairPrompt('{{prev_turns, 1}}', { message: '', history: h });
  assert(alias === 'User: Where are we?\nAssistant: In the hall.', 'repair prompt: {{prev_turns, N}} alias still resolves');
  assert(buildRepairPrompt('{{history, 2}}', { message: '' }).trim() === '', 'repair prompt: no history supplied renders an empty block, never an error');
  assert(buildRepairPrompt('Character: {{user}}', { message: '', userName: 'Alex' }) === 'Character: Alex', 'repair prompt: {{user}} resolves to persona_name');
  assert(buildRepairPrompt('{{user}}', { message: '' }) === '', 'repair prompt: unset persona_name renders an empty {{user}}, never an error');
}

// --- planCleanup -------------------------------------------------------------------------------
{
  // Header present but footer missing and no thought evidence: header stays 'ok', footer repair
  // still fires and builds a fresh footer (0066 rule 3 reversed 2026-08-11).
  const clean = `${CANONICAL_HEADER}\n\nKael set the cup down.`;
  const planMissingFooter = planCleanup(clean, [], HEADER_CFG, FOOTER_CFG, { history: [{ role: 'user', content: 'Where are we?' }] });
  assert(planMissingFooter.header.status === 'ok' && planMissingFooter.footer.status === 'missing', 'plan: ok header + missing footer reported');
  assert(planMissingFooter.steps.length === 1, 'plan: a missing footer with no thought evidence still fires a repair step');
  const missingFooterStep = planMissingFooter.steps.find((s) => s.kind === 'repair-footer');
  assert(
    missingFooterStep && missingFooterStep.span.start === clean.length && missingFooterStep.span.end === clean.length,
    'plan: missing-footer repair appends at the end, same as suspected',
  );

  // Missing header + suspected footer: both repair steps fire, prompts fully resolved.
  const messy = 'Kael entered the hall.\n\n*She hesitated, her heart racing.*';
  const plan = planCleanup(messy, [], HEADER_CFG, FOOTER_CFG, {
    history: [
      { role: 'user', content: 'Where are we?' },
      { role: 'assistant', content: 'In the hall.' },
    ],
    historyPairs: 1,
  });
  assert(plan.header.status === 'missing' && plan.footer.status === 'suspected', 'plan: missing header + suspected footer statuses');
  const headerStep = plan.steps.find((s) => s.kind === 'repair-header');
  const footerStep = plan.steps.find((s) => s.kind === 'repair-footer');
  assert(headerStep && headerStep.span.start === 0 && headerStep.span.end === 0, 'plan: missing-header repair inserts at the top (empty span)');
  assert(headerStep && headerStep.prompt.includes('Assistant: In the hall.'), 'plan: header repair prompt carries {{history, 1}} expansion');
  assert(headerStep && headerStep.prompt.includes('Reply to fix:\n' + messy), 'plan: header repair prompt carries {{message}} = the post-remove text');
  assert(footerStep && footerStep.span.start === messy.length && footerStep.span.end === messy.length, 'plan: suspected-footer repair appends at the end');
  assert(footerStep && footerStep.prompt.includes('Reply:\n' + messy), 'plan: footer repair prompt carries {{message}} only');

  // Malformed footer: the repair replaces the broken block rather than appending.
  const brokenFooter = 'Kael smiled.\n\n<details><summary>▸</summary>\n<inner thoughts>\nTrailing.';
  const planBroken = planCleanup(brokenFooter, [], HEADER_CFG, FOOTER_CFG);
  const bf = planBroken.steps.find((s) => s.kind === 'repair-footer');
  assert(planBroken.footer.status === 'malformed' && bf && bf.span.start === brokenFooter.indexOf('<details') && bf.span.end === brokenFooter.length, 'plan: an unclosed details block is swallowed to end of text');

  // Slop + regions compose into one ordered plan.
  const composed = planCleanup('As an AI, I cannot delve further.\n\nNo-no-phrase here.', SLOP, HEADER_CFG, FOOTER_CFG);
  assert(!composed.text.includes('As an AI'), 'plan: remove rules applied to the plan text');
  assert(composed.steps.some((s) => s.kind === 'replace-paragraph') && composed.steps.some((s) => s.kind === 'llm-message'), 'plan: slop LLM steps survive into the composed plan');
  assert(composed.invalidRules.length === 1, 'plan: invalid rules surfaced on the composed plan');
}

// --- applyRepairSteps (pure executor) -----------------------------------------------------------
{
  // replace-paragraph splice: spans computed (not hardcoded) — 'a delve here' = [0,12), 'delve again' = [17,28).
  const text = 'a delve here\nb c\ndelve again';
  const d1 = text.indexOf('delve');
  const d2 = text.indexOf('delve again');
  const p1 = { kind: 'replace-paragraph', ruleId: 'r3', setName: 's', span: { text: 'a delve here', start: d1 - 2, end: d1 + 10 }, prompt: 'x' };
  const p2 = { kind: 'replace-paragraph', ruleId: 'r3', setName: 's', span: { text: 'delve again', start: d2, end: d2 + 11 }, prompt: 'x' };
  const spliced = applyRepairSteps(text, [p1, p2], ['fixed one', 'fixed two']);
  assert(spliced === 'fixed one\nb c\nfixed two', 'executor: replace-paragraph splices each unique paragraph back');

  // Overlap skip: two steps targeting the same span — the first wins (TRG documented behavior).
  const pA = { kind: 'replace-paragraph', ruleId: 'r3', setName: 's', span: { text: 'delve once', start: 0, end: 10 }, prompt: 'x' };
  const same = applyRepairSteps('delve once', [pA, pA], ['first', 'second']);
  assert(same === 'first', 'executor: overlapping replace-paragraph spans skip (TRG first-rule-wins)');

  // llm-message is terminal and replaces the whole reply.
  const term = applyRepairSteps('anything', [{ kind: 'llm-message', ruleId: 'r5', setName: 's', matched: 'x', prompt: 'x' }], ['the whole rewrite']);
  assert(term === 'the whole rewrite', 'executor: llm-message output is the final text, terminal');

  // Header insert (missing) vs replace (malformed).
  const hInsert = applyRepairSteps('Kael entered.', [{ kind: 'repair-header', span: { start: 0, end: 0 }, prompt: 'x' }], ['[ Night | The Keep ]\nPresent: Kael']);
  assert(hInsert === '[ Night | The Keep ]\nPresent: Kael\nKael entered.', 'executor: missing-header repair prepends the two lines');
  const hReplace = applyRepairSteps('[ Bad Header ]\nKael entered.', [{ kind: 'repair-header', span: { start: 0, end: '[ Bad Header ]\n'.length }, prompt: 'x' }], ['[ Night | The Keep ]\nPresent: Kael']);
  assert(hReplace === '[ Night | The Keep ]\nPresent: Kael\nKael entered.', 'executor: malformed-header repair replaces the broken first line');

  // Footer append (suspected) vs replace (malformed).
  const fAppend = applyRepairSteps('Kael smiled.', [{ kind: 'repair-footer', span: { start: 12, end: 12 }, prompt: 'x' }], ['<details><summary>▸</summary>\n<inner thoughts>\nKael:\nFine.\n</inner thoughts>\n</details>']);
  assert(fAppend === 'Kael smiled.\n\n<details><summary>▸</summary>\n<inner thoughts>\nKael:\nFine.\n</inner thoughts>\n</details>', 'executor: suspected-footer repair appends with a blank-line separator');
  const fReplace = applyRepairSteps('Kael smiled.\n\n<details><summary>▸</summary>\nTrailing.', [{ kind: 'repair-footer', span: { start: 14, end: 'Kael smiled.\n\n<details><summary>▸</summary>\nTrailing.'.length }, prompt: 'x' }], ['<details><summary>▸</summary>\n<inner thoughts>\nKael:\nFine.\n</inner thoughts>\n</details>']);
  assert(fReplace === 'Kael smiled.\n\n<details><summary>▸</summary>\n<inner thoughts>\nKael:\nFine.\n</inner thoughts>\n</details>', 'executor: malformed-footer repair replaces the broken block');

  // Fail-open: empty output leaves the region untouched.
  const noop = applyRepairSteps('Kael entered.', [{ kind: 'repair-header', span: { start: 0, end: 0 }, prompt: 'x' }], ['']);
  assert(noop === 'Kael entered.', 'executor: empty repair output leaves the text unchanged (fail-open)');

  // Regression: a header repair (span near 0) and a paragraph replacement (span after it) landing
  // in the same plan must both apply cleanly. planCleanup always appends the header step after the
  // slop steps regardless of position, so insertion order alone doesn't give descending span.start
  // — splicing by insertion order would apply the header edit first and corrupt the not-yet-applied
  // paragraph step's now-stale original-text coordinates.
  const combo = '[ Bad Header ]\nShe said the bad word here.\nMore text after.';
  const comboHeaderSpan = { start: 0, end: '[ Bad Header ]\n'.length };
  const comboParaStart = comboHeaderSpan.end;
  const comboParaEnd = comboParaStart + 'She said the bad word here.'.length;
  const comboSteps = [
    {
      kind: 'replace-paragraph',
      ruleId: 'r1',
      setName: 's',
      span: { text: combo.slice(comboParaStart, comboParaEnd), start: comboParaStart, end: comboParaEnd },
      prompt: 'x',
    },
    { kind: 'repair-header', span: comboHeaderSpan, prompt: 'y' },
  ];
  const comboResult = applyRepairSteps(combo, comboSteps, ['She said something nice instead.', '[ Night | The Keep ]\nPresent: Kael']);
  assert(
    comboResult === '[ Night | The Keep ]\nPresent: Kael\nShe said something nice instead.\nMore text after.',
    'executor: a header repair and a later paragraph replacement in the same plan both apply intact (splice order is by span position, not step insertion order)',
  );
}

// --- Defaults are self-consistent with the fixtures --------------------------------------------
assert(planCleanup(CANONICAL_HEADER, [], HEADER_CFG, FOOTER_CFG).header.status === 'ok', 'defaults: canonical header + default regex agree');
assert(planCleanup(CANONICAL_FOOTER, [], HEADER_CFG, FOOTER_CFG).footer.status === 'ok', 'defaults: canonical footer + default regex agree');

if (process.exitCode) {
  console.error('cleanup heuristics verification FAILED');
} else {
  console.log('cleanup heuristics verification passed');
}
