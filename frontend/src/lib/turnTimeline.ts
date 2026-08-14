/**
 * @file frontend/src/lib/turnTimeline.ts
 * @stamp 2026-08-14
 * @architectural-role Stateful Owner (bi_principles.md §8) — exactly one recorder instance per RP
 * turn, created by ChatView, owned by nobody else
 * @description
 * The client-side Timing recorder (docs/plans/llm-stats-page-plan.md). One instance per RP
 * send/regenerate: marks elapsed-ms milestones against that turn's dispatch instant, dispatches a
 * real window CustomEvent ('bigimagine:turn-event') at each so devtools can listen without
 * touching app code (same spirit as Loggeryze's window.loggeryze.time()), and — once the awaited
 * API call resolves or throws — finalizes the record and POSTs it to
 * /v1/turn-display-metrics fire-and-forget (a metrics write must never fail the user's turn).
 *
 * What gets marked, per the plan's Logic section:
 *   - dispatch        — t0, the instant before the turn's API call.
 *   - first-token     — the first onDelta; display-land is then scheduled for the next
 *                       requestAnimationFrame (wire arrival vs. actual paint).
 *   - last-token      — NOT predicted live: read back at finalize from a running "most recent
 *                       delta" timestamp (you can't know a delta is the last until the stream
 *                       resolves). One buffered chunk (turn 1, no-completeStream connections)
 *                       makes first- and last-token the same instant, which is correct.
 *   - cleanup-start/stop, per region — derived from bigimagine_cleanup frame state transitions
 *                       (in-flux = start, deployed/flagged = stop). Body can cycle more than once;
 *                       the recorder keeps the FIRST start and the LAST stop (the outer span),
 *                       per the plan's deliberate compression choice. A region that never leaves
 *                       not-called never fires either event.
 *   - stop             — user-initiated abort (Stop button, or the abort-flavored terminal
 *                       frame); distinct from natural completion.
 *   - display-settle   — the instant the awaited call resolves (the server has sent every patch
 *                       before [DONE], so this single client-observed moment is already "nothing
 *                       can silently change again").
 *
 * The assistant message's id is only read at finalize (from the resolved return value — it's not
 * needed for any mark), and stays null in the event details until then. A turn that fails before
 * its first delta has no message id at all, so nothing identifiable can be posted — the record
 * is dropped rather than posted with a fabricated id.
 *
 * @api-declaration
 * new TurnTimeline({ chatId, apiKey })
 *   dispatch()                 — t0; call immediately before the API call
 *   onDelta()                  — every content delta (first one also schedules display-land)
 *   cleanupState(region, state) — each bigimagine_cleanup frame
 *   stop()                     — Stop button pressed / abort terminal frame observed
 *   finalize(outcome, messageId?) — resolve or throw; emits last-token + display-settle and POSTs
 *   getSnapshot()              — the drawer's "last turn" wire (docs/plans/turn-timeline-graph-plan.md):
 *                                the same record persist() builds, without the messageId gate
 *
 * @contract
 *   assertions:
 *     purity:          impure (window events, requestAnimationFrame, fetch)
 *     state_ownership: [the in-flight record's milestone fields]
 *     external_io:     [window dispatchEvent, requestAnimationFrame, POST /v1/turn-display-metrics]
 */

import { postTurnDisplayMetrics } from '../api/client';
import type { CleanupRegionState, TurnDisplayMetricsInput, TurnTimelineEventDetail } from '../api/types';
import type { TurnTimingFields } from './turnTimelineReport';

export type TimelineRegion = 'header' | 'body' | 'footer';
export type TimelineOutcome = 'ok' | 'aborted' | 'error';

interface TurnTimelineOptions {
  chatId: string;
  apiKey: string | null;
}

const EVENT_NAME = 'bigimagine:turn-event';

interface RegionTiming {
  start: number | null;
  stop: number | null;
}

export class TurnTimeline {
  private readonly chatId: string;
  private readonly apiKey: string | null;
  private readonly startedAt = performance.now();
  private readonly dispatchAt = new Date();
  private messageId: string | null = null;
  private firstTokenAt: number | null = null;
  private lastDeltaAt: number | null = null;
  private displayLandAt: number | null = null;
  private displaySettleAt: number | null = null;
  private readonly regions: Record<TimelineRegion, RegionTiming> = {
    header: { start: null, stop: null },
    body: { start: null, stop: null },
    footer: { start: null, stop: null },
  };
  private outcome: TimelineOutcome | null = null;
  private terminatedAt: number | null = null;
  private done = false;
  private dispatched = false;

  constructor(options: TurnTimelineOptions) {
    this.chatId = options.chatId;
    this.apiKey = options.apiKey;
  }

  private emit(event: TurnTimelineEventDetail['event'], region?: TimelineRegion): void {
    window.dispatchEvent(
      new CustomEvent<TurnTimelineEventDetail>(EVENT_NAME, {
        detail: {
          messageId: this.messageId,
          event,
          ...(region ? { region } : {}),
          tsMs: Math.round(performance.now() - this.startedAt),
        },
      }),
    );
  }

  /** t0 — call the instant before chatCompletion()/swipeMessage(), before any await. */
  dispatch(): void {
    this.dispatched = true;
    this.emit('dispatch');
  }

