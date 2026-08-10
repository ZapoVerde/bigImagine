/**
 * @file orchestrator/src/io/orchestratorSettings.ts
 * @stamp 2026-08-10
 * @architectural-role IO Wrapper — DB-backed household-wide orchestrator settings
 * @description
 * Backs orchestrator_settings (db/migrations/0010_orchestrator_settings.sql,
 * 0015_settings_owner_ids.sql) — the plaintext
 * counterpart to providerCredentials.ts's encrypted store. Same fixed-vocabulary, no-RLS,
 * household-wide shape, but values here are never secret (a connection profile/model/timezone
 * *name*, not an API key), so get() can just hand the plaintext back — unlike
 * providerCredentials.ts, this store is meant to be read back and displayed, not only reported as
 * "configured".
 *
 * household_timezone (an IANA zone name, e.g. "America/New_York") is read fresh on every chat
 * turn (server/httpServer.ts's handleChatCompletions, via util/dateContext.ts) rather than baked
 * into anything at boot — changing it takes effect immediately, no restart needed, since it's just
 * interpolated into a system message per request.
 *
 * active_llm_profile/active_llm_model/llm_vision_capable_profiles are retired: LLM connections are
 * now real, admin-managed rows (db/migrations/0062_llm_connections.sql, io/llmConnections.ts) with
 * their own is_active/supports_vision columns, not a static BIGBRAIN_LLM_PROFILES map overlaid with
 * settings-store patches. These three keys stay in SETTING_NAMES rather than being narrowed out —
 * same "only ever widen, never narrow" precedent as 0010's own CHECK constraint (see this file's
 * README entry) and CREDENTIAL_NAMES' still-present deepseek/openrouter entries
 * (io/providerCredentials.ts) — purely so index.ts's one-time llm_connections seed can still read a
 * pre-cutover deployment's values on its first boot after upgrading. Nothing reads them after that.
 *
 * ntfy_server_url (plugins/notifications) is the URL the orchestrator itself posts to — not a
 * secret (§12), just a selector. Deliberately the internal
 * container address (http://ntfy:80), not the public hostname the phone app uses; the orchestrator
 * and ntfy share a Docker network, so its own sends never need to leave it. notifications_enabled is
 * the household kill switch for send_push_notification: read live on every call, same no-restart
 * shape as household_timezone, so turning notifications off from the Settings tab takes effect
 * immediately rather than needing a redeploy. Unset (falsy) by default — the tool stays quiet
 * until an operator explicitly opts in, same caution as any other best-effort plugin gate.
 *
 * agent_routines_enabled (db/migrations/0035_agent_routine_dispatch.sql) is the household kill
 * switch for scheduled_jobs' 'agent_routine' dispatch (orchestrator/src/orchestrator/
 * agentRoutineDispatch.ts) — read live before every dispatch, same no-restart shape as
 * notifications_enabled, and the literal same value both a Settings-tab manual toggle and
 * io/llm/llmGate.ts's own household-cap breach reaction write to. Unset (falsy) by default, same
 * caution as notifications_enabled. agent_routine_max_runs_per_day/agent_routine_max_tokens_per_day
 * are the household-wide rolling-24h caps llmGate.ts checks alongside each job's own per-job
 * caps (scheduled_jobs.max_runs_per_day/max_tokens_per_day); unset means "use the conservative
 * built-in default" (llmGate.ts's own constants), not "unlimited". agent_routines_disabled_reason
 * is set alongside agent_routines_enabled whenever the switch flips itself off, so Settings can
 * show *why* rather than a bare toggle — same "state plus reason" shape as scheduled_jobs'
 * capped_reason.
 *
 * chat_memory_profile/chat_memory_live_window_pairs/chat_memory_sync_every_pairs/
 * chat_memory_digest_horizon_pairs/chat_memory_chunk_summary_prompt/chat_memory_distill_prompt/
 * chat_memory_household_memory_prompt (docs/chat-memory.md, orchestrator/src/orchestrator/
 * chatMemorySync.ts) are read live on every sync tick, same no-restart shape as
 * household_timezone — mirrors SillyTavern-Canonize's own "Connections & Prompts" settings panel: a
 * household connection override for the sync pipeline's classification calls (unset = the active
 * connection, same fallback a chat's own params.profile uses), three timing knobs in turn-pairs
 * (Canonize's own unit — live window, sync-every, and digest-horizon, the last being this
 * platform's analogue of Canonize's bridge-summary horizon: how far back distillChatMemory
 * re-reads chat_chunks, not just what the current tick freshly produced), and a "default +
 * bespoke" override per prompt — unset or empty means "use the built-in default" (each
 * io/chatMemory/*.ts module exports its own DEFAULT_* constant), a non-empty value overrides it
 * entirely. There is no separate "reset" operation: writing '' is how Settings clears an override
 * back to the default. Every one of these six chat_memory_* keys was missing from 0010's CHECK
 * constraint until 0043 added them — see db/migrations/README.md's 0043 entry.
 *
 * chat_memory_bridge_prompt (io/chatMemory/bridgeChatMemory.ts) is the 'rp'-kind sync lane's
 * counterpart to chat_memory_distill_prompt — same "default + bespoke" override shape, but for the
 * hookseeker-parity bridge call (SCENE/EVENTS/PLOT) rather than the household digest. 'chat'-kind
 * chats never read this key; distillChatMemory.ts and this key's prompt are mutually exclusive per
 * chat, selected once by chat_sessions.kind. Added to 0010's CHECK constraint by a later migration
 * — see db/migrations/README.md's corresponding entry.
 *
 * chat_memory_lorebook_curator_prompt (io/chatMemory/curateLorebook.ts) and
 * chat_memory_people_curator_prompt (io/chatMemory/curatePeople.ts) are the 'rp'-kind sync lane's
 * other two periodic curators — place/thing/concept and person respectively — same "default +
 * bespoke" override shape, run every tick alongside chat_memory_bridge_prompt, not in place of it.
 * Added to 0010's CHECK constraint by db/migrations/0065_chat_memory_curator_settings.sql.
 *
 * chat_memory_auto_recall_enabled / chat_memory_auto_recall_pairs /
 * chat_memory_auto_recall_chunk_top_k (io/chatMemory/recallForPrompt.ts, migration 0077) are the
 * RP read path's three retrieval knobs, read live on every RP prompt assembly, no restart —
 * mirrors the knobs Canonize exposes for its RAG retrieval (rag.md). auto_recall_enabled is
 * 'true'/'false' (default 'true': the silent CNZ-style auto-recall is on; 'false' disables the
 * injection without touching the recall tools, which stay in the RP allow-list), auto_recall_pairs
 * is how many trailing turn-pairs form the query (default '3' — the old AUTO_RECALL_PAIRS
 * constant), and auto_recall_chunk_top_k is how many archived full-turn chunks get injected
 * (default '4' — the old AUTO_RECALL_CHUNK_TOP_K constant). The fact count (canon_recall_top_k)
 * was already a key; it is read by the same module. Unset or corrupt values fall back to the
 * built-in defaults, same fail-open shape as every other numeric setting here.
 *
 * canon_recall_top_k/canon_extraction_prompt (docs/canonize-plan.md §6, plugins/canonize,
 * migration 0048) are the Canonize feature's two settings: canon_recall_top_k (integer-as-text,
 * default '8' — how many facts recall_canon_facts returns) is read live by the recall tool on
 * every call; canon_extraction_prompt is the background extraction call's prompt template
 * (bi_principles.md §18 — empty override means "use the built-in default"), read by the future
 * Director Pass wiring. Both were added to 0010's CHECK constraint together in 0048, the same
 * widen-both-sides shape 0043's own entry documents.
 *
 * screen_lock_password/screen_lock_timeout_minutes (migration 0050) back the idle-timeout re-lock
 * overlay (ScreenLockOverlay.tsx, ported from SillyTavern-Playground's lockScreen.js) —
 * screen_lock_password isn't a secret by §12's own test (it protects nothing the real household-
 * key/Access auth hasn't already gated), so like every other value in this store it's read back
 * and displayed in full, not just reported as "configured". Unset/empty disables the feature.
 * screen_lock_timeout_minutes is the idle window in minutes; both are read live, no restart.
 *
 * pia_proxy_url (migration 0052, io/piaProxyFetch.ts) is the internal address of the standalone
 * pia-proxy container (stacks/pia-proxy, a sibling Dockge stack, not part of this codebase) that
 * routes a fetch through a real PIA WireGuard tunnel — chub.ai blocks Australian IPs, and this is
 * how plugins/characters' chub import/search tools reach it anyway. Same selector shape as
 * ntfy_server_url: a plain internal container URL (http://pia-proxy:8080), not a secret, read live
 * on every call rather than baked in at boot.
 *
 * persona_name/persona_description (migration 0053, docs/prompt-macros.md's Stage 1) are the
 * household's own name and self-description — BigImagine's analogue of SillyTavern's user
 * persona. Deliberately the simplified single-persona shape the ST port settled on: no positions,
 * no multiple saved personas, just a name and a description read live by
 * plugins/context-stack-presets' applyPromptStackToChatTool.ts and folded into the prompt stack's
 * `persona` marker slot when a preset enables it — same no-restart, read-back-in-full shape as
 * screen_lock_password.
 *
 * llm_gate_max_concurrent/llm_gate_max_concurrent_agent_routine/llm_gate_max_retries/
 * llm_gate_retry_base_ms/llm_gate_retry_max_ms (migration 0056, docs/llm-gate-plan.md) tune the
 * gate's retry/queueing behavior (io/llm/llmGate.ts, llmQueue.ts, llmBackoff.ts) — read live on
 * every complete() call, same no-restart shape as everything else in this file. The two
 * max_concurrent keys are separate per-lane caps (interactive chat/system calls vs. background
 * agent_routine calls), not one shared number, so a background sync/extraction burst can never
 * delay a live turn the household is waiting on. Unset means "use the gate's own conservative
 * built-in default" (llmGate.ts's own DEFAULT_* constants), not "unlimited"/"no retry" — same
 * fallback shape as the agent_routine caps above.
 *
 * chat_background_parallax (docs/vistalyze_integration/parallax_fade_teststep.md §2.2, migration
 * 0069) is the toggle for the ChatView location-background's parallax pan (frontend module
 * components/chat/backgroundParallax.ts): stored as text 'true'/'false', default false when
 * unset — matching SillyTavern-Vistalyze's own parallaxEnabled=false default. Read live by the
 * frontend at chat load via GET /v1/chat-background-settings, same no-restart shape as
 * household_timezone (the value is fetched fresh, never baked in at boot), written by the
 * admin-gated SettingsView "Chat Background" toggle.
 *
 * chat_background_overlay_opacity / chat_background_overlay_shade /
 * chat_background_bubble_opacity / chat_background_bubble_user_shade /
 * chat_background_bubble_assistant_shade (migration 0073, the ChatView background FX settings)
 * are the rest of that same "Chat Background" fieldset: the dimming veil over the location
 * background (opacity text '0'..'1' default 0.5, shade hex default '#000000') and the bubble
 * fill (opacity text '0'..'1' default 0.7, user/assistant shade hexes defaulting to the dark-
 * theme bubble colors '#4f46e5'/'#26272c'). Same read-live-at-chat-load shape as parallax; the
 * frontend applies them as CSS custom properties on the chat view, so no restart and no rebuild
 * for a look change.
 *
 * chat_legibility_halo / chat_legibility_outline / chat_legibility_solid_code /
 * chat_legibility_weight / chat_legibility_hover_focus (migration 0074) are the ChatView "Text
 * legibility" toggles — opt-in text-rendering tricks for prose on translucent bubbles over the
 * location background, exposed as a collapsible menu in the chat settings rail (frontend module
 * components/chat/LegibilityMenu.tsx). Stored as text 'true'/'false', default false when unset
 * (opt-in, matching the built-in look). Read live by ChatView at chat load via
 * GET /v1/chat-legibility-settings and applied as data-legibility tokens on the chat view root;
 * each toggle immediately POSTs its partial patch to the admin-gated
 * POST /v1/admin/chat-legibility-settings — household-wide, so one set applies to all chats.
 *
 * chat_legibility_halo_strength (migration 0075) is the intensity dial under the Letter halo
 * toggle: text '0'..'1', default 0.6 when unset. Applied in ChatView.css as a color-mix
 * percentage over the per-theme halo colors (their own alpha preserved, strength multiplied on
 * top), so 0 = invisible ring, 1 = the full-force ring (the pre-0075 look, which read as too
 * strong). Same read-live-at-chat-load shape; written by the admin-gated slider in the same
 * menu, no restart.
 *
 * cleanup_header_regex/cleanup_header_prompt/cleanup_footer_regex/cleanup_footer_prompt
 * (migration 0072, the async heuristic cleanup subloop) are the Cleanup page's setup config:
 * the two editable regex triggers (header two-line shape `[ … | … | …]` + `Present: …`; footer
 * `<details>` inner-thoughts block) and the two repair prompts fired when the regex fails to
 * match. The header prompt resolves {{history, x}} (last x turn pairs) and {{message}}; the
 * footer prompt resolves {{message}} only. Empty regex = the loop's built-in default pattern;
 * empty prompt = the built-in default repair text — same "empty override means built-in"
 * fallback shape as every other prompt key (bi_principles.md §18). Written by the admin-gated
 * cleanup-settings endpoint, read live by the subloop, no restart.
 *
 * location_describer_prompt/location_describer_history_pairs (migration 0078,
 * docs/vistalyze_integration/describer.md) are the room-description LLM pass's two keys — the
 * pass that turns a freshly-minted location's name-seeded visual_description into a real room
 * description (BigImagine's analogue of SillyTavern-Vistalyze's Step 3 Describer), fired in the
 * same decoupled chain as the image render and awaited before it. describer_prompt is the full
 * prompt template ({{location_name}}, {{context}}; empty = the built-in default in
 * describeLocation.ts — same §18 fallback as every prompt key), describer_history_pairs is how
 * many trailing turn-pairs form the narrative context (integer-as-text, default '1', VLZ's
 * describerHistory). Read live on every pass, no restart, editable from the Settings tab's Image
 * Generation fieldset.
 *
 * @api-declaration
 * SETTING_NAMES — the fixed vocabulary (mirrors 0010's CHECK constraint)
 * createOrchestratorSettingsStore(db) -> OrchestratorSettingsStore
 *   .get(key) -> Promise<string | undefined> — the stored value, or undefined if never set
 *   .set(key, value) -> Promise<void> — upsert
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via db.withSystemScope)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { PostgresClient } from './postgres.js';

export const SETTING_NAMES = [
  'active_llm_profile',
  'active_llm_model',
  'household_timezone',
  'llm_vision_capable_profiles',
  'ntfy_server_url',
  'notifications_enabled',
  'agent_routines_enabled',
  'agent_routine_max_runs_per_day',
  'agent_routine_max_tokens_per_day',
  'agent_routines_disabled_reason',
  'chat_memory_profile',
  'chat_memory_live_window_pairs',
  'chat_memory_sync_every_pairs',
  'chat_memory_digest_horizon_pairs',
  'chat_memory_chunk_summary_prompt',
  'chat_memory_distill_prompt',
  'chat_memory_household_memory_prompt',
  'chat_memory_bridge_prompt',
  'chat_memory_lorebook_curator_prompt',
  'chat_memory_people_curator_prompt',
  'chat_memory_auto_recall_enabled',
  'chat_memory_auto_recall_pairs',
  'chat_memory_auto_recall_chunk_top_k',
  'chat_memory_inject_bridge_prompt',
  'chat_memory_inject_plot_prompt',
  'chat_memory_inject_auto_recall_prompt',
  'chat_memory_auto_recall_chunk_prompt',
  'chat_memory_inject_recent_history_prompt',
  'canon_recall_top_k',
  'canon_extraction_prompt',
  'screen_lock_password',
  'screen_lock_timeout_minutes',
  'pia_proxy_url',
  'persona_name',
  'persona_description',
  'llm_gate_max_concurrent',
  'llm_gate_max_concurrent_agent_routine',
  'llm_gate_max_concurrent_background',
  'llm_gate_max_retries',
  'llm_gate_retry_base_ms',
  'llm_gate_retry_max_ms',
  'image_prompt_template',
  'chat_background_parallax',
  'cleanup_header_regex',
  'cleanup_header_prompt',
  'cleanup_footer_regex',
  'cleanup_footer_prompt',
  'chat_background_overlay_opacity',
  'chat_background_overlay_shade',
  'chat_background_bubble_opacity',
  'chat_background_bubble_user_shade',
  'chat_background_bubble_assistant_shade',
  'chat_legibility_halo',
  'chat_legibility_outline',
  'chat_legibility_solid_code',
  'chat_legibility_weight',
  'chat_legibility_hover_focus',
  'chat_legibility_halo_strength',
  'location_describer_prompt',
  'location_describer_history_pairs',
] as const;
export type SettingName = (typeof SETTING_NAMES)[number];

export interface OrchestratorSettingsStore {
  get(key: SettingName): Promise<string | undefined>;
  set(key: SettingName, value: string): Promise<void>;
}

export function createOrchestratorSettingsStore(db: PostgresClient): OrchestratorSettingsStore {
  return {
    async get(key) {
      const rows = await db.withSystemScope((session) =>
        session.query<{ value: string }>('select value from orchestrator_settings where key = $1', [key]),
      );
      return rows[0]?.value;
    },

    async set(key, value) {
      await db.withSystemScope((session) =>
        session.query(
          `insert into orchestrator_settings (key, value, updated_at) values ($1, $2, now())
           on conflict (key) do update set value = excluded.value, updated_at = now()`,
          [key, value],
        ),
      );
    },
  };
}
