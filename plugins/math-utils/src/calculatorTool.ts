/**
 * @file plugins/math-utils/src/calculatorTool.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — the calculate RegisteredTool
 * @description
 * bb_principles.md §2: the LLM reasons, it does not calculate — multi-digit and multi-step
 * arithmetic is exactly the class of error models make silently and confidently. This tool lets
 * the model extract the formula (which numbers, which operation) and hand the actual arithmetic
 * to deterministic code.
 *
 * Deliberately NOT `eval()`/`new Function()` on the LLM-supplied expression string — that would
 * be arbitrary code execution driven by model output. mathjs's `evaluate()` has its own
 * expression grammar (no access to `require`/`process`/globals the way real JS eval would), and
 * on top of that this module pre-validates the input against a strict arithmetic-only character
 * allowlist and rejects assignment/function-definition syntax before it ever reaches mathjs, so
 * the accepted grammar is a hard subset of what mathjs itself supports.
 *
 * "%" is treated as percentage (`15%` -> `0.15`), not mathjs's native modulo, since that's the
 * meaning a natural-language formula like "15% of 240" implies — modulo has no real use case for
 * the kind of everyday arithmetic this tool exists for.
 *
 * @api-declaration
 * createCalculateTool() — returns the calculate RegisteredTool; no constructor dependencies
 *
 * @contract
 *   assertions:
 *     purity:          impure (delegates to mathjs; no external IO)
 *     state_ownership: []
 *     external_io:     []
 */

import { create, all } from 'mathjs';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

const math = create(all, {});

// Digits, arithmetic operators, parentheses/commas (for function args like max(1,2)), letters
// (for function names: sqrt, sin, log, ...), whitespace, and % (percentage). No `=`, `;`, `[`,
// `{`, `_`, backticks, or word-boundary constructs mathjs's grammar treats specially.
const SAFE_CHARACTERS = /^[\d\s+\-*/^%().,a-zA-Z]*$/;
const DISALLOWED = /=|;|\bfunction\b|\bimport\b|__proto__|\bconstructor\b|\bthis\b/i;

function expandPercentages(expression: string): string {
  return expression.replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)');
}

export function evaluateExpression(expression: string): number {
  if (!SAFE_CHARACTERS.test(expression) || DISALLOWED.test(expression)) {
    throw new Error('expression contains characters or constructs outside basic arithmetic');
  }
  const result = math.evaluate(expandPercentages(expression), {});
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error('expression did not evaluate to a finite number');
  }
  return result;
}

interface CalculateArgs {
  expression: string;
}

function isCalculateArgs(value: unknown): value is CalculateArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.expression === 'string' && v.expression.trim() !== '';
}

export function createCalculateTool(): RegisteredTool {
  return {
    definition: {
      name: 'calculate',
      description:
        'Evaluate a multi-step arithmetic expression exactly — parentheses, +-*/^, and % as percentage (e.g. "15% * 240"). Use this for any arithmetic beyond trivial single-digit math; never compute multi-digit or multi-step arithmetic yourself.',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'e.g. "(3*8*225) + (3*10*185)" or "15% * 240" or "sqrt(144) + 2^5"',
          },
        },
        required: ['expression'],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      if (!isCalculateArgs(args)) {
        throw new Error('calculate requires a non-empty expression: string argument');
      }
      const result = evaluateExpression(args.expression);
      return { expression: args.expression, result };
    },
  };
}