  /** Every content delta. The first one marks first-token and schedules display-land for the next
   *  paint; every one updates the "most recent delta" timestamp that last-token reads back. */
  onDelta(): void {
    this.lastDeltaAt = Math.round(performance.now() - this.startedAt);
    if (this.firstTokenAt !== null) return;
    this.firstTokenAt = this.lastDeltaAt;
    this.emit('first-token');
    requestAnimationFrame(() => {
      if (this.done) return; // the turn resolved before the next paint — no land mark to fabricate
      this.displayLandAt = Math.round(performance.now() - this.startedAt);
      this.emit('display-land');
    });
  }

  /** One bigimagine_cleanup status frame. in-flux opens a region (first start wins); deployed or
   *  flagged closes it (last stop wins) — body's multiple repair cycles compress to one outer
   *  span, the plan's deliberate simplification. */
  cleanupState(region: TimelineRegion, state: CleanupRegionState): void {
    if (this.done) return;
    const timing = this.regions[region];
    if (state === 'in-flux' && timing.start === null) {
      timing.start = Math.round(performance.now() - this.startedAt);
      this.emit('cleanup-start', region);
    } else if ((state === 'deployed' || state === 'flagged') && timing.stop === null) {
      timing.stop = Math.round(performance.now() - this.startedAt);
      this.emit('cleanup-stop', region);
    }
  }

  /** User-initiated abort: the Stop button, or the abort-flavored bigimagine_error terminal
  *   frame. Distinct from natural completion; finalize() still runs when the call resolves.
  *   Idempotent — both the Stop button and the terminal frame can mark it, first one wins. */
  stop(): void {
    if (this.done || this.terminatedAt !== null) return;
    this.terminatedAt = Math.round(performance.now() - this.startedAt);
    this.emit('stop');
  }

  /** The awaited call resolved (messageId from its return value) or threw. Emits last-token
   *  (retroactive read-back) and display-settle, then POSTs the record fire-and-forget. */
  finalize(outcome: TimelineOutcome, messageId?: string | null): void {
    if (this.done) return;
    this.done = true;
    this.outcome = outcome;
    if (messageId) this.messageId = messageId;
    if (this.lastDeltaAt !== null) this.emit('last-token');
    this.displaySettleAt = Math.round(performance.now() - this.startedAt);
    this.emit('display-settle');
    void this.persist().catch(() => {
      // Fire-and-forget (io/turnMetrics.ts's convention): a failed metrics write means that turn
      // is missing from Timing stats, nothing else — never an unhandled rejection.
    });
  }

  /** The drawer's "last turn" wire (docs/plans/turn-timeline-graph-plan.md): the timing fields
   *  as they stand, built by the same shared builder persist() uses — but without persist()'s
   *  messageId gate, because the chart is a local, ephemeral UI read, not a thing being posted
   *  anywhere. There's no reason to withhold it just because the turn failed too early to have
   *  produced an id. undefined only when the turn never dispatched at all (unreachable in
   *  practice — ChatView calls this only after finalize()). */
  getSnapshot(): TurnTimingFields | undefined {
    if (!this.dispatched) return undefined;
    return this.buildTimingFields();
  }

  /** The *_ms record as it stands — null for every field never reached, exactly the shared
   *  TurnTimingFields shape persist() posts and the drawer's Gantt renders from. */
  private buildTimingFields(): TurnTimingFields {
    return {
      firstTokenMs: this.firstTokenAt,
      lastTokenMs: this.lastDeltaAt,
      displayLandMs: this.displayLandAt,
      displaySettleMs: this.displaySettleAt,
      headerStartMs: this.regions.header.start,
      headerStopMs: this.regions.header.stop,
      bodyStartMs: this.regions.body.start,
      bodyStopMs: this.regions.body.stop,
      footerStartMs: this.regions.footer.start,
      footerStopMs: this.regions.footer.stop,
      terminatedAtMs: this.terminatedAt,
    };
  }

  private async persist(): Promise<void> {
    // No message id = failed before the first delta; nothing identifiable to store. Dropped.
    if (!this.messageId) return;
    const body: TurnDisplayMetricsInput = {
      chatId: this.chatId,
      messageId: this.messageId,
      dispatchAt: this.dispatchAt.toISOString(),
      outcome: this.outcome ?? 'error',
    };
    // Same fields the shared builder produced — only the reached ones (numbers, not nulls) are
    // posted; a never-reached field is omitted entirely, never sent as a zero (the API type
    // says optional for exactly this reason).
    const timing = this.buildTimingFields();
    const timingKeys: (keyof TurnTimingFields)[] = [
      'firstTokenMs',
      'lastTokenMs',
      'displayLandMs',
      'displaySettleMs',
      'headerStartMs',
      'headerStopMs',
      'bodyStartMs',
      'bodyStopMs',
      'footerStartMs',
      'footerStopMs',
      'terminatedAtMs',
    ];
    for (const key of timingKeys) {
      const value = timing[key];
      if (typeof value === 'number') body[key] = value;
    }
    await postTurnDisplayMetrics(body, this.apiKey);
  }
}
