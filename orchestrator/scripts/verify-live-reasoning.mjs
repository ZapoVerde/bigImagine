// Proves the reasoning-block detector (orchestrator/liveReasoning.ts,
// docs/plans/reasoning-blocks-plan.md) — the per-delta tag classifier that runs on every RP
// streaming turn. A pure unit suite: the detector object + a fake settings store, no server, no
// network, no Postgres.
//
// State machine assertions (the plan's Tests section):
//   - none -> thinking on the open tag, across delta boundaries (never only within one delta)
//   - thinking -> done on the close tag; text is routed to the correct channel in each state
//   - the tags themselves are consumed — never relayed on either channel
//   - a no-op end to end when the tag pair never appears (byte-identical passthrough)
//   - the single-whole-reply-delta case classifies identically to the token-by-token case
//   - finalize(): the implicit close while still thinking (model cut off mid-thought), and a
//     partial open tag flushed as ordinary content
//   - a blank tag pair (either side) disables detection entirely — everything is content
//   - resolveReasoningTags: live-reads the two settings keys, defaulting unset values to the
//     built-in pair, and does NOT default a blank value (the store's explicit 'disabled')

import { createReasoningDetector, resolveReasoningTags, DEFAULT_REASONING_OPEN_TAG, DEFAULT_REASONING_CLOSE_TAG } from '../dist/orchestrator/liveReasoning.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// Feed the detector the same stream both ways — char-by-char and whole-reply — and require the
// identical classification (the plan's "delta-size agnostic" contract).
function classifyBothWays(text, openTag = '<think>', closeTag = '</think>') {
  const byChar = createReasoningDetector(openTag, closeTag);
  let charReasoning = '';
  let charContent = '';
  for (const ch of text) {
    const split = byChar.push(ch);
    charReasoning += split.reasoningDelta;
    charContent += split.contentDelta;
  }
  const charFinal = byChar.finalize();
  charReasoning += charFinal.reasoningDelta;
  charContent += charFinal.contentDelta;

  const whole = createReasoningDetector(openTag, closeTag);
  const wholeSplit = whole.push(text);
  const wholeFinal = whole.finalize();

  return {
    byChar: { reasoning: charReasoning, content: charContent, state: byChar.state },
    whole: {
      reasoning: wholeSplit.reasoningDelta + wholeFinal.reasoningDelta,
      content: wholeSplit.contentDelta + wholeFinal.contentDelta,
      state: whole.state,
    },
  };
}

// --- a tagged reply splits into reasoning + content, in order, tags consumed ---
{
  const text = 'She nods.<think>She knows he is lying but says nothing.</think>"Tea?" she asks.';
  const { byChar, whole } = classifyBothWays(text);
  const expectReasoning = 'She knows he is lying but says nothing.';
  const expectContent = 'She nods."Tea?" she asks.';
  assert(byChar.reasoning === expectReasoning && byChar.content === expectContent, 'the span between the tags is routed to reasoning, everything else to content, tags dropped');
  assert(whole.reasoning === byChar.reasoning && whole.content === byChar.content && whole.state === byChar.state, 'a whole-reply delta classifies identically to the char-by-char stream');
}

// --- the open tag split across delta boundaries is still detected ---
{
  const d = createReasoningDetector('<think>', '</think>');
  const c1 = d.push('She <thi');
  const c2 = d.push('nk>plans');
  const c3 = d.push(' her next move.</thi');
  const c4 = d.push('nk>out loud.');
  assert(d.state === 'done', 'the state machine reaches done');
  assert(d.reasoning === 'plans her next move.', 'the reasoning accumulated across split boundaries excludes both tags');
  assert(c1.contentDelta === 'She ' && c2.contentDelta === '' && c2.reasoningDelta === 'plans', 'the open-tag prefix is held, not relayed, until it completes or diverges');
  assert(c3.reasoningDelta === ' her next move.' && c4.reasoningDelta === '' && c4.contentDelta === 'out loud.', 'the close-tag prefix is held while pending and content resumes after it');
}

