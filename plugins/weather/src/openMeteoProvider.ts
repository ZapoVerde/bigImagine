/**
 * @file plugins/weather/src/openMeteoProvider.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — Open-Meteo geocoding + forecast API access
 * @description
 * Open-Meteo chosen over a keyed provider (OpenWeatherMap/WeatherAPI) specifically because it's
 * free and requires no API key for this scale of use — no new provider_credentials entry, no
 * migration, no Settings-tab wiring, unlike plugins/web's brave_api_key. Geocoding (place name ->
 * lat/lon) is a separate free endpoint on the same service, used to resolve whatever location
 * string the LLM passes before the forecast call.
 *
 * Two calls per get_weather invocation (geocode, then forecast) rather than one, because
 * Open-Meteo's forecast endpoint takes coordinates, not a place name — there is no single-request
 * "weather for this city" shape to collapse them into.
 *
 * @api-declaration
 * GeocodeResult — { name, latitude, longitude }
 * ForecastResult — { current: {...}, daily: [...] }
 * geocodeLocation(query) -> GeocodeResult | undefined — undefined means no match, not an error
 * getForecast(latitude, longitude, units, days) -> ForecastResult
 *
 * @contract
 *   assertions:
 *     purity:          impure (network calls)
 *     state_ownership: []
 *     external_io:     [Open-Meteo geocoding API, Open-Meteo forecast API]
 */

import { fetchWithRetry } from '@bigbrain/orchestrator/http-retry';
import { log } from '@bigbrain/orchestrator/logger';
import { describeWeatherCode } from './weatherCodes.js';

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const MAX_DAYS = 7;

export type Units = 'metric' | 'imperial';

export interface GeocodeResult {
  name: string;
  latitude: number;
  longitude: number;
}

export interface DailyForecast {
  date: string;
  high: number;
  low: number;
  precipitationChance: number;
  conditions: string;
}

export interface ForecastResult {
  current: {
    temperature: number;
    feelsLike: number;
    humidity: number;
    windSpeed: number;
    precipitation: number;
    conditions: string;
  };
  daily: DailyForecast[];
  units: { temperature: string; windSpeed: string; precipitation: string };
}

interface GeocodingResponse {
  results?: { name?: string; latitude?: number; longitude?: number; admin1?: string; country?: string }[];
}

interface ForecastResponse {
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    precipitation?: number;
    weather_code?: number;
  };
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
    weather_code?: number[];
  };
}

export async function geocodeLocation(query: string): Promise<GeocodeResult | undefined> {
  const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
  const response = await fetchWithRetry(url, {});

  if (!response.ok) {
    log.warn(`weather: geocoding request failed with HTTP ${response.status} for "${query}"`);
    throw new Error(`Open-Meteo geocoding API returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as GeocodingResponse;
  const match = body.results?.[0];
  if (!match || match.latitude === undefined || match.longitude === undefined) {
    log.info(`weather: no geocoding match for "${query}"`);
    return undefined;
  }

  const label = [match.name, match.admin1, match.country].filter(Boolean).join(', ');
  return { name: label || query, latitude: match.latitude, longitude: match.longitude };
}

export async function getForecast(
  latitude: number,
  longitude: number,
  units: Units = 'metric',
  days = 3,
): Promise<ForecastResult> {
  const boundedDays = Math.max(1, Math.min(days, MAX_DAYS));
  const temperatureUnit = units === 'imperial' ? 'fahrenheit' : 'celsius';
  const windSpeedUnit = units === 'imperial' ? 'mph' : 'kmh';
  const precipitationUnit = units === 'imperial' ? 'inch' : 'mm';

  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,precipitation,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    temperature_unit: temperatureUnit,
    wind_speed_unit: windSpeedUnit,
    precipitation_unit: precipitationUnit,
    forecast_days: String(boundedDays),
    timezone: 'auto',
  });

  const response = await fetchWithRetry(`${FORECAST_URL}?${params.toString()}`, {});
  if (!response.ok) {
    log.warn(`weather: forecast request failed with HTTP ${response.status} for (${latitude}, ${longitude})`);
    throw new Error(`Open-Meteo forecast API returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as ForecastResponse;
  const current = body.current;
  if (!current || current.temperature_2m === undefined) {
    throw new Error('Open-Meteo forecast API response is missing current conditions');
  }

  const dailyTimes = body.daily?.time ?? [];
  const daily: DailyForecast[] = dailyTimes.map((date, i) => ({
    date,
    high: body.daily!.temperature_2m_max![i],
    low: body.daily!.temperature_2m_min![i],
    precipitationChance: body.daily!.precipitation_probability_max?.[i] ?? 0,
    conditions: describeWeatherCode(body.daily!.weather_code![i]),
  }));

  return {
    current: {
      temperature: current.temperature_2m,
      feelsLike: current.apparent_temperature ?? current.temperature_2m,
      humidity: current.relative_humidity_2m ?? 0,
      windSpeed: current.wind_speed_10m ?? 0,
      precipitation: current.precipitation ?? 0,
      conditions: describeWeatherCode(current.weather_code ?? -1),
    },
    daily,
    units: {
      temperature: units === 'imperial' ? '°F' : '°C',
      windSpeed: units === 'imperial' ? 'mph' : 'km/h',
      precipitation: units === 'imperial' ? 'in' : 'mm',
    },
  };
}
