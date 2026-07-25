/**
 * @file plugins/weather/src/weatherCodes.ts
 * @stamp 2026-07-25
 * @architectural-role Pure Function module — WMO weather code -> human description
 * @description
 * Open-Meteo's current/daily responses carry a bare numeric WMO code (weather_code), not text.
 * Mapping it to a human description is a fixed, mechanical lookup (the WMO table is a published
 * standard, not something bigBrain infers), so it stays a pure function rather than reasoning
 * the LLM should do (bb_principles.md §2 governs judgment/inference, not a static vocabulary
 * lookup like this one).
 *
 * @api-declaration
 * describeWeatherCode(code) -> string — falls back to "Unknown (code N)" for anything not in
 *   the table, rather than throwing, since Open-Meteo could add codes bigBrain doesn't know yet
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

const WMO_DESCRIPTIONS: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow fall',
  73: 'Moderate snow fall',
  75: 'Heavy snow fall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

export function describeWeatherCode(code: number): string {
  return WMO_DESCRIPTIONS[code] ?? `Unknown (code ${code})`;
}
