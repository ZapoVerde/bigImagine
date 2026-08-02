/**
 * @file plugins/temporal/src/index.ts
 * @stamp 2026-07-29
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as calendar/lists): an `info` object,
 * an async `registerTools`, and `startBackgroundJobs`. Unlike calendar/lists' background jobs
 * (external feed polling, best-effort/optional), both poll loops here are unconditional —
 * active_timers/scheduled_jobs are native tables, nothing to resolve a credential for first.
 * schedule_routine closes over deps.settings to default a new alarm's timezone to
 * household_timezone, same pattern date_math (plugins/math-utils) and get_calendar_schedule use.
 *
 * jobPoll.ts's alarm loop is the one exception that does resolve a credential first: ntfy_topic,
 * the same one plugins/notifications' own registerTools resolves to decide whether to offer
 * send_push_notification at all. Resolved independently here (not imported from that plugin —
 * a plugin depends on @bigbrain/orchestrator, never on another plugin, same as this file's own
 * doc for @bigbrain/orchestrator/ntfy-provider explains) so a fired alarm can still deliver even
 * in the (currently impossible, but not structurally prevented) case that plugin load order ever
 * changes. A missing topic just means jobPoll.ts advances alarm state without ever delivering
 * anything — same "not sent, cleanly observable" shape as the tool's own live check.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [set_timer, cancel_timer, list_temporal_state, schedule_routine]
 * startBackgroundJobs(deps) — starts the active_timers poll loop (timerPoll.ts) and the
 *   scheduled_jobs alarm poll loop (jobPoll.ts)
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO; resolves a credential; starts two background poll timers)
 *     state_ownership: [the active_timers poll timer and the scheduled_jobs poll timer, once started]
 *     external_io:     [Postgres, via deps.credentials]
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createNtfyProvider } from '@bigbrain/orchestrator/ntfy-provider';
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
  const topic = await deps.credentials.resolve('ntfy_topic', process.env.BIGBRAIN_NTFY_TOPIC);
  const provider = topic ? createNtfyProvider(topic) : undefined;
  startJobPollLoop(deps.db, provider, deps.settings);
}
