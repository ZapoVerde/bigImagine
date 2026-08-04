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
  `location`, `canon_facts`, `memory_recall`, `recent_history`) or a `custom` static block with its
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
  source of continuity. See `docs/chat-memory.md` and `docs/bi_principles.md` §18 (every prompt,
  and prompt-adjacent behavior knob, surfaced in Settings for manual tuning).
