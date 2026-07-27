/**
 * @file plugins/temporal/src/index.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as calendar/lists): an `info` object,
 * an async `registerTools`, and `startBackgroundJobs`. Unlike calendar/lists' background jobs
 * (external feed polling, best-effort/optional), this one is unconditional — active_timers is a
 * native table, nothing to resolve a credential for first.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(_deps) — returns [set_timer, cancel_timer, list_temporal_state]
 * startBackgroundJobs(deps) — starts the active_timers poll loop (timerPoll.ts)
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO; starts a background poll timer)
 *     state_ownership: [the active_timers poll timer, once started]
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createSetTimerTool } from './setTimerTool.js';
import { createCancelTimerTool } from './cancelTimerTool.js';
import { createListTemporalStateTool } from './listTemporalStateTool.js';
import { startTimerPollLoop } from './timerPoll.js';

export const info = {
  id: 'temporal',
  name: 'Temporal',
  description: 'Focus timers: server-side countdowns that survive a restart.',
};

export async function registerTools(_deps: PluginDeps): Promise<RegisteredTool[]> {
  return [createSetTimerTool(), createCancelTimerTool(), createListTemporalStateTool()];
}

export async function startBackgroundJobs(deps: PluginDeps): Promise<void> {
  startTimerPollLoop(deps.db);
}
