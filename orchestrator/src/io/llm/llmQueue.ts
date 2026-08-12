/**
 * @file orchestrator/src/io/llm/llmQueue.ts
 * @stamp 2026-08-06
 * @architectural-role Stateful Owner — in-process FIFO admission with a per-lane concurrency cap
 * @description
 * docs/plans/completed/llm-gate-plan.md §4.1/§4.4: bounds how many complete() calls run against the provider at
 * once, so a burst (a multi-character turn's several calls, a sync tick, a canon-extraction pass
 * all landing together) can't saturate a rate limit. Three lanes, per §6's resolved open question —
 * separate concurrency for 'agent_routine' and for 'system'-kind background work ('cleanup'/'chat
 * memory sync'/'title generation') vs a live interactive turn, so a background loop's burst can
 * never delay an interactive turn the household is waiting on, the same "an unattended routine's
 * budget should never be able to interrupt the household's own chat" reasoning llmGate.ts's own
 * doc comment already applies to caps, extended here to concurrency.
 *
 * In-memory only, per-process — matches how every existing caller already tolerates a restart
 * (bb_principles.md's own "not a distributed queue" scoping in the plan doc): a queued call just
 * waits its turn within the current process's lifetime, nothing here needs to survive a bounce.
 *
 * Module-level state (the two lanes' in-flight counts and waiter queues), same shape as
 * callContext.ts's own module-level AsyncLocalStorage instance — this is the one place this
 * runtime memory lives.
 *
 * @api-declaration
 * type LlmLane = 'interactive' | 'agent_routine'
 * withLaneSlot(lane, maxConcurrent, fn) -> Promise<T> — runs fn() once a slot in `lane` is free
 *   (immediately if under maxConcurrent, otherwise FIFO-queued), releasing the slot when fn
 *   settles either way
 *
 * @contract
 *   assertions:
 *     purity:          impure (owns in-memory queue state)
 *     state_ownership: [per-lane in-flight counters and FIFO waiter lists]
 *     external_io:     []
 */

export type LlmLane = 'interactive' | 'agent_routine' | 'background';

interface LaneState {
  inFlight: number;
  waiters: Array<() => void>;
}

function makeLaneState(): LaneState {
  return { inFlight: 0, waiters: [] };
}

const lanes: Record<LlmLane, LaneState> = {
  interactive: makeLaneState(),
  agent_routine: makeLaneState(),
  background: makeLaneState(),
};

function acquire(lane: LlmLane, maxConcurrent: number): Promise<void> {
  const state = lanes[lane];
  if (state.inFlight < maxConcurrent) {
    state.inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    state.waiters.push(() => {
      state.inFlight++;
      resolve();
    });
  });
}

function release(lane: LlmLane): void {
  const state = lanes[lane];
  state.inFlight--;
  const next = state.waiters.shift();
  if (next) next();
}

export async function withLaneSlot<T>(lane: LlmLane, maxConcurrent: number, fn: () => Promise<T>): Promise<T> {
  await acquire(lane, maxConcurrent);
  try {
    return await fn();
  } finally {
    release(lane);
  }
}
