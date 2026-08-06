/**
 * @file orchestrator/src/io/orchestratorSettings.ts
 * @stamp 2026-07-24
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
 * into anything at boot — unlike active_llm_profile/active_llm_model, changing it takes effect
 * immediately, no restart needed, since it's just interpolated into a system message per request.
 *
 * llm_vision_capable_profiles is the one value here that isn't a bare scalar: a JSON-encoded array
 * of BIGBRAIN_LLM_PROFILES names an admin has marked vision-capable (io/llm/profiles.ts's
 * LlmProfile.supportsVision), read once at boot (index.ts) alongside active_llm_profile —
 * same restart-on-save shape, since it's spliced into the static profiles JSON the same way
 * withOverriddenApiKeys/withOverriddenModel already are. A single scalar can't express this: a
 * chat can pick any configured profile via its own connection override (server/httpServer.ts's
 * sessionParams.profile), not just the household-wide active one, so the flag has to be per
 * profile name, not per "the active choice."
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
  'canon_recall_top_k',
  'canon_extraction_prompt',
  'screen_lock_password',
  'screen_lock_timeout_minutes',
  'pia_proxy_url',
  'persona_name',
  'persona_description',
  'llm_gate_max_concurrent',
  'llm_gate_max_concurrent_agent_routine',
  'llm_gate_max_retries',
  'llm_gate_retry_base_ms',
  'llm_gate_retry_max_ms',
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
