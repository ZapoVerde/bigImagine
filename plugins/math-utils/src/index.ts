/**
 * @file plugins/math-utils/src/index.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as weather/web): an `info` object and
 * an async `registerTools`. No startBackgroundJobs — every tool here is a per-call calculation,
 * nothing to poll. calculate/convert_units/money_math need no dependencies at all (same as
 * get_weather); date_math closes over deps.settings to resolve household_timezone, the same
 * pattern plugins/calendar's get_calendar_schedule uses, so its "today" default agrees with what
 * the LLM was already told "today" is (orchestrator/src/util/dateContext.ts).
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [calculate, date_math, convert_units, money_math]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools; date_math's reads deps.settings per call)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createCalculateTool } from './calculatorTool.js';
import { createDateMathTool } from './dateMathTool.js';
import { createConvertUnitsTool } from './unitConversionTool.js';
import { createMoneyMathTool } from './moneyMathTool.js';

export const info = {
  id: 'math-utils',
  name: 'Math Utilities',
  description: 'Exact calculator, calendar date arithmetic, unit conversion, and financial math — no reasoning, just arithmetic.',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  return [createCalculateTool(), createDateMathTool(deps.settings), createConvertUnitsTool(), createMoneyMathTool()];
}
