# Archive Completed Plan Docs into docs/plans/completed/

*A process/docs reorg, not a code-architecture plan — filed under roles.md's plan template anyway
since it's mechanical, multi-file work suited to Reasonix, not a Claude Code direct patch (the
move touches ~90 source-comment references; getting even one wrong leaves a dangling path in a
file nobody's looking at).*

## Goal

`docs/plans/` currently mixes active plans (still being built against) with plans that shipped
months ago, with no way to tell which is which except reading each file's own status line — and
several of those status lines are themselves wrong (say "planned, not yet implemented" for
features `git log` shows were built weeks ago). Split it into `docs/plans/` (active) and
`docs/plans/completed/` (shipped, kept for reference — this is *not* the delete-on-completion
`docs/roles.md` now specifies for `-repair.md` docs; a `-plan.md` documents an architectural
decision and stays valuable after it ships) — and while moving each file, fix its status header to
say what actually happened instead of what was still true when it was last edited.

The hard part isn't the move — it's that this codebase cites plan docs by literal path from
inside the code that resulted from them (e.g. `orchestrator/src/io/llm/llmBackoff.ts` cites
`docs/plans/completed/llm-gate-plan.md §4.2`). A naive `git mv` orphans every one of those pointers. This
plan's Logic section is entirely about doing the move without breaking any of them.

## Files

**Move into `docs/plans/completed/`** (verified complete — see the Logic section's per-file notes
for what "verified" meant for each):
- `chat-fade-mask-plan.md`
- `chub-lorebook-import-plan.md`
- `llm-gate-plan.md`
- `prompt-inspector-tag-tree.md`
- `rag-dynamic-cutoff-plan.md`
- `dedicated-infra-plan.md`
- `rp-streaming-plan.md` — status header also needs correcting (see Logic)
- `in-stream-cleanup-plan.md` — status header also needs correcting
- `httpserver-breakdown-plan.md` — status header also needs correcting
- `prompt-inspector-usage-cost.md` — status header also needs correcting

