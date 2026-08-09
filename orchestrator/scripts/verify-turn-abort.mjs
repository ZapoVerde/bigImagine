// Proves the Stop-button server side (orchestrator/turnAbort.ts) — the registry semantics that
// POST /v1/chat/abort and the retry layers depend on:
//   - abortTurn() only reports success when something was actually in flight
//   - one taskId can hold multiple controllers (interactive turn + cleanup repair), and one
//     abort kills them all, while unregistering one leaves the others abortable
//   - an AbortError raised through the chain is recognizable and never retried (fetchWithRetry
//     and isRetryableLlmError both treat it as terminal — the two places a Stop could otherwise
//     be re-fired)

import { registerTurnAbort, unregisterTurnAbort, abortTurn, isAbortError } from '../dist/orchestrator/turnAbort.js';
import { fetchWithRetry } from '../dist/io/httpRetry.js';
import { isRetryableLlmError } from '../dist/io/llm/llmRetryClassify.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- abort with nothing registered is a clean miss, not an error ---
{
  assert(abortTurn('no-such-chat') === false, 'aborting an unknown/not-in-flight taskId returns false');
}

// --- register -> abort -> signal fires; unregister removes the key ---
{
  const controller = registerTurnAbort('chat-a');
  assert(controller.signal.aborted === false, 'a freshly registered controller starts un-aborted');
  assert(abortTurn('chat-a') === true, 'abortTurn reports success when something is in flight');
  assert(controller.signal.aborted === true, 'the registered controller\'s signal fired');
  unregisterTurnAbort('chat-a', controller);
  assert(abortTurn('chat-a') === false, 'after unregistering, the taskId is no longer abortable');
}

// --- one taskId, many controllers: one abort kills them all; unregistering one leaves the rest ---
{
  const first = registerTurnAbort('chat-b');
  const second = registerTurnAbort('chat-b');
  assert(abortTurn('chat-b') === true, 'abortTurn hits every task registered under the key');
  assert(first.signal.aborted && second.signal.aborted, 'both controllers (turn + cleanup repair) fire');
  unregisterTurnAbort('chat-b', first);
  unregisterTurnAbort('chat-b', second);
  assert(abortTurn('chat-b') === false, 'the key disappears once every controller is unregistered');
}

// --- unregistering one controller does not detach the others ---
{
  const first = registerTurnAbort('chat-c');
  const second = registerTurnAbort('chat-c');
  unregisterTurnAbort('chat-c', first);
  assert(abortTurn('chat-c') === true, 'a still-registered controller remains abortable after a sibling unregisters');
  assert(second.signal.aborted === true, 'and that controller\'s signal fires');
  unregisterTurnAbort('chat-c', second);
}

// --- isAbortError: only the fetch-abort shape qualifies ---
{
  assert(isAbortError(new DOMException('The operation was aborted.', 'AbortError')) === true, 'a DOMException named AbortError is recognized');
  assert(isAbortError(new Error('The operation was aborted.')) === false, 'a plain Error with the same message is not');
  assert(isAbortError(new TypeError('fetch failed')) === false, 'a network failure is not an abort');
}

// --- fetchWithRetry never retries an aborted request ---
{
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      // Simulate undici: fetch with an aborted signal rejects with AbortError.
      throw new DOMException('The operation was aborted.', 'AbortError');
    };
    const controller = registerTurnAbort('chat-d');
    controller.abort();
    try {
      await fetchWithRetry('https://example.invalid/chat/completions', { signal: controller.signal }, 1);
      assert(false, 'an aborted fetch rejects rather than resolving');
    } catch (err) {
      assert(isAbortError(err), 'an aborted fetch rejects with AbortError');
    }
    assert(calls === 1, 'an aborted request is never retried by fetchWithRetry');
    unregisterTurnAbort('chat-d', controller);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- isRetryableLlmError treats a Stop as terminal, not as a transient failure ---
{
  assert(
    isRetryableLlmError(new DOMException('The operation was aborted.', 'AbortError')) === false,
    'an AbortError is never classified retryable (llmGate would otherwise re-fire the stopped call)',
  );
  assert(isRetryableLlmError(new TypeError('fetch failed')) === true, 'a transport failure stays retryable — unchanged behavior');
}

console.log('turn abort verification passed');
