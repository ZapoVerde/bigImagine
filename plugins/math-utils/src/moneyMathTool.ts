/**
 * @file plugins/math-utils/src/moneyMathTool.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — the money_math RegisteredTool
 * @description
 * bb_principles.md §2: currency math done in floating point drifts off the cent (0.1 + 0.2 !==
 * 0.3) exactly where "exact to the cent" matters most. Every operation here works in Decimal
 * (decimal.js) and rounds to 2 decimal places only at the very end, never mid-calculation.
 *
 * "split" deliberately does not silently round each share — an amount that doesn't divide evenly
 * (e.g. $50.00 / 3) has some number of people who owe one extra cent, and the result says so
 * explicitly (peopleWhoOweOneCentExtra) rather than losing or inventing a cent by rounding each
 * share independently.
 *
 * @api-declaration
 * createMoneyMathTool() — returns the money_math RegisteredTool; no constructor dependencies
 *
 * @contract
 *   assertions:
 *     purity:          pure (Decimal arithmetic only)
 *     state_ownership: []
 *     external_io:     []
 */

import { Decimal } from 'decimal.js';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

type MoneyMathOperation = 'tip' | 'tax' | 'split' | 'compound_interest';

interface MoneyMathArgs {
  operation: MoneyMathOperation;
  amount?: number;
  ratePercent?: number;
  parts?: number;
  principal?: number;
  years?: number;
  compoundsPerYear?: number;
}

function isMoneyMathArgs(value: unknown): value is MoneyMathArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

  switch (v.operation) {
    case 'tip':
    case 'tax':
      return isFiniteNumber(v.amount) && isFiniteNumber(v.ratePercent);
    case 'split':
      return isFiniteNumber(v.amount) && isFiniteNumber(v.parts) && (v.parts as number) > 0 && Number.isInteger(v.parts);
    case 'compound_interest':
      return (
        isFiniteNumber(v.principal) &&
        isFiniteNumber(v.ratePercent) &&
        isFiniteNumber(v.years) &&
        (v.compoundsPerYear === undefined || (isFiniteNumber(v.compoundsPerYear) && (v.compoundsPerYear as number) > 0))
      );
    default:
      return false;
  }
}

function tipOrTax(amount: number, ratePercent: number, label: 'tip' | 'tax') {
  const base = new Decimal(amount);
  const extra = base.times(ratePercent).dividedBy(100).toDecimalPlaces(2);
  return {
    amount,
    ratePercent,
    [label]: extra.toNumber(),
    total: base.plus(extra).toDecimalPlaces(2).toNumber(),
  };
}

function split(amount: number, parts: number) {
  const totalCents = new Decimal(amount).times(100).toDecimalPlaces(0);
  const baseCents = totalCents.dividedToIntegerBy(parts);
  const remainderCents = totalCents.minus(baseCents.times(parts)).toNumber();
  return {
    amount,
    parts,
    perPersonAmount: baseCents.dividedBy(100).toNumber(),
    peopleWhoOweOneCentExtra: remainderCents,
  };
}

function compoundInterest(principal: number, ratePercent: number, years: number, compoundsPerYear = 12) {
  const p = new Decimal(principal);
  const r = new Decimal(ratePercent).dividedBy(100);
  const n = compoundsPerYear;
  const factor = new Decimal(1).plus(r.dividedBy(n)).pow(n * years);
  const finalAmount = p.times(factor).toDecimalPlaces(2);
  return {
    principal,
    ratePercent,
    years,
    compoundsPerYear: n,
    finalAmount: finalAmount.toNumber(),
    interestEarned: finalAmount.minus(p).toDecimalPlaces(2).toNumber(),
  };
}

export function computeMoneyMath(args: MoneyMathArgs): Record<string, unknown> {
  switch (args.operation) {
    case 'tip':
      return tipOrTax(args.amount as number, args.ratePercent as number, 'tip');
    case 'tax':
      return tipOrTax(args.amount as number, args.ratePercent as number, 'tax');
    case 'split':
      return split(args.amount as number, args.parts as number);
    case 'compound_interest':
      return compoundInterest(args.principal as number, args.ratePercent as number, args.years as number, args.compoundsPerYear);
  }
}

export function createMoneyMathTool(): RegisteredTool {
  return {
    definition: {
      name: 'money_math',
      description:
        'Exact, cent-precise financial arithmetic: tip, sales tax, splitting a bill N ways, or compound interest. Never do currency math yourself — floating-point rounding drift is exactly what this tool exists to avoid.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['tip', 'tax', 'split', 'compound_interest'] },
          amount: { type: 'number', description: 'Base amount, for tip/tax/split.' },
          ratePercent: { type: 'number', description: 'Tip %, tax %, or annual interest rate %.' },
          parts: { type: 'integer', description: 'Number of people to split amount between, for split.' },
          principal: { type: 'number', description: 'Starting principal, for compound_interest.' },
          years: { type: 'number', description: 'Number of years, for compound_interest.' },
          compoundsPerYear: { type: 'number', description: 'Compounding frequency per year (default 12), for compound_interest.' },
        },
        required: ['operation'],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      if (!isMoneyMathArgs(args)) {
        throw new Error('money_math requires operation-specific arguments (see tool definition)');
      }
      return computeMoneyMath(args);
    },
  };
}
