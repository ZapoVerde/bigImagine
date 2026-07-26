# Migrations

Mounted straight into the Postgres container as `/docker-entrypoint-initdb.d` (see
`docker-compose.yml`), so these run once, in filename order, only against a fresh volume:

- `0001_create_app_role.sh` — creates the non-superuser `bigbrain_app` role RLS actually applies to
- `0002_schema.sql` — `users`, `unstructured_notes`, `recipes_meals`, `shopping_logs`,
  `notion_sync_map`, `documents` (per `docs/spec.md` §3), RLS enabled+forced on every
  `user_id`-scoped table, grants to `bigbrain_app`

To change the schema after the volume already exists, add a new numbered file here (this
directory is not re-run against an existing volume) and apply it by hand, or wipe the volume in
dev. `../checks/verify_rls.sql` proves the RLS policies actually hold.

Already applied by hand, not run automatically (see the file for the exact command):
- `0003_phase3_schema_updates.sql` — resizes `vector_embed` from 1536 to 1024 dims (Voyage AI's
  models don't support 1536) and adds `unstructured_notes.category` /
  `unstructured_notes.summary_short`, which the original migration omitted despite the ingestion
  pipeline (`docs/spec.md` §6.1) producing both.
- `0008_provider_credentials.sql` — adds `provider_credentials`, the encrypted DB-backed home for
  the four provider API keys previously only in static env vars (`deepseek_api_key`,
  `openrouter_api_key`, `voyage_api_key`, `notion_token`). Household-wide system config, not
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
  from conversation (`create_note`/`get_notes`/`get_note`/`update_note`/`delete_note` tools), per
  the same plugin-tool pattern as `lists`/`recipes` — no dedicated REST routes.
- `0012_prompt_presets.sql` — adds `prompt_presets`: named, reusable system-prompt snippets
  ("instruction sets") for the Chat tab's per-chat settings pane (`plugins/prompt-presets`),
  standard `user_scoped` RLS. Same dual-surface shape as `notes` — picking one only copies its
  content into a chat's own `chat_sessions.params.system`; it is not a live reference, so editing
  or deleting a preset later never changes a chat that already used it.
- `0013_calendar.sql` — adds `calendar_events`: household calendar rows for the Calendar tab
  (`plugins/calendar`), standard `user_scoped` RLS. `source` (`'cozi' | 'outlook' | 'native'`) is
  `text` + a `CHECK` vocabulary, same closed-vocabulary choice as `provider_credentials.name` /
  `orchestrator_settings.key`, not a native Postgres enum. Cozi/Outlook rows come from
  `plugins/calendar/src/icsSync.ts`'s background poll (`BIGBRAIN_COZI_ICS_URL`/
  `BIGBRAIN_OUTLOOK_ICS_URL`, attributed to `BIGBRAIN_CALENDAR_OWNER_USER_ID`); native rows come
  from the `create_calendar_event` tool. No `color_code`/`is_read_only` columns — both are pure
  functions of `source` (`plugins/calendar/src/sourceMeta.ts`), computed at read time rather than
  stored. Google Calendar's 2-way OAuth sync is deferred to a later phase (`docs/spec.md` §6.7).
- `0014_calendar_ics_credentials.sql` — widens `provider_credentials.name`'s `CHECK` vocabulary
  with `cozi_ics_url`/`outlook_ics_url`. A feed URL is a capability secret exactly like an API key
  (`docs/bb_principles.md` §12) — same encrypted, write-only, Settings-tab-editable shape as the
  other four credentials, not a plain env var. `BIGBRAIN_CALENDAR_OWNER_USER_ID` and
  `BIGBRAIN_MASK_WORK_CALENDAR` stay plain env deliberately: neither grants access on its own.
- `0015_settings_owner_ids.sql` — widens `orchestrator_settings.key`'s `CHECK` vocabulary with
  `calendar_owner_user_id`/`mask_work_calendar` and `notion_owner_user_id`/
  `notion_lists_data_source_id`. None of the four is a secret (`docs/bb_principles.md` §12 — an
  owning user id is a selector, the mask flag is a toggle), but all four were still `.env`-only
  before this, which §13 treats as unfinished, not a legitimate third category: once the
  orchestrator can reach Postgres, non-secret runtime config belongs in the database and the
  Settings tab, not a redeploy. Same restart-on-save shape as `active_llm_profile` (each is read
  once, at boot, by whatever it configures — `plugins/calendar`'s ICS poll, `io/notion.ts`'s client
  construction), with the legacy `BIGBRAIN_*`-prefixed env var as the fallback until a value is set
  via `GET`/`POST /v1/admin/calendar-settings` or `/v1/admin/notion-settings`.
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
