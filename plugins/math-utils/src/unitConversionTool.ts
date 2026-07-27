/**
 * @file plugins/math-utils/src/unitConversionTool.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — the convert_units RegisteredTool
 * @description
 * bb_principles.md §2: unit conversion is a fixed factor lookup, not something to reason about.
 * Weight/length/volume/area/digital-storage units convert through a linear factor to one base
 * unit per dimension; temperature is the one non-linear dimension (offset, not just scale) and is
 * handled as its own special case. No library needed — this is a closed, small table.
 *
 * @api-declaration
 * createConvertUnitsTool() — returns the convert_units RegisteredTool; no constructor dependencies
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface LinearUnit {
  dimension: string;
  toBase: number; // 1 <unit> = toBase <dimension base unit>
}

// Base units: weight -> kilogram, length -> meter, volume -> liter, area -> square meter,
// digital -> byte.
const LINEAR_UNITS: Record<string, LinearUnit> = {
  mg: { dimension: 'weight', toBase: 0.000001 },
  g: { dimension: 'weight', toBase: 0.001 },
  kg: { dimension: 'weight', toBase: 1 },
  oz: { dimension: 'weight', toBase: 0.028349523125 },
  lb: { dimension: 'weight', toBase: 0.45359237 },

  mm: { dimension: 'length', toBase: 0.001 },
  cm: { dimension: 'length', toBase: 0.01 },
  m: { dimension: 'length', toBase: 1 },
  km: { dimension: 'length', toBase: 1000 },
  in: { dimension: 'length', toBase: 0.0254 },
  ft: { dimension: 'length', toBase: 0.3048 },
  yd: { dimension: 'length', toBase: 0.9144 },
  mi: { dimension: 'length', toBase: 1609.344 },

  ml: { dimension: 'volume', toBase: 0.001 },
  l: { dimension: 'volume', toBase: 1 },
  tsp: { dimension: 'volume', toBase: 0.00492892159375 },
  tbsp: { dimension: 'volume', toBase: 0.0147867647813 },
  fl_oz: { dimension: 'volume', toBase: 0.0295735295625 },
  cup: { dimension: 'volume', toBase: 0.2365882365 },
  pt: { dimension: 'volume', toBase: 0.473176473 },
  qt: { dimension: 'volume', toBase: 0.946352946 },
  gal: { dimension: 'volume', toBase: 3.785411784 }, // US gallon

  sqin: { dimension: 'area', toBase: 0.00064516 },
  sqft: { dimension: 'area', toBase: 0.09290304 },
  sqyd: { dimension: 'area', toBase: 0.83612736 },
  sqm: { dimension: 'area', toBase: 1 },
  acre: { dimension: 'area', toBase: 4046.8564224 },
  hectare: { dimension: 'area', toBase: 10000 },

  bit: { dimension: 'digital', toBase: 0.125 },
  byte: { dimension: 'digital', toBase: 1 },
  kb: { dimension: 'digital', toBase: 1024 },
  mb: { dimension: 'digital', toBase: 1024 ** 2 },
  gb: { dimension: 'digital', toBase: 1024 ** 3 },
  tb: { dimension: 'digital', toBase: 1024 ** 4 },
};

const TEMPERATURE_TO_CELSIUS: Record<string, (v: number) => number> = {
  c: (v) => v,
  f: (v) => ((v - 32) * 5) / 9,
  k: (v) => v - 273.15,
};

const CELSIUS_TO_TEMPERATURE: Record<string, (v: number) => number> = {
  c: (v) => v,
  f: (v) => (v * 9) / 5 + 32,
  k: (v) => v + 273.15,
};

export interface ConvertUnitsResult {
  result: number;
  dimension: string;
}

export function convertUnits(value: number, fromUnit: string, toUnit: string): ConvertUnitsResult {
  const from = fromUnit.toLowerCase();
  const to = toUnit.toLowerCase();

  if (from in TEMPERATURE_TO_CELSIUS && to in TEMPERATURE_TO_CELSIUS) {
    const celsius = TEMPERATURE_TO_CELSIUS[from](value);
    return { result: CELSIUS_TO_TEMPERATURE[to](celsius), dimension: 'temperature' };
  }

  const fromDef = LINEAR_UNITS[from];
  const toDef = LINEAR_UNITS[to];
  if (!fromDef || !toDef) {
    throw new Error(`unrecognized unit: "${!fromDef ? fromUnit : toUnit}"`);
  }
  if (fromDef.dimension !== toDef.dimension) {
    throw new Error(`cannot convert between incompatible dimensions: ${fromDef.dimension} vs ${toDef.dimension}`);
  }
  return { result: (value * fromDef.toBase) / toDef.toBase, dimension: fromDef.dimension };
}

interface ConvertUnitsArgs {
  value: number;
  fromUnit: string;
  toUnit: string;
}

function isConvertUnitsArgs(value: unknown): value is ConvertUnitsArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.value === 'number' &&
    Number.isFinite(v.value) &&
    typeof v.fromUnit === 'string' &&
    v.fromUnit !== '' &&
    typeof v.toUnit === 'string' &&
    v.toUnit !== ''
  );
}

export function createConvertUnitsTool(): RegisteredTool {
  return {
    definition: {
      name: 'convert_units',
      description:
        'Convert a physical quantity between units of weight, length, volume, area, temperature, or digital storage (e.g. lb<->kg, sqft<->sqm, F<->C, gb<->mb). Never estimate a conversion factor yourself.',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'number', description: 'The quantity to convert.' },
          fromUnit: { type: 'string', description: 'e.g. "lb", "sqft", "f" (Fahrenheit), "gb"' },
          toUnit: { type: 'string', description: 'e.g. "kg", "sqm", "c" (Celsius), "mb"' },
        },
        required: ['value', 'fromUnit', 'toUnit'],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      if (!isConvertUnitsArgs(args)) {
        throw new Error('convert_units requires value: number, fromUnit: string, toUnit: string');
      }
      const { result, dimension } = convertUnits(args.value, args.fromUnit, args.toUnit);
      return { value: args.value, fromUnit: args.fromUnit, toUnit: args.toUnit, dimension, result };
    },
  };
}
