/**
 * @file orchestrator/src/orchestrator/lorebookGate.ts
 * @stamp 2026-08-11
 * @architectural-role Pure Function — lorebook gating (probability, groups, timed effects, budget)
 * @description
 * The §4/§5 gating evaluator of the Lorebook plan (docs/lorebook-plan.md), ported from
 * SillyTavern's world-info.js (`newWorldInfoEntryDefinition` ~line 4002; probability/group logic
 * ~4881–5480) — gating fields only, no keyword matching. It only ever NARROWS the candidate set
 * vector recall already returned; it never looks at message text and can never promote an
 * irrelevant entry into the prompt (§6). Discovery already happened in
 * recallLorebookEntries (io/lorebook/); this function is pure: same (candidates,
 * timedEffectState, turnSeed, tokenBudget, chatMessageCount) → same result, no IO, no
 * Math.random — the plan explicitly calls this out as the property that keeps the probability
 * roll reproducible instead of a prompt-cache-breaking nondeterminism (§4, §17).
 *
 * Gate order (constants > probability > inclusion groups > timed effects > budget trim, per §4):
 *   1. delay — `delay` (N): can't activate until the chat has ≥N messages (§5).
 *   2. sticky — `sticky` (N): once activated, stays active for N further turns without needing to
 *      be rediscovered, and skips the probability re-roll (ST's `entry.sticky ? skip : roll`).
 *      Resolved from lorebook_activation_log via fetchLorebookTimedEffectState: turns_since ≤ N.
 *   3. cooldown — `cooldown` (N): once deactivated, can't reactivate for N turns even if
 *      rediscovered. A sticky-active entry is not deactivated yet, so cooldown never applies to
 *      it. turns_since ≤ N blocks.
 *   4. probability — `use_probability` + a seeded per-turn roll within `probability`% (ST:
 *      `use_probability && roll*100 > probability` skips). Deterministic per §4: `turnSeed` is
 *      derived from the assistant message_id being generated (deriveTurnSeed), never random.
 *   5. inclusion groups — entries sharing a non-empty `group_name` compete: normally only one
 *      member activates per turn, chosen by weighted random over `group_weight` (ST's
 *      filterByInclusionGroups); `group_override` makes a member always win its group outright
 *      instead of rolling. Sticky-active members bypass the competition — they're already in.
 *      Groups are evaluated over whatever discovery returned; a group can't pull in an
 *      irrelevant sibling (§5). weight 0 members effectively never win; all-zero weights roll
 *      uniformly. Single-member groups have nothing to compete for.
 *   6. budget — after gating, entries are added in array order (constants first, then
 *      similarity-rank — the order recallLorebookEntries returns, which IS the §5 budget order)
 *      until `tokenBudget` is spent; the rest are dropped that turn and reported as 'budget' so
 *      they're logged as discovered-but-cut, not silently missing (§5, §11 observability). Token
 *      count uses the repo's ~4-chars/token heuristic (truncateForContext.ts's comment; same as
 *      ensureFirstTurnHeader/cleanupLoop's estimatedTokens).
 *
 * Note: the plan's §4 sketch names only `(candidates, timedEffectState, turnSeed)`; `delay` and
 * the budget trim are impossible to evaluate without `chatMessageCount` and `tokenBudget`, so
 * both are explicit parameters here.
 *
 * @api-declaration
 * gateLorebookCandidates(candidates, timedEffectState, { turnSeed, tokenBudget,
 *   chatMessageCount }) -> LorebookGateResult — activated entries (array order = prompt order)
 *   plus every skipped entry and the reason (delay|cooldown|probability|group|budget).
 * deriveTurnSeed(messageId: string) -> uint32 — deterministic seed from the assistant message_id.
 * estimateLorebookTokens(content: string) -> number — ceil(len/4), the repo's token heuristic.
 *
 * @contract
 *   assertions:
 *     purity:          pure (deterministic given inputs; no IO, no Math.random)
 *     state_ownership: []
 *     external_io:     []
 */

import type { LorebookEntryCandidate } from '../io/lorebook/recallLorebookEntries.js';
import type { LorebookTimedEffectState } from '../io/lorebook/fetchLorebookTimedEffectState.js';

export type LorebookSkipReason = 'delay' | 'cooldown' | 'probability' | 'group' | 'budget';

export interface LorebookGateSkipped {
  entry_id: string;
  reason: LorebookSkipReason;
}

export interface LorebookGateResult {
  /** Entries that fire this turn, in prompt order (array order of `candidates`). */
  activated: LorebookEntryCandidate[];
  /** Every non-activated candidate, in array order, with the gating reason it lost. */
  skipped: LorebookGateSkipped[];
  /** Estimated content tokens of the activated set (the §5 budget consumed). */
  tokenCount: number;
}

