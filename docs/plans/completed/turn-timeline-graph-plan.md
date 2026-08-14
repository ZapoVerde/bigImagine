# Turn Timeline Graph

## Goal

Give the timing data `turn_display_metrics` already records (docs/plans/llm-stats-page-plan.md) a
proper visual breakdown of *one turn's* timeline — a horizontal waterfall/Gantt chart, one row per
phase, each bar spanning its own start→stop in milliseconds-since-dispatch, with dashed vertical
lines at the instant milestones (first token, last token, display-land, display-settle, abort) —
the same idea as SillyTavern-Loggeryze's "last turn" chart. Two places get it:

1. **The RP chat's left-hand drawer** — a live, zero-fetch "last turn" readout right next to the
   Prompt Inspector, showing the turn you just watched happen. Both the Prompt Inspector and this
   new Timing section become independently collapsible, so neither forces the other open.
2. **The admin Stats page's Timing section** — a "Turn graph" mode alongside the existing grouped
   bar-list, toggling between one selected historical turn and an averaged waterfall across the
   current filter/lookback window.

Scoped to the main RP turn only — no chunk-summary/sync/background-call correlation (per
discussion: those don't share the same timing-impact story, and `turn_display_metrics` never
recorded them in the first place). No backend changes: every field this needs already exists
(`turn_display_metrics`'s columns, and `PromptPreview`'s `main` group `usage`/`price` for the cost
line) — this is a frontend-only plan.

## Files

- `frontend/src/lib/turnTimelineReport.ts` — created — the shared pure report-builder (see Logic
  and Contracts). Both consumers (the drawer and the Stats page) build off this, so the row/
  milestone definitions live in exactly one place.
- `frontend/src/lib/promptReceipt.ts` — created — the `$`-figure receipt math, extracted verbatim
  from `PromptInspectorPanel.tsx`'s private `computeReceiptCost`; imported by both that panel and
  the new Timing section's cost line (see the TurnDrawerSection entry below).
- `frontend/src/components/timeline/TurnGanttChart.tsx` — created — pure rendering component: a
  `TurnTimelineReport` in, one labeled row per phase out, each a CSS-positioned floating bar (no
  charting library — `left%`/`width%` against the report's own total span, the same no-library
  approach `StatBarList.tsx` already established), dashed vertical milestone lines, native `title`
  tooltips for exact ms/duration on hover.
- `frontend/src/components/timeline/TurnGanttChart.css` — created.
- `frontend/src/lib/turnTimeline.ts` — modified — `TurnTimeline` gains `getSnapshot()`, refactoring
  the record-building logic already in `persist()` into a shared internal builder both use (see
  Logic — `getSnapshot()`'s requirements differ slightly from `persist()`'s).
- `frontend/src/views/ChatView.tsx` — modified — after each `timeline.finalize(...)` (send and
  swipe paths both), capture `timeline.getSnapshot()` into new state and thread it down through
  Sidebar to the new drawer section.
- `frontend/src/components/sidebar/Sidebar.tsx` — modified — the `case 'rp':` branch renders both
  the Prompt Inspector and the new Timing section as siblings inside the same drawer.
- `frontend/src/components/promptInspector/PromptInspectorPanel.tsx` — modified — its content
  (everything below the header) moves inside its own collapsible wrapper, independent of the
  whole-sidebar collapse arrow that already exists. Default open (it's the established, primary
  reason to open this drawer).
