/**
 * @file plugins/weather/src/index.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as web/calendar/lists): an `info`
 * object and an async `registerTools`. No startBackgroundJobs — get_weather is purely a per-call
 * tool. Unlike plugins/web, registration is unconditional: Open-Meteo needs no API key, so there's
 * no credential to resolve and no best-effort disable path.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(_deps) — returns [get_weather]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs a tool that does network IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createGetWeatherTool } from './getWeatherTool.js';

export const info = {
  id: 'weather',
  name: 'Weather',
  description: 'Current conditions and short forecast for a location (Open-Meteo, no API key required).',
};

export async function registerTools(_deps: PluginDeps): Promise<RegisteredTool[]> {
  return [createGetWeatherTool()];
}
