/**
 * @file plugins/weather/src/getWeatherTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — the get_weather RegisteredTool
 * @description
 * Takes a free-text location (whatever the user said — "Seattle", "Berlin, Germany") and returns
 * current conditions plus a short daily forecast. Geocoding failure is reported as
 * { found: false } rather than thrown, same soft-not-found shape as get_recipe/meal planning
 * elsewhere in this codebase — an unrecognized place name is an expected outcome, not a bug.
 *
 * No ctx.db/ctx.userId use: weather isn't household data, so no user_id scoping applies
 * (bb_principles.md §4 governs data that *is* user-owned; this has none) — same reasoning as
 * plugins/web's web_search.
 *
 * @api-declaration
 * createGetWeatherTool() — returns the get_weather RegisteredTool; no constructor dependencies,
 *   since Open-Meteo needs no credential (openMeteoProvider.ts)
 *
 * @contract
 *   assertions:
 *     purity:          impure (delegates to openMeteoProvider.ts's network calls)
 *     state_ownership: []
 *     external_io:     [Open-Meteo, via openMeteoProvider.ts]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { geocodeLocation, getForecast, type Units } from './openMeteoProvider.js';

interface GetWeatherArgs {
  location: string;
  units?: Units;
  days?: number;
}

function isGetWeatherArgs(value: unknown): value is GetWeatherArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.location !== 'string' || v.location === '') return false;
  if (v.units !== undefined && v.units !== 'metric' && v.units !== 'imperial') return false;
  if (v.days !== undefined && typeof v.days !== 'number') return false;
  return true;
}

export function createGetWeatherTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_weather',
      description:
        'Get current weather conditions and a short daily forecast for a location (e.g. "Seattle" or "Berlin, Germany").',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'A place name to look up.' },
          units: { type: 'string', enum: ['metric', 'imperial'], description: 'Unit system (default metric).' },
          days: { type: 'number', description: 'Number of forecast days to include (default 3, max 7).' },
        },
        required: ['location'],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      if (!isGetWeatherArgs(args)) {
        throw new Error('get_weather requires a non-empty location: string argument');
      }

      const place = await geocodeLocation(args.location);
      if (!place) {
        return { found: false, location: args.location };
      }

      const forecast = await getForecast(place.latitude, place.longitude, args.units, args.days);
      return { found: true, location: place.name, ...forecast };
    },
  };
}