- `frontend/src/components/timeline/TurnDrawerSection.tsx` — created — the new collapsible "Timing"
  section mounted alongside the Prompt Inspector: a header with its own collapse toggle (default
  **collapsed** — new, opt-in, shouldn't push the established panel around for someone who hasn't
  asked for it), a one-line cost summary, and a `TurnGanttChart` fed by the live snapshot. Fetches
  its own cost line via `getPromptPreview` (same call Prompt Inspector already makes, reading only
  the `main` group's `usage`/`price`) — deliberately not sharing Prompt Inspector's fetch, so the
  two sections stay fully independent of each other's collapsed/expanded state (see Logic). The
  `$`-figure arithmetic must not be re-implemented here: `PromptInspectorPanel.tsx`'s private
  `computeReceiptCost` moves to a shared pure helper (e.g. `frontend/src/lib/promptReceipt.ts`),
  and both panels import it — the receipt math lives in exactly one place, same as the row
  definitions in `turnTimelineReport.ts`.
- `frontend/src/components/timeline/TurnDrawerSection.css` — created.
- `frontend/src/components/sidebar/Sidebar.css` — modified — layout for two stacked collapsible
  sections in place of the one unconditional panel.
- `frontend/src/views/StatsView.tsx` — modified — the Timing section gains a mode toggle
  ("Grouped bars" — the existing view, default — / "Turn graph"). Inside "Turn graph": a further
  toggle ("Last turn" / "Averages") plus, only in "Last turn" mode, a turn picker built from the
  already-loaded `turns` array. No new fetches — both modes work off data the section already has.
- `frontend/src/views/StatsView.css` — modified — styling for the new toggles/picker.

## Logic

**Report shape and row/milestone definitions** (`turnTimelineReport.ts`): six possible rows —
`waiting` (dispatch=0 → firstTokenMs), `streaming` (firstTokenMs → lastTokenMs), `header`/`body`/
`footer` (their own start/stop pairs — these can and do overlap `streaming`, which a Gantt chart
handles natively by being separate rows, not a special case), `finalizing` (lastTokenMs →
displaySettleMs — the exact previously-invisible tail this whole feature started from). A row only
appears when *both* its ends are known numbers — never a zero-width or open-ended bar. Five
possible milestones, each an instant, not a span: `first-token`, `last-token`, `display-land`,
`display-settle`, `terminated` (the abort point, when present — rendered visually distinct, e.g. a
red dashed line, from the other four). `totalMs` (the chart's x-axis span) is the max of every
present row-stop and milestone value.

**`buildTurnTimelineReport(record)`** — one turn's fields in, one report out (or `null` when the
record has nothing to show at all — e.g. a turn that aborted before its first delta). Straight
field mapping, no aggregation.

**`buildAverageTurnTimelineReport(records)`** — same output shape, built by averaging each row's
`startMs` and `stopMs` *independently* across whichever turns in the input actually reached that
field (reusing `aggregateRows.ts`'s existing `meanOf`, which already excludes nulls and returns
null rather than zero for an all-null column) — **not** a cursor-accumulated duration stack. This
matters because the phases here overlap (unlike Loggeryze's strictly-sequential five phases, whose
own average chart accumulates durations end-to-end precisely because they never overlap) —
averaging absolute ms-from-dispatch positions directly is what keeps the averaged chart's row
overlaps visually honest. A phase no turn in the filtered set ever reached is simply absent from
the averaged report, same "omit, don't fabricate" rule as everywhere else in this feature.

Averaging is strictly **per-kind**: each row averages only turns that reached that row, and each
milestone's `atMs` averages only turns that reached that milestone (`meanOf` over that field, the
same as rows — e.g. averaged `terminated` is the mean over aborted turns only). No value from one
kind ever mixes into another kind's average. A row whose independently-averaged `startMs` ≥
`stopMs` (the two populations can differ — see Edge Cases) is omitted rather than rendered as an
inverted/negative-width bar.

**`TurnGanttChart`** — one row per report row, label on the left, a track on the right; the bar's
`left`/`width` are percentages of `totalMs`, so it scales with container width at any screen size
(§18) with no fixed pixel math. Milestones are absolutely-positioned dashed vertical lines spanning
the track's full height. An empty `rows` array (a turn that dispatched but never got a first token)
renders a "no timing data reached" state, not a blank chart.

**`TurnTimeline.getSnapshot()`** — the live wire for the drawer's "last turn" view. `persist()`
already builds a `TurnDisplayMetricsInput`-shaped record from the instance's accumulated marks;
extract that construction into a shared internal builder. `getSnapshot()` calls the same builder
but, unlike `persist()`, does **not** require a `messageId` to return something — the chart is a
local, ephemeral UI read, not a thing being posted anywhere, so there's no reason to withhold it
just because the turn failed too early to have produced an id. Returns `undefined` only when the
turn never dispatched at all (shouldn't be reachable in practice, since `ChatView` only ever calls
this after `finalize()`).