**Leave in `docs/plans/`, untouched** (confirmed still active — do not move these, and don't
trust a top-line "Status: built" without reading the rest of the file the way this plan's own
research had to for `turn-loop-plan.md` and `prompt-macros.md` below):
- `prompt-macros.md` — only Stage 1 is live; Stages 2-3 are explicitly still pending (Stage 3
  gated on Triggeryze, which isn't built).
- `turn-loop-plan.md` — despite its own "Status: built, verified" line, §"Sync trigger" contains
  an explicit unresolved item ("Open, still needs an answer... Flagged twice earlier in this
  conversation, not yet resolved — needs answering before step 6 is buildable"). Not done.
- `bigimagine-backup-plan.md` — explicitly `(designed)`, "nothing in this document is
  implemented yet."
- `reasoning-blocks-plan.md` — not started.

**Needs its own audit before any move decision — do not move on this pass**:
- `docs/plans/vistalyze_integration/` (7 files: `cleanup_prompt.md`, `describer.md`,
  `endpoint.md`, `location.md`, `location_status.md`, `parallax_fade_teststep.md`, `segway.md`).
  30 source-code citations total, clearly real shipped code behind at least some of them
  (`generateLocationImage.ts`, `LocationsView.tsx`, `chatMemorySync.ts`'s location/presence
  scraper) — but `docs/bootstrap.md`'s own "Current state" section says Vistalyze is still
  `(designed)`, not built. Those two facts conflict, and this plan doesn't resolve which is
  right. Audit each of the 7 files individually (does the feature it describes actually exist and
  work, the way this plan's own research checked `turn-loop-plan.md` line by line rather than
  trusting its header) before deciding whether any of them move, and flag the `bootstrap.md`
  discrepancy back rather than silently resolving it either direction.

**Update references in** (every file returned by `grep -rl 'docs/plans/<name>.md'` across
`orchestrator/src`, `frontend/src`, `plugins`, and `docs` for each of the 10 files being moved —
run the grep fresh at implementation time rather than trusting the list below, since more
references may land between this plan being written and Reasonix picking it up):
- `docs/bootstrap.md`, `docs/verification.md` — both cite moved docs directly.
- Every `orchestrator/src/**/*.ts`, `frontend/src/**/*.ts(x)`, `plugins/**/*.ts` file with a
  comment citing one of the 10 paths above (roughly 90 occurrences across ~35 files as of this
  writing — `llmBackoff.ts`, `llmRetryClassify.ts`, `llmGate.ts`, `llmQueue.ts`,
  `assemblePromptStack.ts`, `resolveLorebook.ts`, `commonPrefix.ts`, `sectionStability.ts`,
  `promptTagTree.ts`, `promptPreview.ts`, `promptTrace.ts`, `types.ts` (orchestrator llm),
  `httpServer.ts`, `httpUtils.ts`, `handleAdminMisc.ts`, `handleAdminDisplaySettings.ts`,
  `handleAdminConnections.ts`, `handleAdminLorebooks.ts`, `handleChatCompletions.ts`,
  `handleChats.ts`, `turnExecution.ts`, `streamingTurn.ts`, `cleanupLoop.ts`, `liveCleanup.ts`,
  `cleanupLiveStatus.ts`, `orchestratorSettings.ts`, `recallCutoff.ts`, `recallChunkLane.ts`,
  `recallFactLane.ts`, `recallForPrompt.ts`, `adminServer.ts`, `loop.ts`,
  `PromptInspectorPanel.tsx` among them).

## Logic

**The move, per file**: `git mv docs/plans/<name>.md docs/plans/completed/<name>.md`, then
`grep -rl "docs/plans/<name>.md" orchestrator/src frontend/src plugins docs | xargs sed -i
"s|docs/plans/<name>.md|docs/plans/completed/<name>.md|g"` (or the equivalent one file at a time —
the point is every citing file gets the same mechanical substitution, not a hand-edit that could
drift from the actual new path). Verify after each file: `grep -rn "docs/plans/<name>.md"
orchestrator/src frontend/src plugins docs` returns nothing (every reference now says
`docs/plans/completed/<name>.md`).

**Status-header corrections**, for the four files whose header currently understates what shipped
(each verified against `git log --oneline` for the feature, not just re-asserted):
- `rp-streaming-plan.md`: header says *"Status: planned, not yet implemented."* Commit
  `b59113d` ("rp streaming: live SSE turns for RP chats end to end") shipped it. Change to
  something in `rag-dynamic-cutoff-plan.md`'s own style: state what's built, cite the commit,
  keep the rest of the doc's content (the design reasoning) exactly as written.
- `in-stream-cleanup-plan.md`: header says *"planned, not yet implemented."* Commits `95714a0`
  ("in-stream cleanup... live header/body/footer repair during streaming") and `deb88a5`
  ("in-stream cleanup validation fixes") shipped it.
- `httpserver-breakdown-plan.md`: header says *"planned, not started."* Eight `httpServer
  breakdown step N` commits (steps 1-8, the last being `d18400c` "dispatcher if-chain -> route
  table (final step)") shipped it in full.
- `prompt-inspector-usage-cost.md`: header says *"planned, not yet implemented."* Commit
  `c88d1ea` ("Prompt Inspector usage cost receipt... (0089)") shipped it.

Don't touch the body of any of these four beyond the status line — the reasoning inside is still
the accurate record of why the feature looks the way it does, same as every other moved doc.

**`chub-lorebook-import-plan.md`'s "Open questions" section**: leave it as-is when moving. Those
are documented design choices flagged for future reconsideration, not evidence the plan is
incomplete — the feature it describes shipped (the now-deleted `chub-lorebook-embed-repair.md`
called it "the landed implementation" when filing a follow-up against it). Completed docs can
still carry open questions; that's different from an unbuilt step.

**Create `docs/plans/completed/` itself** as part of the first file's move — no separate empty-dir
commit needed, `git mv` into a nonexistent directory creates it.

## Edge Cases

- A source file citing a moved doc **without** the `.md` extension in a link/prose form the sed
  substitution wouldn't catch (e.g. a bare `llm-gate-plan` mention with no `docs/plans/` prefix,
  if any exist) — the verification grep in Logic only checks the literal `docs/plans/<name>.md`
  string; a broader `grep -rn "<name>"` sweep per moved file is worth one extra pass to catch
  anything the mechanical substitution missed.
- A doc citing another **moved** doc from inside its own body (e.g. if `rag-dynamic-cutoff-plan.md`
  ever references `llm-gate-plan.md` by path) — these get the same substitution as any other
  citing file; run the grep/sed pass across `docs/` itself too, not just source code.
- `docs/bootstrap.md`'s Vistalyze status claim conflicting with the code evidence (see the
  vistalyze_integration audit note above) — don't silently fix `bootstrap.md` to match either
  belief as a side effect of this plan; flag it back for a separate decision.

## Tests

- After the moves: `grep -rn "docs/plans/\(chat-fade-mask-plan\|chub-lorebook-import-plan\|llm-gate-plan\|prompt-inspector-tag-tree\|rag-dynamic-cutoff-plan\|dedicated-infra-plan\|rp-streaming-plan\|in-stream-cleanup-plan\|httpserver-breakdown-plan\|prompt-inspector-usage-cost\)\.md" orchestrator/src frontend/src plugins docs` returns **zero** matches outside `docs/plans/completed/` itself (i.e. no source file still points at the old, now-nonexistent path).
- `ls docs/plans/completed/` shows exactly the 10 files listed above, no more, no less.
- `docs/plans/` (top level, excluding `completed/` and `vistalyze_integration/`) still contains
  `prompt-macros.md`, `turn-loop-plan.md`, `bigimagine-backup-plan.md`, `reasoning-blocks-plan.md`
  — confirming nothing active got swept up by mistake.
- `npm run build` / `tsc --noEmit` in both `orchestrator` and `frontend` still pass — this is a
  comment-only change, but it's cheap insurance that a stray sed match never touched executable
  code by accident.

## Out of Scope

- Moving or auditing anything under `docs/plans/vistalyze_integration/` — flagged above as needing
  its own audit against the `bootstrap.md` discrepancy, not decided here.
- Advancing `prompt-macros.md` to Stage 2/3, resolving `turn-loop-plan.md`'s open sync-boundary
  question, or building anything in `bigimagine-backup-plan.md` — this plan only reorganizes
  finished work, it doesn't finish anything.
- Any change to `docs/roles.md` (already updated separately with the `-repair.md` vs `-plan.md`
  naming/disposal distinction this plan's own framing relies on).
- Deleting anything — this plan only moves and re-points references. Nothing here is disposable
  the way a `-repair.md` doc is.

## Principles / Conventions in Play

- This is a docs/process change, not code — `bi_principles.md`'s Four Kinds of Code and file-size
  budget don't apply. The one principle in play is implicit in why this plan exists at all: a
  citation like `docs/plans/completed/llm-gate-plan.md §4.2` inside a comment is only trustworthy if the
  path still resolves — this plan's entire Logic section exists to keep that true across the move,
  which is the same "don't let documentation quietly go stale" concern `bi_principles.md` §11
  applies to logging, applied here to cross-references instead.