export interface LorebookGateOptions {
  /** Deterministic seed for the probability/group rolls — deriveTurnSeed(assistant message_id). */
  turnSeed: number;
  /** `lorebook_token_budget`: max estimated content tokens the resolved entries may consume. */
  tokenBudget: number;
  /** Total message count of the chat (for `delay`: can't activate until chat has ≥N messages). */
  chatMessageCount: number;
}

/** FNV-1a 32-bit — deterministic across platforms (Math.imul), no float rounding. */
export function deriveTurnSeed(messageId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < messageId.length; i++) {
    h ^= messageId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small deterministic PRNG (Math.imul-based, platform-stable). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The repo's ~4-chars/token heuristic (truncateForContext.ts; same as estimatedTokens elsewhere). */
export function estimateLorebookTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

export function gateLorebookCandidates(
  candidates: LorebookEntryCandidate[],
  timedEffectState: LorebookTimedEffectState[],
  options: LorebookGateOptions,
): LorebookGateResult {
  const { turnSeed, tokenBudget, chatMessageCount } = options;
  const rng = mulberry32(turnSeed);

  const stateByEntry = new Map(timedEffectState.map((s) => [s.entry_id, s]));
  const skipped: LorebookGateSkipped[] = [];

  // Pass 1 — per-entry checks in array order (delay, sticky, cooldown, probability).
  const passing: LorebookEntryCandidate[] = [];
  const stickyActive = new Set<string>();
  for (const entry of candidates) {
    const state = stateByEntry.get(entry.entry_id);

    if (entry.delay > 0 && chatMessageCount < entry.delay) {
      skipped.push({ entry_id: entry.entry_id, reason: 'delay' });
      continue;
    }

    const isStickyActive =
      entry.sticky >= 1 && state !== undefined && state.turns_since_activation <= entry.sticky;
    if (isStickyActive) {
      stickyActive.add(entry.entry_id);
      passing.push(entry);
      continue; // ST: `entry.sticky ? skip : roll` — no re-roll, no cooldown (still active).
    }

    if (entry.cooldown >= 1 && state !== undefined && state.turns_since_activation <= entry.cooldown) {
      skipped.push({ entry_id: entry.entry_id, reason: 'cooldown' });
      continue;
    }

    if (entry.use_probability && entry.probability < 100) {
      const roll = rng() * 100;
      if (roll > entry.probability) {
        skipped.push({ entry_id: entry.entry_id, reason: 'probability' });
        continue;
      }
    }

    passing.push(entry);
  }

  // Pass 2 — inclusion groups: at most one NEW member per group, weighted by group_weight.
  // Non-grouped entries and sticky-active members are already winners; grouped entries compete.
  const winners = new Set<string>();
  const groups = new Map<string, LorebookEntryCandidate[]>();
  for (const entry of passing) {
    if (stickyActive.has(entry.entry_id)) {
      winners.add(entry.entry_id);
      continue;
    }
    const name = (entry.group_name || '').trim();
    if (!name) {
      winners.add(entry.entry_id);
      continue;
    }
    const members = groups.get(name);
    if (members) members.push(entry);
    else groups.set(name, [entry]);
  }
  for (const members of groups.values()) {
    if (members.length < 2) {
      winners.add(members[0].entry_id);
      continue;
    }
    const override = members.find((m) => m.group_override);
    let winner: LorebookEntryCandidate;
    if (override) {
      // group_override: this member always wins its group outright, no roll.
      winner = override;
    } else {
      const total = members.reduce((sum, m) => sum + Math.max(0, m.group_weight), 0);
      if (total > 0) {
        let r = rng() * total;
        winner = members[0];
        for (const m of members) {
          r -= Math.max(0, m.group_weight);
          if (r < 0) {
            winner = m;
            break;
          }
        }
      } else {
        // All-zero weights: roll uniformly.
        winner = members[Math.floor(rng() * members.length)];
      }
    }
    for (const m of members) {
      if (m.entry_id === winner.entry_id) winners.add(m.entry_id);
      else skipped.push({ entry_id: m.entry_id, reason: 'group' });
    }
  }

  // Pass 3 — budget trim in array order (constants first, then similarity rank): keep adding
  // until the budget is spent; everything past it is dropped for this turn.
  const activated: LorebookEntryCandidate[] = [];
  let tokenCount = 0;
  for (const entry of candidates) {
    if (!winners.has(entry.entry_id)) continue;
    const tokens = estimateLorebookTokens(entry.content);
    if (tokenBudget >= 0 && tokenCount + tokens > tokenBudget) {
      skipped.push({ entry_id: entry.entry_id, reason: 'budget' });
      continue;
    }
    tokenCount += tokens;
    activated.push(entry);
  }

  return { activated, skipped, tokenCount };
}
