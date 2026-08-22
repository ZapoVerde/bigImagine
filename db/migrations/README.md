# Migrations

Mounted straight into the Postgres container as `/docker-entrypoint-initdb.d` (see
`docker-compose.yml`), so these run once, in filename order, only against a fresh volume:

- `0001_create_app_role.sh` — creates the non-superuser `bigbrain_app` role RLS actually applies to
- `0002_schema.sql` — `users`, `unstructured_notes`, `documents` (per `docs/spec.md` §3), RLS
  enabled+forced on every `user_id`-scoped table, grants to `bigbrain_app`

To change the schema after the volume already exists, add a new numbered file here (this
directory is not re-run against an existing volume) and apply it by hand, or wipe the volume in
dev. `../checks/verify_rls.sql` proves the RLS policies actually hold.

Already applied by hand, not run automatically (see the file for the exact command):
- `0003_phase3_schema_updates.sql` — resizes `vector_embed` from 1536 to 1024 dims (Voyage AI's
  models don't support 1536) and adds `unstructured_notes.category` /
  `unstructured_notes.summary_short`, which the original migration omitted despite the ingestion
  pipeline (`docs/spec.md` §6.1) producing both.
- `0008_provider_credentials.sql` — adds `provider_credentials`, the encrypted DB-backed home for
  the provider API keys previously only in static env vars (`deepseek_api_key`,
  `openrouter_api_key`, `voyage_api_key`). Household-wide system config, not
  per-user data — deliberately exempt from RLS the same way `users` is. Rotated via the admin-only
  `POST /v1/admin/credentials` route (`orchestrator/src/server/adminServer.ts`) instead of a code
  rebuild.
- `0009_chat_sessions.sql` — adds `folders`, `chat_sessions`, `chat_messages`: persisted chat
  history for the frontend's Chat tab (`orchestrator/src/io/chatSessions.ts`), with per-chat
  params (system prompt, sampling) and a per-chat tool allow-list. Normalized message rows from
  day one, all three tables under the standard `user_scoped` RLS policy; `chat_messages.user_id`
  denormalized per the 0004 precedent.
- `0010_orchestrator_settings.sql` — adds `orchestrator_settings`, a small fixed-vocabulary
  key/value table for household-wide settings changeable from the Settings tab:
  `active_llm_profile` (which named `BIGBRAIN_LLM_PROFILES` entry is in use), `active_llm_model`
  (which model within it), and `household_timezone` (an IANA zone name, read fresh on every chat
  turn to tell the LLM the actual current date/time — `util/dateContext.ts`). Same
  no-RLS/household-wide shape as `provider_credentials`, but plaintext (not encrypted) since none
  of these values are secret and the whole point is reading them back to populate the Settings UI.
  The profile/model pair is rotated via the admin-only `POST /v1/admin/settings` route with the
  same restart-on-save pattern as credential rotation; `household_timezone` takes effect
  immediately with no restart, since it's just read live per request.
- `0011_notes.sql` — adds `notes`: freeform title+content rows for the Notes tab
  (`plugins/notes`), standard `user_scoped` RLS. Reachable both from the frontend's Notes tab and
  from conversation (`create_note`/`get_notes`/`get_note`/`update_note`/`delete_note` tools), no
  dedicated REST routes.
- `0012_prompt_presets.sql` — adds `prompt_presets`: named, reusable system-prompt snippets
  ("instruction sets") for the Chat tab's per-chat settings pane (`plugins/prompt-presets`),
  standard `user_scoped` RLS. Same dual-surface shape as `notes` — picking one only copies its
  content into a chat's own `chat_sessions.params.system`; it is not a live reference, so editing
  or deleting a preset later never changes a chat that already used it.
- `0019_chat_canvas.sql` — adds `chat_sessions.canvas_note_id` (nullable FK to `notes`): Canvas, the
  split-screen document panel in the Chat tab. Set by `httpServer.ts` whenever a notes-plugin tool
  call's own `focusHint` (`orchestrator/src/orchestrator/toolRegistry.ts`) surfaces a note id during
  a turn — `create_note`/`update_note`/`get_note` all declare one, "most recently focused note in
  the turn wins." Deliberately plugin-driven rather than hardcoded to notes in the orchestrator, so
  a future unstructured-content plugin (email/doc drafting) can opt into the same mechanism. No new
  RLS policy needed — `chat_sessions`' existing `user_scoped` policy applies per-row already.
- `0030_llm_vision_capable_profiles.sql` — widens `orchestrator_settings.key`'s `CHECK` vocabulary
  with `llm_vision_capable_profiles`: which named `BIGBRAIN_LLM_PROFILES` connections can accept
  image attachments (`io/llm/profiles.ts`'s `LlmProfile.supportsVision`). DB-backed/Settings-tab
  editable per §13, same restart-on-save shape as `active_llm_profile`. The one setting whose value
  is a small JSON array rather than a bare scalar — a single flag can't say "vision-capable" per
  profile name, and a chat can pick any configured profile, not just the household-wide active one.
- `0031_active_timers.sql` — adds `active_timers`: short-duration focus-sprint countdowns
  (`plugins/temporal`), standard `user_scoped` RLS. `end_at` is stored as an absolute timestamp
  rather than "seconds remaining" specifically so a running timer survives an orchestrator
  container restart with correct remaining time, no in-memory state needed. `status` is
  `'running' | 'completed' | 'cancelled'` only — no `'paused'` yet, since no pause/resume tool
  exists (the vocabulary stays closed to what's implemented). `linked_note_id`/`linked_chat_id` are
  optional, set-once-at-creation, on-delete-set-null pointers.
- `0032_scheduled_jobs.sql` — adds `scheduled_jobs`: one-time or daily-recurring alarms
  (`plugins/temporal`'s `schedule_routine` tool), standard `user_scoped` RLS. `classification`
  (`'alarm' | 'agent_routine'`) already accepts `'agent_routine'` even though nothing dispatches it
  yet (`jobPoll.ts` only fires `'alarm'` rows) — it needs a household kill switch and a per-job
  daily run cap first, added as an application-layer gate in a later stage rather than a further
  schema change. `schedule_kind` (`'once' | 'daily'`) is deliberately narrower than a full cron
  expression; `'daily'` recomputes `next_run_at` after each fire via `nextOccurrence.ts`'s
  IANA-timezone-aware arithmetic (built on `Intl.DateTimeFormat`, no new dependency), so a
  recurring alarm stays correct across a DST transition.
- `0033_notification_logs.sql` — adds `notification_logs`: an audit trail of every
  `send_push_notification` call (`plugins/notifications`), standard `user_scoped` RLS. `provider`
  is a closed vocabulary of exactly `'ntfy'` today, widened later the same way
  `provider_credentials.name`/`orchestrator_settings.key` are when a second driver actually gets
  built, not speculatively included now. This is a delivery log, not the conversational record of
  why the LLM decided to send — that reasoning stays in the chat's own messages like any other
  tool call.
- `0034_notifications_credentials_settings.sql` — widens `provider_credentials.name` with
  `ntfy_topic` (a secret: the ntfy server has no Cloudflare Access gate and anonymous read-write
  auth, so the topic name alone is what stands between "your phone" and "anyone's phone") and
  `orchestrator_settings.key` with `ntfy_server_url` (a plain selector, the public hostname) and
  `notifications_enabled` (the household kill switch — read live on every
  `send_push_notification` call, unset/false until an operator opts in from the Settings tab).
- `0035_agent_routine_dispatch.sql` — unblocks `scheduled_jobs`' `agent_routine` classification
  (`0032_scheduled_jobs.sql` accepted the value but nothing dispatched it): adds `instructions`
  (what the LLM does when it wakes up unattended — required for `agent_routine` via the widened
  `scheduled_jobs_routine_fields` CHECK, alongside `linked_chat_id`, both already-nullable
  columns), per-job `max_runs_per_day`/`max_tokens_per_day` caps (NOT NULL, default 5/50000), and
  a `capped_reason` column paired with a widened `status` CHECK (`'capped'`, distinct from
  `'cancelled'` — a human turning a routine off vs. it hitting its own budget). Adds `llm_calls`,
  the universal per-call usage log `docs/bb_principles.md` §14's gate
  (`orchestrator/src/io/llm/llmGate.ts`) writes to on every LLM call, agent_routine or not —
  deliberately RLS-exempt (same household-wide category as `provider_credentials`/
  `orchestrator_settings`) since the household-wide cap check needs to sum usage across every
  user, which a forced `user_scoped` RLS policy can't do even from an unscoped system session.
  Widens `orchestrator_settings.key` with `agent_routines_enabled` (the same switch a Settings-tab
  "big red button" and the gate's own household-cap breach reaction both flip), the two
  household-wide daily caps, and `agent_routines_disabled_reason`. The actual dispatch loop
  (`orchestrator/src/orchestrator/agentRoutineDispatch.ts`) lives in core, not
  `plugins/temporal` alongside `jobPoll.ts`'s alarm dispatch — it needs the full `ToolRegistry`
  and `runTurn`, neither reachable from a plugin (`orchestrator/pluginLoader.ts`'s own
  one-way-dependency doc) — so `orchestrator/src/index.ts` wires it directly, the same
  composition-root tier as the HTTP server.
- `0036_chat_sync_points.sql` / `0037_chat_chunks.sql` / `0038_chat_memory_entries.sql` /
  `0039_household_memory.sql` / `0040_chat_branching.sql` — rolling chat summarization, chunked
  RAG recall, and branching for long chat sessions, all owned by `plugins/chat-memory` (see
  `docs/chat-memory.md` for the full design). `chat_sync_points` is the restore-point bookkeeping
  table (`last_message_id` cascades from `chat_messages`, so an edit/rerun's existing
  `truncateMessagesFrom` delete self-heals every derived row for free — no divergence detection
  needed). `chat_chunks` is the chat-lane RAG table (`document_chunks`' exact shape, `chat_id`/
  `sync_id` in place of `doc_id`). `chat_memory_entries` is the per-chat "key ideas" digest,
  bounded via upsert on `(chat_id, topic_key)` since it's injected into every turn's prompt, unlike
  `chat_chunks` which is only reached on demand. `household_memory` is the cross-chat "worth
  keeping" memory, populated once at explicit chat-archive time (`0040`'s `archived_at`), `on
  delete set null` rather than cascade since it must outlive its source chat. `0040` also adds
  `parent_chat_id`/`fork_message_id` for branching — a fork is a new `chat_sessions` row
  constructed correct from birth (parent's messages + derived state copied at creation), not a
  message tree within one row.
- `0041_turn_metrics.sql` — adds `turn_metrics`: per-turn performance visibility, the BigImagine
  analog of SillyTavern-Loggeryze's `st_turn_perf.json` (`orchestrator/src/io/turnMetrics.ts`
  writes it, `orchestrator/src/orchestrator/loop.ts` accumulates it per round/tool-call). Standard
  `user_scoped` RLS, deliberately diverging from `llm_calls`' RLS exemption
  (`0035_agent_routine_dispatch.sql`) — `llm_calls` is exempt for one narrow, documented reason
  (the household-wide `agent_routine` cap must sum usage across every user), and `turn_metrics`
  has no equivalent need, so it gets the standard per-user policy like `chat_sessions`/`notes`
  instead of copying that exemption as a default. `rounds` is one `jsonb` array column (write-once
  alongside the parent row, only ever read back whole) rather than a child table. A failed turn
  still gets a row (`outcome = 'error'`, populated `error_reason`) so the rounds it did complete
  before dying stay visible. Also widens `llm_calls` with `duration_ms`, an independent,
  complementary addition at the per-call level.
- `0042_context_stack_presets.sql` — adds `context_stack_presets` and its ordered child table
  `context_stack_slots` (`plugins/context-stack-presets`, `docs/spec.md` §7.4): user-savable
  presets for which prompt-stack slots an assembled turn includes, and in what order. Each slot is
  either a `marker` (references one of the fixed marker keys — `system`, `description`,
  `personality`, `scenario`, `mes_example`, `post_history_instructions`, `global_rules`,
  `location`, `canon_facts`, `memory_recall`, `bridge`, `plot_threads`, `auto_recall`,
  `recent_history`; the last three are the 2026-08-13 RP memory component split —
  `io/chatMemory/memoryInjection.ts`, and `memory_recall` is the deprecated fused alias) or a
  `custom` static block with its
  own role; `context_stack_slots_marker_shape` CHECKs that a `marker` slot carries a `marker_key`
  and no `custom_role`/`custom_content`, and vice versa for `custom`. Seeds two builtin presets
  (`Standard`, `Minimal`) owned by a fixed `system_user_id` of all-zeroes, `is_builtin = true`.
  Diverges from the standard single `user_scoped` policy every other table in this file uses:
  builtins need to be readable by every user but writable by none of them, and a `USING`-only
  widening (this migration's first draft) would have also permitted `DELETE` on builtin rows,
  since `DELETE` has no `WITH CHECK` to catch what a widened `USING` lets through. Both tables
  instead get four command-scoped policies each (`select`/`insert`/`update`/`delete`) — only the
  `select` policy's `USING` clause includes the `is_builtin = true` bypass, so builtins are listable
  by anyone but editing or deleting one, regardless of caller, matches zero rows. `context_stack_
  slots` has no `user_id` of its own; its policies join back to its parent preset's owner instead.
  `on delete cascade` on `context_stack_slots.preset_id` cleans up slots when a preset is deleted —
  Postgres runs `ON DELETE CASCADE` as a referential-integrity action that bypasses RLS entirely,
  so this holds regardless of which policy would otherwise apply to the child rows.
- `0043_chat_memory_digest_horizon.sql` — widens `orchestrator_settings.key` with
  `chat_memory_digest_horizon_pairs`, and in the same statement closes a real gap: the six
  `chat_memory_*` keys `0036`-`0041` already had application code reading and writing
  (`orchestrator/src/io/orchestratorSettings.ts`'s `SETTING_NAMES`, `adminServer.ts`'s
  `getChatMemorySettings`/`setChatMemorySettings`) were never actually added to this CHECK
  constraint — every one of those settings would have failed a check-constraint violation the
  first time anyone saved it, undetected because nobody had exercised that path yet.
  `chat_memory_digest_horizon_pairs` (default 24) is BigImagine's analogue of
  SillyTavern-Canonize's bridge-summary horizon: how many trailing turn pairs' worth of
  `chat_chunks` summaries `distillChatMemory` re-reads on each sync, not just the chunks the
  current tick freshly produced. It can start smaller than Canonize's own default of 40 because
  the key-ideas digest already persists its own state forward as `chat_memory_entries` rows across
  syncs — the horizon here is a revision window layered on top of that persistence, not the sole
  source of continuity. See `docs/chat-memory.md` and `docs/bi_principles.md` §17 (every prompt,
  and prompt-adjacent behavior knob, surfaced in Settings for manual tuning).
- `0050_screen_lock_settings.sql` — widens `orchestrator_settings.key` with `screen_lock_password`
  and `screen_lock_timeout_minutes`: an idle-timeout re-lock overlay
  (`frontend/src/components/ScreenLockOverlay.tsx`), ported from SillyTavern-Playground's
  `driver/ui/lockScreen.js`. Privacy-only by design, same as playground's — the password is
  plaintext (fails `bi_principles.md` §12's "grants access on its own" test, since it protects
  nothing the real household-key/Access auth in `App.tsx` hasn't already gated) and unset (empty)
  disables the feature. Applied against the dedicated `bigimagine-postgres`/`bigimagine` database,
  not the old shared one `0048` had to special-case.
- `0051_lorebooks.sql` — adds `lorebooks` and `lorebook_entries`: storage for traditional
  SillyTavern-style keyword-triggered world info, kept separate from Canonize's canon_facts/
  semantic-recall path (`docs/spec.md`'s "no keyword-match fallback" describes the active recall
  mechanism, not a ban on holding the data). All books' entries live in the one `lorebook_entries`
  table (`lorebook_id` distinguishes the book), not one table per book. Column shape follows ST's
  real entry definition (`stacks/sillytavern/st-source/public/scripts/world-info.js`'s
  `newWorldInfoEntryDefinition`, ~35 fields) — columns cover what's worth browsing/filtering/toggling
  in a UI, `source_json` holds the complete original entry verbatim (same convention as
  `characters.source_json`) so the rarer fields (recursion flags, character filters, sticky/cooldown,
  automation triggers) aren't lost even though nothing reads them yet. **Storage only** — no
  import/export routes, UI, or prompt-stack wiring exist yet; that's a separate, later task.
- `0052_pia_proxy_settings.sql` — widens `orchestrator_settings.key` with `pia_proxy_url`: the
  internal address of the standalone `pia-proxy` container (`stacks/pia-proxy`, a sibling Dockge
  stack, not part of this codebase) that routes a fetch through a real PIA WireGuard tunnel.
  Exists because chub.ai blocks Australian IPs; `plugins/characters`' chub import/search tools
  (`io/piaProxyFetch.ts`) are the first consumer. Same selector shape as `ntfy_server_url` — not a
  secret, just a plain internal container URL, read live on every call.
- `0053_persona_settings.sql` — widens `orchestrator_settings.key` with `persona_name` and
  `persona_description`: the household's own name and self-description, BigImagine's analogue of
  SillyTavern's user persona (`{{user}}`/`{{persona}}`). Stage 1 of `docs/plans/prompt-macros.md`'s
  staged macro-port plan — deliberately the simplified single-persona shape (a name, a description,
  and reuse of the existing marker-slot `enabled` toggle to push it into the prompt stack) rather
  than ST's full multi-persona/position system. Consumed by
  `plugins/context-stack-presets/src/applyPromptStackToChatTool.ts` to populate the `persona`
  marker key added to `assemblePromptStack.ts`'s `MarkerKey` alongside this migration.
- `0054_canon_facts_chat_anchor.sql` — adds `chat_id`/`anchor_message_id` to `canon_facts`, both
  `on delete set null` (never `cascade` — a proposal is never erased, per `bi_principles.md` §15).
  Point-in-time canon recall: `plugins/canonize/src/recallCanonFactsTool.ts`'s new
  `as_of_message_id` arg filters facts to only those anchored at or before a given chat message, so
  "what did the story know as of turn N" is a plain filtered read, not a separate snapshot to keep
  in sync. Omitting `as_of_message_id` is byte-for-byte the pre-migration behavior.
- `0055_chat_memory_sync_status.sql` — adds `chat_memory_sync_status`, one upserted row per chat
  recording the rolling background sync loop's (`orchestrator/chatMemorySync.ts`) last attempt:
  ok/skipped/error, which step failed and why, and the counts it last produced. `on delete cascade`
  (unlike `canon_facts` — this is derived health data, not a record that must never be lost). The
  read side for the frontend's new Review Panel (`frontend/src/views/ReviewPanelView.tsx`,
  `GET /v1/admin/chat-memory-sync-status`) — confirmation that each pipeline stage is actually
  working, per `bi_principles.md` §11, not an editing surface (canon-fact approve/reject stays on
  `CanonQueueView`, untouched by this migration).
- `0056_llm_gate_retry.sql` — widens `llm_calls` with `request_id`/`attempt` (docs/plans/completed/llm-gate-plan.md,
  `io/llm/llmGate.ts`'s new internal retry/queueing: a retryable failure — 429/5xx, or a bare
  thrown transport error — is retried with bounded exponential backoff, admitted through a
  per-lane concurrency slot, invisible to every caller). Every attempt of one logical `complete()`
  call is its own row sharing a `request_id`, so a call that needed 2 attempts to succeed shows up
  as two rows instead of losing the earlier failed attempt's latency/outcome. Also widens
  `orchestrator_settings.key` with the five `llm_gate_*` tuning keys (two per-lane concurrency
  caps, `max_retries`, `retry_base_ms`, `retry_max_ms`) — unset means "use `llmGate.ts`'s own
  conservative built-in default," same fallback shape as every other tunable setting. `tallySince`
  (the `agent_routine` cap tally) now counts `outcome in ('ok', 'error')`, not just `'ok'` — a
  retried attempt is still real provider spend even when it ultimately fails, distinct from a
  `'refused'` row (a preflight rejection that never reached the provider at all).
- `0057_cleanup_preset.sql` — adds `chat_sessions.cleanup_preset_id`, `on delete set null` (same
  shape as `prompt_stack_preset_id`'s own addition in `0049`). The turn loop's optional step 5
  cleanup pass (docs/plans/turn-loop-plan.md §4): a second LLM call that post-processes a turn's raw
  reply before persistence — banned constructions/names/words, header reconstruction,
  internal-thoughts-suffix fixups, the same job the user's real-world Triggeryze `sideCall` does
  today. Per the user's explicit direction this is exposed as its own `context_stack_presets` row
  (mostly `custom`-type slots, `{{message}}` embedded in their text via
  `util/interpolateMacros.ts`'s new `message` field), not a second "instruction content" schema.
  Null (the default) means cleanup is off — the common case until a user opts in;
  `server/httpServer.ts` skips straight to persistence when unset, zero cost.
- `0058_canon_facts_chat_scoped.sql` — tightens `canon_facts.chat_id` to `not null`, `on delete
  cascade` (was nullable/`set null` since `0054`). The user's explicit call: "every fact needs a
  chat id... there shouldn't be any facts that don't belong to a chat" — supersedes `0054`'s
  "platform-global fact, no chat" branch entirely rather than just leaving it unused. `canon_facts`
  was empty in the live DB when this was applied (extraction is still unwired), so no backfill was
  needed. `on delete cascade` is a real narrowing of `bi_principles.md` §15's "reviewable, not
  erased" (which still governs `rejected` rows staying on record within a chat's lifetime) —
  deleting the chat itself now also removes its canon, since a fact can no longer fall back to
  being globally visible. `anchor_message_id` stays nullable/`set null`: a fact can belong to a
  chat as a whole without pinning to one turn. Paired with three tool-layer changes, all in the
  same batch: `proposeCanonFactTool.ts`/`recallCanonFactsTool.ts` now require `ctx.chatId` and
  `recall_canon_facts` scopes by it directly (dropping the original `scene_id`/`scene_presence`/
  `linked_character_ids` scoping design — nothing populates `scene_presence` today, and
  `{{user}}`'s near-universal presence made character-scoping a `plot` fact close to meaningless;
  left as a real idea for later once active-location tracking is wired for real); and
  `orchestrator/chatMemorySync.ts` auto-promotes each chat's `'proposed'` canon facts to
  `'approved'` at that chat's own next sync tick, rather than waiting on a manual
  `approve_canon_fact` call — `get_canon_fact_proposals`/`reject_canon_fact`/`CanonQueueView.tsx`
  all widened to treat `'proposed'` and `'approved'` as the two live states of an audit/undo queue,
  not a pre-commit gate. `io/chatSessions.ts`'s `forkChat` duplicates a parent chat's `canon_facts`
  in full (not fork-point-filtered like `chat_sync_points`/`chat_chunks`/`chat_memory_entries`) —
  every fork gets its own `chat_id` and a complete copy of the parent's canon, per the same explicit
  call.
- `0062_llm_connections.sql` — adds `llm_connections`, promoting LLM connections from a fixed set
  in the `BIGBRAIN_LLM_PROFILES` env var to real, admin-managed, named rows (create/rename/delete
  from the frontend's new Connections tab, not just field-overrides onto an env-defined profile).
  `api_key_ciphertext` reuses `io/fieldCipher.ts`, same write-only-secret shape as
  `provider_credentials`. `provider_order`/`quantizations` are jsonb string arrays backing
  OpenRouter's own per-request `provider` object (pin a primary + fallback provider, or a
  quantization filter, instead of its default full-set routing). `is_active` marks the one
  connection the boot-time singleton uses for turns with no per-chat override, enforced to at most
  one row via a partial unique index; `io/llmConnections.ts`'s `remove()` refuses to delete it.
  `index.ts` seeds this table once from `BIGBRAIN_LLM_PROFILES` on first boot against an empty
  table, so an existing deployment's profiles/keys carry over without a manual write — every boot
  after that reads only from the table. `orchestrator_settings`' `active_llm_profile`/
  `active_llm_model`/`llm_vision_capable_profiles` keys are retired in favor of `is_active`/
  `supports_vision` living on the connection row itself, but stay in `SETTING_NAMES` (and 0010's
  CHECK constraint, already wider than the TS union) rather than being narrowed out — same
  never-narrow precedent as `CREDENTIAL_NAMES`' still-present `deepseek_api_key`/
  `openrouter_api_key` entries, kept only so the one-time seed above can still read a pre-cutover
  deployment's values on its first boot after upgrading; nothing reads them after that.
- `0063_chat_memory_bridge_settings.sql` — widens `orchestrator_settings.key` with
  `chat_memory_bridge_prompt`: the 'rp'-kind sync lane's hookseeker-parity bridge prompt
  (`io/chatMemory/bridgeChatMemory.ts`), ported near-verbatim from SillyTavern-Canonize's own
  hand-tuned `hookseekerPrompt` per the user's explicit direction to preserve exact wording rather
  than re-paraphrase it. Same "default + bespoke" override shape as `chat_memory_distill_prompt`,
  but a separate key — a chat's `kind` (`0049_chat_kind.sql`) selects exactly one of the two lanes
  (household digest vs. RP bridge), never both, so the two prompts are mutually exclusive per chat
  rather than layered.
- `0064_canon_facts_entity_key.sql` — adds `canon_facts.entity_key`: the dictionary-identity column
  for `person`/`place`/`thing`/`concept` facts, populated by the new periodic lorebook/people
  curators (`io/chatMemory/curateLorebook.ts`, `curatePeople.ts`). Deliberately a new column, not a
  reuse of `arc_tag` — `arc_tag` groups successive proposals into one continuing *plot arc*;
  `entity_key` groups successive proposals into one continuing *dictionary entry* for a named
  thing. The user's explicit call after an earlier draft proposed folding this into `arc_tag`.
  Nullable/unconstrained: turn-time `propose_canon_fact` facts never carry one.
  `recallCanonFactsTool.ts`'s dedup CTE widens from `coalesce(arc_tag, fact_id::text)` to
  `coalesce(arc_tag, entity_key, fact_id::text)` in the same batch.
- `0065_chat_memory_curator_settings.sql` — widens `orchestrator_settings.key` with
  `chat_memory_lorebook_curator_prompt` and `chat_memory_people_curator_prompt`: two new periodic
  curator calls in the 'rp'-kind sync lane, ported near-verbatim from SillyTavern-Canonize's
  `lorebookSyncPrompt`/`peopleSyncPrompt` (same direction as `0063`'s bridge prompt — preserve exact
  wording). Both run every sync tick alongside the existing bridge call, writing `'proposed'`
  `person`/`place`/`thing`/`concept` canon_facts that settle through the same auto-approve step,
  zero special-casing. The one deliberate adaptation from CNZ: their "Keys:" keyword-list
  instruction is dropped from both ported prompts — `docs/spec.md`'s vector recall already replaces
  keyword-lorebook matching entirely, so there's nothing that would ever read a generated key.
- `0066_cleanup_preset_seed.sql` — seeds the builtin **"Cleanup Pass"** context_stack_presets row
  (`is_builtin = true`, system user) plus its one custom-system slot carrying the actual cleanup
  prompt text (docs/plans/vistalyze_integration/cleanup_prompt.md §2.3): the banned-construction/AI-cliché
  slop list, the location/date/time header-reconstruction rule, and the `<details>` inner-thoughts
  formatting rule, with `{{message}}` embedded where the raw turn goes. The builtin is the
  read-only default on the Prompt Stacks page; per bi_principles.md §17 the user duplicates it to
  customize — the slop list is just the slot's `customContent` textarea, no separate table or UI.
  Companion to 0057's `chat_sessions.cleanup_preset_id` column; null (unset) chat references keep
  cleanup off. Guarded on the preset name so re-runs can't double-seed after a duplicate.

- `0067_transient_location_and_people.sql` — the schema half of docs/plans/vistalyze_integration/segway.md
  (transient → permanent/inactive lifecycle for `locations` and `characters`, plus the scene
  identity everything depends on). `scenes.chat_id` (`on delete cascade`) with a unique
  `(chat_id, active_location_id)` index makes a scene a per-chat visit record keyed by location
  rather than one mutable row per chat; `chat_sessions.scene_id` (`on delete set null`) is the
  cache pointer the turn pipeline's Stage 2 scraper keeps stamped. Both tables gain `status`
  (`locations` defaulting `'transient'`, `characters` defaulting null — ordinary user-authored
  characters are neither transient nor inactive, per segway.md §2.4), `anchor_chat_id` (`on
  delete set null` — deleting a chat must never destroy canon it promoted, same invariant as
  0054), and `anchor_swipe_id` (`on delete cascade` — deleting the originating turn purges its
  still-transient/inactive rows). `plugins/locations`' `create_location` writes `status =
  'permanent'` — a user manually creating a location is the explicit canon signal
  (bi_principles.md §3) — and the migration backfills pre-existing unanchored rows the same way.

- `0068_image_connections.sql` — the schema half of docs/plans/vistalyze_integration/endpoint.md (the
  Vistalyze image-generation subsystem). A new `image_connections` table mirrors
  `llm_connections` (0062): household-wide, no RLS, admin-managed rows for image backends
  (runware/fal-ai/pollinations/comfyui/openai-images) with `api_key_ciphertext` (nullable —
  only a local ComfyUI endpoint has none, every cloud provider requires a key), per-connection
  generation defaults (width/height in pixels/sampling_steps/cfg_scale/sampler_name), master
  positive/negative prompt
  fragments, and a ComfyUI `workflow_parameters` jsonb graph. `is_active` + the partial unique
  index is the single active pointer, read live by `resolveActive()` on every generation call —
  no boot-time singleton, no restart on switch (the spec's §2.2 "Active Image Connection Pointer"
  settings entry is deliberately not added: it would duplicate this column as a second source of
  truth, same shape as 0062). `locations.image_path` is renamed to `image_url` (endpoint.md §2.3):
  the column now means a remote CDN URL, never a local file path — the stateless-media
  commitment (endpoint.md §1.1). Cache validation (§5.1) compares the location's current
  visual_description/environment/seed against the new `image_rendered_input` snapshot recorded at
  the last render — not against `updated_at`, because the post-cleanup scraper bumps `updated_at`
  on every matched turn even on a no-op merge, which would make a timestamp-based check always
  miss and defeat the cache-first commitment. Widens
  `orchestrator_settings.key`'s CHECK with `image_prompt_template` (the master prompt template
  synthesizeImagePrompt.ts expands, `''` = built-in default per bi_principles.md §17).
- `0069_chat_background_settings.sql` — widens `orchestrator_settings.key`'s CHECK with
  `chat_background_parallax` (docs/plans/vistalyze_integration/parallax_fade_teststep.md §2.2): the
  toggle for the ChatView location-background's parallax pan, read live by the frontend via
  `GET /v1/chat-background-settings` (same no-restart shape as `household_timezone`), written by
  the admin-gated SettingsView toggle. Stored as text `'true'`/`'false'`, default false when
  unset — matching SillyTavern-Vistalyze's own `parallaxEnabled=false` default.
- `0070_cleanup_preset_prev_turns.sql` — rewrites the builtin **"Cleanup Pass"** preset's
  custom/system slot text to embed the `{{prev_turns, 2}}` macro (cleanup_prompt.md §3.2): the
  previous-turns contract moved from hardcoded message prepending to a prompt-controlled textual
  macro (N turn pairs, default 2), expanded by `runCleanupPass` via `interpolateMacros`'s
  `resolveArg` hook. The 0066 seed predates the macro, so its "recent conversation history
  provided before this prompt" wording stopped being true once the prepend was removed; 0070
  replaces it with a `PREVIOUS TURNS:` transcript block and points rule 2's header-reconstruction
  at it. Creates the builtin preset when missing (0066 was never applied to the live DB — only
  fresh volumes run it) and updates it in place when present; never touches user-owned presets.
  Idempotent — re-running converges to the same slot text.
- `0071_default_cleanup_preset.sql` — adds `users.default_cleanup_preset_id` (nullable FK to
  `context_stack_presets`, `on delete set null`), the sibling of 0061: the *cleanup* default,
  auto-applied by CharactersView.tsx `startRp()` to every new RP chat's `cleanup_preset_id`
  alongside the default prompt stack. `set_default_context_stack_preset`'s new `kind` argument
  (`'prompt' | 'cleanup'`) picks which of the two columns it writes; `get_context_stack_presets`
  reports both (`isDefault`/`isCleanupDefault`). Same design as 0061 — on users, never as a flag
  on preset rows, so a builtin default stays household-safe. Idempotent (a plain add-column;
  re-running on an already-migrated DB errors only if the column already exists — the usual
  hand-apply one-shot).
- `0072_cleanup_heuristic_settings.sql` — the async heuristic cleanup subloop (plan v2), which
  **replaces** the preset-based inline cleanup pass of 0057/0066/0070/0071: a reply now lands
  raw, then a background subloop strips antislop and repairs the header/footer regex shapes,
  rewriting the message in place via `recordSwipe` (original preserved as swipe #0). Adds
  `chat_sessions.cleanup_enabled_at` (timestamptz; null = off — the timestamp doubles as the
  retro-flood guard, the subloop only processes messages created after it), the `cleanup_slop_rules`
  table (RLS-exempt household config like `orchestrator_settings`: named regex sets, per-rule
  `action` of `remove`/`replace-paragraph`/`llm`, seeded with a small starter set), the
  `cleanup_jobs` ledger (user-scoped via `chat_messages`, unique per `(message_id, swipe_id)` for
  exact dedup), and widens `orchestrator_settings.key`'s CHECK with `cleanup_header_regex`/
  `cleanup_header_prompt`/`cleanup_footer_regex`/`cleanup_footer_prompt` (the two editable regex
  triggers + the repair prompts fired when they fail to match; header prompt resolves
  `{{history, x}}` + `{{message}}`, footer prompt `{{message}}` only; empty = built-in default).
  The old `cleanup_preset_id`/`users.default_cleanup_preset_id` columns stay in place, unread —
  migrations are append-only; the inline pass's call sites are removed with the feature itself.
- `0075_chat_legibility_halo_strength.sql` — widens `orchestrator_settings.key`'s CHECK with
  `chat_legibility_halo_strength` (text `'0'..'1'`, default `0.6`): the intensity dial under the
  ChatView "Text legibility" menu's **Letter halo** toggle (0074). Applied in ChatView.css as
  `color-mix(in srgb, var(--color-bubble-*-halo) var(--halo-strength, 60%), transparent)` — the
  per-theme halo colors keep their own alpha and the strength multiplies on top, so 0 = invisible
  ring, 1 = the full-force ring (the pre-0075 look, which read as too strong). Read live at chat
  load by the same `GET /v1/chat-legibility-settings`; written by the admin-gated slider, no
  restart. Idempotent (drop/re-add of the CHECK; the usual hand-apply one-shot).
- `0077_chat_memory_rag_retrieval_settings.sql` — widens `orchestrator_settings.key`'s CHECK with
  the RP read path's three retrieval knobs (`io/chatMemory/recallForPrompt.ts` — the CNZ-style
  auto-recall shipped in f9b8dc6): `chat_memory_auto_recall_enabled` (`'true'`/`'false'`, default
  `'true'` — the silent per-turn recall master switch; `'false'` silences the injection without
  touching the recall tools, which stay in the RP allow-list), `chat_memory_auto_recall_pairs`
  (integer-as-text, default `'3'` — how many trailing turn-pairs form the query, the knob behind
  the `AUTO_RECALL_PAIRS` constant), and `chat_memory_auto_recall_chunk_top_k` (integer-as-text,
  default `'4'` — how many archived full-turn chunks are injected, the knob behind the
  `AUTO_RECALL_CHUNK_TOP_K` constant). `canon_recall_top_k` (facts injected) was already a key.
  Read live on every RP prompt assembly, no restart; unset/corrupt values fall back to the
  constants (same fail-open shape as every numeric setting). The key list is the *complete*
  current vocabulary (all of 0010–0076), not the diff — the CHECK is rebuilt wholesale, so a
  fresh volume must land on the same constraint the live DB has. Idempotent hand-apply one-shot.
- `0078_location_describer.sql` — the room-description pass (docs/plans/vistalyze_integration/describer.md,
  VLZ's Step 3 Describer ported into BigImagine's bg pipeline): adds `locations.definition`
  (nullable — the describer's "Definition:" output, the logical half; the "Visuals:" half lands in
  the existing `visual_description`), plus two orchestrator_settings keys:
  `location_describer_prompt` (the full describer prompt template; empty = the built-in default in
  `orchestrator/src/orchestrator/describeLocation.ts`, bi_principles.md §17) and
  `location_describer_history_pairs` (integer-as-text, default `'1'` — how many trailing turn-pairs
  the describer reads as narrative context). Read live on every describe pass, no restart; unset or
  corrupt values fall back to the built-in defaults (same fail-open shape as every numeric setting).
  The key list is the *complete* current vocabulary (all of 0010–0077), not the diff — the CHECK is
  rebuilt wholesale, so a fresh volume must land on the same constraint the live DB has. Idempotent
  hand-apply one-shot.
- `0079_sync_inspection.sql` — the RP sync-status panel's "click a sync and play it back"
  data: adds `chat_sync_points.bridge_prompt` (nullable — the fully-rendered system+user message
  the 'rp' lane's bridge actually sent the model that pass, persisted by chatMemorySync.ts's
  `upsert_bridge` step; null for non-rp chats and pre-0079 syncs, and deliberately not
  reconstructible afterwards since previous output / running threads have moved on) and
  `canon_facts.sync_id` — `on delete set null`, not cascade: unlike chat_chunks/chat_memory_entries
  (pure derived state, reconstructible from the source transcript, so 0036's self-healing cascade
  is right for them), a canon fact is a durable record the moment it's proposed (bi_principles.md
  §15), so a
  truncated-away sync point de-attributes its facts rather than deleting them — the same `set null`
  reasoning 0054 originally used for `canon_facts.chat_id`, and the reason a fork's copied facts
  (which keep the parent's sync_id) survive the parent's sync point dying. Nullable — facts
  written outside the sync loop (tools, future writers) stay unattributed, which is exactly the
  distinction the inspection view wants to draw. The three rp-lane inserts (bridge plot entries,
  lorebook curator, people curator) stamp sync_id. Read side: `getChatSyncStatus` returns a cheap
  summary list (ordinal, created_at, aggregate entry/fact counts — one grouped query, newest 50
  syncs first, so the 30s panel poll never ships the heavy detail), and
  `getChatSyncInspection`/`GET /v1/chats/:id/syncs/:syncId` fetch one sync's full record on
  demand — `chat_memory_entries.sync_id` (re-pointed by the upsert on every update, so it's
  exactly "created or changed in that sync") plus `canon_facts.sync_id` and the bridge prompt.
- `0080_memory_injection_templates.sql` — the RP memory component split's four settings keys
  (`io/chatMemory/memoryInjection.ts`, 2026-08-13 user direction): `chat_memory_inject_bridge_prompt`,
  `chat_memory_inject_plot_prompt`, `chat_memory_inject_auto_recall_prompt`,
  `chat_memory_auto_recall_chunk_prompt` — the user-editable CNZ-style `{{var}}`/`{{#if}}` templates
  the narrator stack renders the `bridge` / `plot_threads` / `auto_recall` markers from (read live
  on every RP prompt assembly, no restart). `memory_recall` remains the deprecated fused alias of
  all three. Same wholesale CHECK rebuild pattern as 0077/0078 (complete vocabulary, confirmed
  against `pg_get_constraintdef` after applying).
  Applied by hand against the live DB — the `add column`s are individually re-runnable; the index
  and FK constraint are one-shot, so apply once and verify.
- `0081_recent_history_slot.sql` — `recent_history` becomes a LIVE marker: the active context
  (last sent turn + live-window turns) rendered into the stack where the preset ordered the slot,
  wrapped in the preset's own HTML tags, so the user can manage/order/mute it from Prompt Stacks
  (2026-08-10 direction; the messages-array-era wording is gone).
- `0082_rp_no_tools.sql` — the RP lane runs with NO tools at all (2026-08-10 direction: "We simply
  let it execute the comfy 2 stack, with no funny business"). Normalizes existing rp chats'
  `tool_names` to `'{}'` (new ones already default via `DEFAULT_RP_TOOLS`), so the RP turn never
  creates characters/locations on its own.
- `0083_location_tracking.sql` — the Location Tracker (docs/plans/vistalyze_integration/location.md), the
  parent/sub "places ↔ locations" model + tracker settings keys, modeled on Triggeryze's
  location-tracker pattern. Adds `locations.parent_location_id` (self-FK, `on delete set null`):
  a "place" ("The Tavern") is a parent row, a "location" ("The Tavern - Kitchen") is a sub row;
  `locations.name` stays the full header string verbatim, the parent name is derived by split
  (`splitLocationName` in the scraper) and the parent row's name is that derived portion. Parent
  rows are plain transient rows anchored to the same swipe as their first sub, so the existing
  lifecycle applies unchanged: demoted to `inactive` on swipe replace, deleted on chat delete via
  `anchor_swipe_id`'s cascade. One-shot backfill (idempotent, safe to re-run) creates parent rows
  for legacy "X - Y" names. Three new `orchestrator_settings` keys (CHECK widened to match 0080's
  rebuild style): `location_split_enabled` (gate the split + parent-row creation),
  `location_injection_enabled` (gate the always-on `<locations>` marker slot — the slot itself is
  part of every prompt stack, tick/untick/delete from Prompt Stacks), `location_injection_prompt`
  (the user-editable block template, empty = built-in default, rendered by
  `orchestrator/src/util/renderLocationBlock.ts`). Index on `parent_location_id`.
  Applied by hand against the live DB — the `add column`/settings inserts are individually
  re-runnable; the FK constraint and backfill are guarded to run once, so apply once and verify.
- `0084_location_marker_all_presets.sql` — the `'location'` marker slot in EVERY prompt stack
  preset, not just builtins (2026-08-10: 0083's seed guarded `is_builtin`, so the user's custom
  Comfy 2 preset never got the always-on "Active Location" slot). Inserts an enabled `'location'`
  marker after the core markers in every preset that lacks one, shifting later slots up — using a
  descending-position loop instead of 0083's single UPDATE, which collides on the unique
  `(preset_id, position)` index for contiguous runs. No code change; hand-applied to the live DB
  only (frontend already labels the slot via `markerLabels.ts`).
- `0085_context_stack_slot_tags.sql` — the per-slot "wrap in HTML-style tags" toggle
  (2026-08-14). Adds `context_stack_slots.tag_enabled` (boolean, `not null default false`) —
  when ON, the slot's friendly name (marker label / slot label, sanitized: trim, newlines→space,
  strip `<`/`>`) wraps its assembled content as `<Name>\n...\n</Name>`, a hint to the LLM, not
  real HTML. Default OFF keeps existing stacks byte-identical (preserving the prompt-cache contract).
  Assembly-relevant (unlike 0060's purely cosmetic `label`): `assemblePromptStack.ts`'s
  `PromptStackSlot` gains `tagEnabled`/`label`, and the per-turn narrator path wraps with the same
  shared helper so the real prompt and the inspector agree. Hand-applied to the live DB.
- `0086_context_stack_slot_groups.sql` — slot **grouping** (2026-08-14): wrap a contiguous run of
  slots in one set of HTML-style tags. Adds `context_stack_slots.group_name` (text, nullable —
  NULL = not in a group). One toggle per slot row: the first toggled slot of a contiguous run is
  the opener (name text box), the last is the closer (auto `</Name>` chip mirroring the opener's
  name); every member carries the same `group_name`, and assembly derives runs from contiguity +
  equality (opener/closer need no flags). `<Name>` attaches to the first rendered member,
  `</Name>` to the last; disabled/empty members stay inside the group positionally. Names are
  sanitized like 0085's (trim, collapse whitespace, strip `<`/`>`); empty name emits no tags and
  breaks a run. Default NULL keeps existing stacks byte-identical (preserving the cache contract). Editor
  gives each group a stable name-derived color from a palette that excludes red — red is reserved
  for the coverage warning (enabled slot with no enclosing tags). Hand-applied to the live DB
  (2026-08-14).
- `0087_world_memory_curator_settings.sql` — renames the world-memory (place/thing/concept)
  curator's settings key `chat_memory_lorebook_curator_prompt` → `chat_memory_world_curator_prompt`
  (docs/lorebook-plan.md §0), matching the code rename `curateLorebook.ts` → `curateWorldMemory.ts`.
  A live-data migration, not just a code change: an `orchestrator_settings` row written under the
  old key must not silently stop being read (bi_principles.md §13), so the migration UPDATEs the row
  and widens the key CHECK in one transaction (0048's warning: DROP/ADD without a wrapping
  transaction can leave the column unconstrained on failure). `canon_facts.category` values are
  untouched — only the curator's name changed, not the data. Hand-applied to the live DB.
- `0088_lorebook_runtime.sql` — the Lorebook runtime schema (docs/lorebook-plan.md §3, build order
  step 1), built on 0051's storage-only tables without renaming or reshaping them: scoping tables
  `lorebook_character_links`/`lorebook_chat_overrides`/`lorebook_entry_overrides` + `global_scope`
  (scene_presence shape, denormalized user_id for RLS); activation-mechanics columns on
  `lorebook_entries` (`use_probability`, `group_weight`, `group_override`, `sticky`, `cooldown`,
  `delay`, plus `vector_embed vector(2048)` for vector discovery — defaults all preserve today's
  behavior until an author opts in); `lorebook_activation_log` as both the audit trail and the
  sticky/cooldown/delay state (cascade FKs, unlike 0054's set-null — a log may disappear with its
  chat/message/entry); and the four `lorebook_settings` keys (`lorebook_mode`,
  `lorebook_token_budget`, `lorebook_recall_top_k`, `lorebook_recursion_enabled`) via the usual
  orchestrator_settings CHECK re-list (67 keys, superset per 0048's warning, in one transaction —
  same pattern 0087 used). No prompt-stack wiring here — that's plan steps 2-4. Hand-applied to the
  live DB.
- `0091_chat_memory_auto_recall_cutoff.sql` — the RAG dynamic cutoff's three knobs
  (docs/plans/completed/rag-dynamic-cutoff-plan.md, Stage 1 of the CNZ retrieval port —
  `io/chatMemory/recallCutoff.ts`): `chat_memory_auto_recall_chunk_min` (integer-as-text, default
  `'2'` — the Min floor: how many archived full-turn chunks are injected at minimum even when the
  pool distribution says nothing clears the threshold; Canonize's own `ragChatMin` default),
  `chat_memory_auto_recall_pool_multiple` (float-as-text, default `'2'` — Pool Multiple P: the
  candidate pool the cutoff measures is P × Max, min 6, Canonize's `ragPoolMultiple`; parsed as a
  float, not an integer), and `chat_memory_auto_recall_cutoff_mode` (enum-as-text, one of
  `'mean' | 'mean+1sd' | 'mean+2sd'`, default `'mean'` — how strict the threshold is, in raw L2
  distance space where lower is better). Read live on every RP prompt assembly alongside the 0077
  trio; unset/corrupt values fall back to the constants (same fail-open shape). Deliberately no
  `chunk_`/`fact_` prefix on pool_multiple/cutoff_mode — Stage 2 reuses those two shared knobs
  unchanged for the `canon_facts` query, mirroring Canonize's own per-channel Min/Max + shared
  Pool Multiple/Cutoff Mode settings shape. The key list is the *complete* current vocabulary
  (all of 0010–0090, 70 keys), not the diff — the CHECK is rebuilt wholesale, so a fresh volume
  must land on the same constraint the live DB has. Idempotent hand-apply one-shot.
- `0092_canon_recall_min.sql` — Stage 2 of the CNZ retrieval port: the canon_facts lane's Min
  floor, `canon_recall_min` (integer-as-text, default `'2'` — how many approved facts
  `buildAutoRecallParts` injects at minimum even when the pool distribution says nothing clears
  the threshold, the per-channel pair of the existing `canon_recall_top_k` Max). Same wholesale
  CHECK rebuild as 0091 (complete vocabulary, all of 0010–0091, 71 keys); the two shared knobs
  from 0091 (pool_multiple/cutoff_mode) apply to the fact lane unchanged. Read live by
  recallForPrompt.ts; unset/corrupt → `DEFAULT_FACT_MIN`. Idempotent hand-apply one-shot.
- `0093_chat_chunks_keyword_lane.sql` — Stage 4 of the CNZ retrieval port: the keyword/FTS lane
  over `chat_chunks.content`. Adds a STORED generated `content_tsv` column
  (`to_tsvector('english', content)` — computed on insert and backfilled for existing rows, no
  trigger/backfill script) plus a GIN index (`chat_chunks_content_tsv_gin`). The chunk query in
  recallForPrompt.ts scores every fetched row with `ts_rank(content_tsv, ...)` and
  recallCutoff.ts's `blendKeyword` re-ranks the keyword window by blended distance before the
  cutoff (Canonize's RAG_strategy_v4.md §3 Step 3, chat channel only). No settings keys — the
  blend constants are plain constants per the plan. Idempotent hand-apply one-shot.
- `0094_chat_chunks_summary_lane.sql` — Stage 5 of the CNZ retrieval port: the header/second
  vector lane over `chat_chunks.summary`. Adds a nullable `summary_vector_embed vector(2048)`
  column (NULL for pre-existing rows — the header lane query skips NULLs, so old chunks stay
  content-lane-only; chatMemorySync.ts embeds summaries from the next sync pass onward). The
  chunk path in recallForPrompt.ts queries both lanes and merges them with best-of scoring plus
  Canonize's 1.08× dual-confirmation bonus (recallCutoff.ts's `dualBonus`, chat channel only).
  No index (vector(2048) is too wide to index, same as `vector_embed` per 0047) and no settings
  keys. Idempotent hand-apply one-shot.
- `0095_reasoning_blocks.sql` — reasoning ("thinking") blocks for RP chat
  (docs/plans/reasoning-blocks-plan.md): nullable `reasoning text` columns on `chat_messages`
  and `chat_message_swipes` (the trimmed inner text of a `<think>…</think>` span — separate from
  `content` by construction, so nothing that builds `recent_history` or any other prompt-stack
  field ever sees it; the exclusion is structural, no stripping step). The active swipe's
  reasoning is mirrored onto the row the same way content is (recordSwipe/cycleSwipe). Also
  widens `orchestrator_settings.key`'s CHECK with `reasoning_open_tag`/`reasoning_close_tag`
  (defaults `<think>`/`</think>`, read live by `orchestrator/liveReasoning.ts`, editable from
  the Cleanup page's setup block). Same wholesale CHECK rebuild as 0091/0092 (complete
  vocabulary, all of 0010–0094, 73 keys). Idempotent hand-apply one-shot.
 - `0127_chat_memory_sync_status_failure_class.sql` — permanent-failure classification for the
  rolling chat-memory sync loop's status row: nullable `last_error_kind`
  (`'permanent'|'transient'`, with a CHECK) and `failure_signature` (a fingerprint of the
  connection a permanent failure ran through — `kind|model|baseUrl`). The tick suppresses the
  identical permanent failure instead of retrying every 30s, retrying only when the signature
  changes or a slow periodic retry elapses; ok/skipped clears both columns. No settings keys, no
   new tables. Idempotent hand-apply one-shot.
 - `0128_remove_chat_archive.sql` — drops the obsolete `chat_sessions.archived_at` lifecycle column;
   previously archived chats become ordinary chats. `scenes.archived_at` is unrelated and remains.
- `0133_cards_runtime_characters_foundation.sql` — additive foundation for the Cards/runtime
  Character split (`docs/plans/cards-runtime-characters/3_IMPLEMENTATION_PLAN.md` §1.1). Copies
  legacy status-null Card rows into canonical `cards`, adds `chat_sessions.card_id`, and creates
  `lorebook_card_links` while retaining the legacy rows/column/links for consumer cutover. Apply
  by hand with:
  `docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0133_cards_runtime_characters_foundation.sql`.
- `0134_destructive_cards_cutover.sql` — destructive cutover for the same split
  (`docs/plans/cards-runtime-characters/3_IMPLEMENTATION_PLAN.md` §4.2). Removes legacy
  Card rows from `characters`, drops `chat_sessions.character_id`, removes Card-only columns
  from `characters`, and tightens runtime status constraints. Fails fast if any Card row
  lacks a canonical counterpart. Apply by hand with:
  `docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0134_destructive_cards_cutover.sql`.
- `0135_cards_runtime_characters_fixes.sql` — fixes for `docs/plans/cards-runtime-characters/4_ISSUES.md` review of `722f648..cafc832`. Restores `cards.card_id DEFAULT gen_random_uuid()` (Issue 1) and adds `chat_sessions_rp_requires_card` check `kind != 'rp' OR card_id IS NOT NULL` (Issue 2). Historical check on live DB (2026-08-22): 13 sessions, 8 `rp` with `card_id`, 5 `chat` with `card_id IS NULL` and zero `character_chat_links` — no historical `rp` chat was orphaned when `0134` dropped `character_id`. Apply by hand with:
  `docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < db/migrations/0135_cards_runtime_characters_fixes.sql`.