**Drawer independence.** The Prompt Inspector's and the new Timing section's collapsed/expanded
states are two independent `useState`s (plain in-memory, not persisted — matching how the
whole-sidebar `collapsed` flag in `App.tsx` already works; no existing collapse state in this app
persists across a reload, so this doesn't introduce a new pattern). Collapsing one must never stop
the other from loading its own data — this is why the Timing section gets its own `getPromptPreview`
call rather than sharing Prompt Inspector's, even though it's a small duplicate request when both
happen to be open at once.

**Stats page "Turn graph" mode.** "Last turn": the picker lists the currently filtered `turns`
array (same outcome chips + days lookback the grouped-bars mode already respects), newest first,
each option labeled with local time, a short chat id prefix, and outcome; defaults to the newest
entry. Changing the outcome chips or days lookback re-filters the picker's options — if the
previously selected turn falls out of the new filtered set, selection falls back to the new set's
newest entry rather than pointing at a turn no longer listed. "Averages" needs no picker — it
always reflects the full currently-filtered set.

## Contracts

```
interface TurnTimelineRow {
  key: 'waiting' | 'streaming' | 'header' | 'body' | 'footer' | 'finalizing';
  label: string;      // 'Waiting for first token' / 'Streaming' / 'Header repair' / …
  startMs: number;
  stopMs: number;
}

interface TurnTimelineMilestone {
  key: 'first-token' | 'last-token' | 'display-land' | 'display-settle' | 'terminated';
  label: string;
  atMs: number;
}

interface TurnTimelineReport {
  rows: TurnTimelineRow[];              // only rows with both ends known
  milestones: TurnTimelineMilestone[];  // only milestones that were reached
  totalMs: number;                      // chart x-axis span
}

buildTurnTimelineReport(record: TurnTimingFields): TurnTimelineReport | null
buildAverageTurnTimelineReport(records: TurnTimingFields[]): TurnTimelineReport | null
// TurnTimingFields = the *_ms subset TurnDisplayMetricRow and TurnDisplayMetricsInput share —
// identical field names, differing only in nullability (row: number | null, input: number |
// undefined). A single structural type with number | null | undefined per field accepts both, so
// no new exported type is needed; it's just the intersection of the two.
```

```
TurnTimeline.getSnapshot(): TurnDisplayMetricsInput['<*_ms fields>'] | undefined
```

## Edge Cases

- A row with only a start or only a stop, never both — omitted, never a fabricated zero-width or
  open-ended bar (same rule the original plan already applies to `cost_usd`/etc.).
- Averaging over a filtered set where zero turns ever reached a given phase (e.g. no cleanup ran
  in the whole window) — that row is absent from the averaged chart entirely.
- Averaging over exactly one filtered turn — reduces to that turn's own values (`meanOf` of a
  length-1 array), no special-casing needed.
- A per-kind averaged row whose mean `startMs` ≥ mean `stopMs` — the start and stop means come
  from different turn populations (a turn that started a phase may be one that never finished it,
  and vice versa), so a late-starting/early-stopping minority can invert the average. That row is
  omitted (never a negative-width bar), same omit-don't-fabricate rule.
- The live drawer before any turn has completed this session — its own empty state ("send a turn
  to see its timing"), not an error or a blank chart.
- A turn that aborted before its first delta (`getSnapshot()` returns dispatch-only data) — the
  Gantt shows the "no timing data reached" state (empty rows), still distinct from the "no turn
  yet" empty state.
- `terminated` always renders as a milestone line, never a row — it's an abort instant, not a span.
- Stats page turn picker: selection must track the filtered set, never point at a turn the current
  filters have excluded (see Logic).
- Collapsing either drawer section must never block or delay the other's own fetch/render.

## Tests

Frontend has no automated test runner (`npm run check` = `tsc --noEmit` only, same as
`aggregateRows.ts` before it) — verification here is `tsc` passing plus manual QA:

- `buildTurnTimelineReport`/`buildAverageTurnTimelineReport`: sanity-check by hand against a few
  representative `turn_display_metrics` rows (full turn, aborted-before-first-token, one with no
  cleanup at all) — confirm the omit-don't-fabricate rule holds and `totalMs` matches the true max.
- Send a real RP turn and confirm the drawer's Timing section renders a sensible waterfall
  matching what actually happened (streaming duration roughly matches perceived reply time, a
  cleanup repair pass shows as an overlapping row on top of streaming/finalizing).
- Collapse/expand both drawer sections independently — confirm neither's content or fetch depends
  on the other's state.
- On the Stats page, toggle into "Turn graph" mode, switch Last turn ↔ Averages, and change the
  days/outcome filters while a turn is selected — confirm the picker's fallback behavior (Edge
  Cases) actually holds instead of pointing at a stale, filtered-out turn.

## Out of Scope

- Any correlation with `llm_calls` (chunk summaries, chat-memory sync, background descriptions) in
  either chart — main RP turn timing only, per the scoping discussion.
- A charting library — this stays consistent with the rest of the Stats work's no-library, CSS-only
  approach.
- Persisting the drawer sections' collapsed/expanded state across a reload — no existing UI state
  in this app does that today, so this doesn't introduce the pattern for one new spot.
- An "averages" mode in the live in-chat drawer — the drawer's Timing section is last-turn-only,
  live and zero-fetch by design; historical averaging is the Stats page's job.
- New backend endpoints, migrations, or columns — everything this needs already exists.

## Principles / Conventions in Play

- §18 (Mobile-First) — the Gantt rows use percentage-based positioning, no fixed pixel widths, so
  they hold up at phone width the same way `StatBarList` already does.
- §8 (The Four Kinds of Code) — `turnTimelineReport.ts` is a Pure Function module, kept separate
  from `TurnGanttChart.tsx` (a rendering component) and `TurnDrawerSection.tsx`/`ChatView.tsx`
  (Stateful Owners/Orchestrators that fetch and hold the data it's fed).
- §11 (Observability is Not an Afterthought) — this is the same principle the original Timing
  section was built for, now made visible at the point where it's most useful: right where the
  turn just happened, not only in a separate admin page.
