// Proves the weather plugin end to end through info/registerTools (the real loader contract),
// plus openMeteoProvider.ts's request/response shape directly against a stubbed global fetch
// keyed by hostname — same stubbed-fetch approach as plugins/web's verify-web-search.mjs. No
// Postgres/credentials involved: this plugin needs neither.

import { info, registerTools } from '../dist/index.js';
import { geocodeLocation, getForecast } from '../dist/openMeteoProvider.js';
import { describeWeatherCode } from '../dist/weatherCodes.js';
import { createGetWeatherTool } from '../dist/getWeatherTool.js';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

assert(
  info.id === 'weather' && /^[a-z0-9_-]+$/.test(info.id),
  'info.id is present and matches the id format pluginLoader.ts requires',
);

// --- registerTools is unconditional (no credential needed) ---
{
  const tools = await registerTools({});
  assert(tools.length === 1, 'registerTools returns exactly one tool');
  const registry = createToolRegistry(tools);
  assert(registry.definitions().some((d) => d.name === 'get_weather'), 'get_weather is registered');
}

// --- weatherCodes: known code + fallback for unknown ---
{
  assert(describeWeatherCode(0) === 'Clear sky', 'code 0 maps to "Clear sky"');
  assert(describeWeatherCode(95) === 'Thunderstorm', 'code 95 maps to "Thunderstorm"');
  assert(describeWeatherCode(12345) === 'Unknown (code 12345)', 'an unrecognized code falls back instead of throwing');
}

// --- geocodeLocation: request shape, label composition, no-match, and error handling ---
{
  const originalFetch = globalThis.fetch;
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      status: 200,
      async json() {
        return { results: [{ name: 'Berlin', latitude: 52.52, longitude: 13.41, admin1: 'Berlin', country: 'Germany' }] };
      },
    };
  };
  try {
    const result = await geocodeLocation('Berlin');
    assert(capturedUrl.includes('name=Berlin'), 'the query is encoded into the geocoding request');
    assert(result.latitude === 52.52 && result.longitude === 13.41, 'lat/lon are passed through');
    assert(result.name === 'Berlin, Berlin, Germany', 'the label composes name/admin1/country');
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return {}; } });
  try {
    const result = await geocodeLocation('Nowhereville');
    assert(result === undefined, 'no geocoding match returns undefined, not a thrown error');
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => ({ ok: false, status: 500, async json() { return {}; } });
  try {
    let threw = false;
    try {
      await geocodeLocation('anywhere');
    } catch {
      threw = true;
    }
    assert(threw, 'a non-ok geocoding response throws');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- getForecast: unit mapping, day capping, and response parsing ---
{
  const originalFetch = globalThis.fetch;
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          current: {
            temperature_2m: 72,
            apparent_temperature: 70,
            relative_humidity_2m: 40,
            wind_speed_10m: 5,
            precipitation: 0,
            weather_code: 1,
          },
          daily: {
            time: ['2026-07-25', '2026-07-26'],
            temperature_2m_max: [75, 78],
            temperature_2m_min: [60, 62],
            precipitation_probability_max: [10, 20],
            weather_code: [1, 61],
          },
        };
      },
    };
  };
  try {
    const forecast = await getForecast(47.6, -122.3, 'imperial', 30); // days over MAX_DAYS
    assert(capturedUrl.includes('temperature_unit=fahrenheit'), 'imperial units map to fahrenheit');
    assert(capturedUrl.includes('wind_speed_unit=mph'), 'imperial units map to mph');
    assert(capturedUrl.includes('forecast_days=7'), 'days is capped at MAX_DAYS (7) even when a caller asks for more');

    assert(forecast.current.temperature === 72 && forecast.current.feelsLike === 70, 'current temperature/feelsLike pass through');
    assert(forecast.current.conditions === 'Mainly clear', 'current weather_code is described');
    assert(forecast.daily.length === 2, 'both daily entries are present');
    assert(forecast.daily[1].conditions === 'Slight rain' && forecast.daily[1].high === 78, 'a daily entry maps code/high/low/precip correctly');
    assert(forecast.units.temperature === '°F', 'units reflect the imperial request');
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return {}; } });
  try {
    let threw = false;
    try {
      await getForecast(0, 0);
    } catch {
      threw = true;
    }
    assert(threw, 'a response missing current conditions throws rather than returning a hollow result');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- getWeatherTool: validation, not-found path, found path ---
{
  const tool = createGetWeatherTool();

  let threw = false;
  try {
    await tool.handler({}, { userId: 'x', db: undefined });
  } catch {
    threw = true;
  }
  assert(threw, 'get_weather requires a non-empty location argument');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('geocoding-api')) {
      return { ok: true, status: 200, async json() { return {}; } }; // no match
    }
    throw new Error('forecast should not be called when geocoding finds nothing');
  };
  try {
    const result = await tool.handler({ location: 'Nowhereville' }, { userId: 'x', db: undefined });
    assert(result.found === false, 'get_weather reports found:false rather than throwing for an unresolved location');
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async (url) => {
    if (url.includes('geocoding-api')) {
      return { ok: true, status: 200, async json() { return { results: [{ name: 'Testville', latitude: 1, longitude: 2 }] }; } };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          current: { temperature_2m: 20, weather_code: 0 },
          daily: { time: [], temperature_2m_max: [], temperature_2m_min: [], weather_code: [] },
        };
      },
    };
  };
  try {
    const result = await tool.handler({ location: 'Testville' }, { userId: 'x', db: undefined });
    assert(result.found === true && result.location === 'Testville' && result.current.temperature === 20, 'get_weather returns full forecast data for a resolved location');
  } finally {
    globalThis.fetch = originalFetch;
  }
}
