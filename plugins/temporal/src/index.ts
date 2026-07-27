/**
 * @file plugins/temporal/src/index.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as calendar/lists): an `info` object,
 * an async `registerTools`, and `startBackgroundJobs`. Unlike calendar/lists' background jobs
 * (external feed polling, best-effort/optional), both poll loops here are unconditional —
 * active_timers/scheduled_jobs are native tables, nothing to resolve a credential for first.
 * schedule_routine closes over deps.settings to default a new alarm's timezone to
 * household_timezone, same pattern date_math (plugins/math-utils) and get_calendar_schedule use.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [set_timer, cancel_timer, list_temporal_state, schedule_routine]
 * startBackgroundJobs(deps) — starts the active_timers poll loop (timerPoll.ts) and the
 *   scheduled_jobs alarm poll loop (jobPoll.ts)
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO; starts two background poll timers)
 *     state_ownership: [the active_timers poll timer and the scheduled_jobs poll timer, once started]
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createSetTimerTool } from './setTimerTool.js';
import { createCancelTimerTool } from './cancelTimerTool.js';
import { createListTemporalStateTool } from './listTemporalStateTool.js';
import { createScheduleRoutineTool } from './scheduleRoutineTool.js';
import { startTimerPollLoop } from './timerPoll.js';
import { startJobPollLoop } from './jobPoll.js';

export const info = {
  id: 'temporal',
  name: 'Temporal',
  description: 'Focus timers and alarms: server-side countdowns and reminders that survive a restart.',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  return [createSetTimerTool(), createCancelTimerTool(), createListTemporalStateTool(), createScheduleRoutineTool(deps.settings)];
}

export async function startBackgroundJobs(deps: PluginDeps): Promise<void> {
  startTimerPollLoop(deps.db);
  startJobPollLoop(deps.db);
}