// --- no tags at all: byte-identical passthrough, never enters thinking ---
{
  const d = createReasoningDetector('<think>', '</think>');
  const split = d.push('Just a plain reply, no thoughts here.');
  assert(split.reasoningDelta === '' && split.contentDelta === 'Just a plain reply, no thoughts here.', 'everything is content when no tag appears');
  assert(d.state === 'none' && d.reasoning === '' && d.thinkingStartedAt === null, 'the detector never leaves none and never starts a timer');
  const fin = d.finalize();
  assert(fin.reasoningDelta === '' && fin.contentDelta === '', 'finalize is a no-op for a tagless stream');
}

// --- the no-completeStream fallback: one whole-reply delta (implicit close via finalize) ---
{
  const d = createReasoningDetector('<think>', '</think>');
  const split = d.push('Intro.<think>Deep thought, cut off mid-close-tag</t');
  assert(d.state === 'thinking', 'still thinking when the delta ends mid-span');
  const fin = d.finalize();
  assert(fin.reasoningDelta === '</t' && d.reasoning === 'Deep thought, cut off mid-close-tag</t', 'finalize applies the implicit close — the buffered span (partial close tag included) becomes reasoning (plan Edge Cases)');
  assert(d.state === 'done' && d.thinkingEndedAt !== null, 'finalize marks the implicit close as the end of thinking');
  assert(split.contentDelta === 'Intro.', 'the pre-span content was already relayed as content');
}

// --- a partial open tag at end of stream is ordinary literal text ---
{
  const d = createReasoningDetector('<think>', '</think>');
  d.push('She started to say <thi');
  const fin = d.finalize();
  assert(fin.contentDelta === '<thi', 'an incomplete open tag (held prefix included) is flushed as content, not dropped');
  assert(d.state === 'none', 'a never-completed open tag never enters thinking');
}

// --- a second open tag after the close is passed through as content (single-span rule) ---
{
  const d = createReasoningDetector('<think>', '</think>');
  const s1 = d.push('A.<think>B</think>C.<think>D');
  assert(d.state === 'done', 'the first close tag ends thinking');
  assert(s1.reasoningDelta === 'B' && s1.contentDelta === 'A.C.<think>D', 'after done, a second open tag is literal content — the single-span case this plan covers');
  const s2 = d.push('E');
  assert(s2.contentDelta === 'E', 'the second span is never entered — everything after the first close is content');
}

// --- a blank tag pair disables detection: everything is content ---
{
  const d = createReasoningDetector('', '</think>');
  const split = d.push('<think>not reasoning at all</think>');
  assert(split.contentDelta === '<think>not reasoning at all</think>' && split.reasoningDelta === '', 'a blank open tag disables detection — even real-looking tags stay content');
  assert(d.state === 'none', 'the detector never enters thinking when disabled');
}

// --- durationMs: null before thinking starts, then the thinking span ---
{
  let clock = 1000;
  const d = createReasoningDetector('<think>', '</think>', () => (clock += 100));
  assert(d.durationMs() === null, 'durationMs is null before any thinking');
  d.push('x<think>y');
  d.push('z</think>');
  assert(d.durationMs() === 100, 'durationMs spans from open to close completion');
  assert(d.thinkingStartedAt === 1100 && d.thinkingEndedAt === 1200, 'the timestamps bookend the classified span');
}

// --- resolveReasoningTags: live-read with built-in defaults; blank is NOT defaulted ---
{
  const store = {
    async get(key) {
      if (key === 'reasoning_open_tag') return undefined; // unset
      if (key === 'reasoning_close_tag') return '</thought>';
      return undefined;
    },
  };
  const tags = await resolveReasoningTags(store);
  assert(tags.openTag === DEFAULT_REASONING_OPEN_TAG && tags.closeTag === '</thought>', 'unset keys fall back to the built-in pair, set keys are read live');
  const storeDisabled = {
    async get(key) {
      if (key === 'reasoning_open_tag') return '';
      if (key === 'reasoning_close_tag') return '</think>';
      return undefined;
    },
  };
  const disabledTags = await resolveReasoningTags(storeDisabled);
  assert(disabledTags.openTag === '' && disabledTags.closeTag === '</think>', "a blank value survives resolve (the store's explicit 'disabled' — the detector, not the resolver, enforces it)");
  assert(DEFAULT_REASONING_OPEN_TAG === '<think>' && DEFAULT_REASONING_CLOSE_TAG === '</think>', 'the built-in pair is <think> / </think>');
}

if (process.exitCode) {
  console.error('\nlive reasoning verification FAILED');
  process.exit(1);
}
console.log('\nlive reasoning verification passed');
