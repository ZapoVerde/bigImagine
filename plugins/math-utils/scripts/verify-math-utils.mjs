// Proves the math-utils plugin end to end through info/registerTools (the real loader contract),
// plus each tool's underlying pure logic directly. No Postgres/credentials/network involved:
// this plugin needs none of them, aside from date_math reading a fake settings store.

import { info, registerTools } from '../dist/index.js';
import { evaluateExpression } from '../dist/calculatorTool.js';
import { convertUnits } from '../dist/unitConversionTool.js';
import { computeMoneyMath } from '../dist/moneyMathTool.js';
import { createDateMathTool } from '../dist/dateMathTool.js';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

assert(info.id === 'math-utils' && /^[a-z0-9_-]+$/.test(info.id), 'info.id is present and matches the id format pluginLoader.ts requires');

// --- registerTools ---
{
  const fakeSettings = { get: async () => 'America/Los_Angeles' };
  const tools = await registerTools({ settings: fakeSettings });
  assert(tools.length === 4, 'registerTools returns exactly four tools');
  const registry = createToolRegistry(tools);
  for (const name of ['calculate', 'date_math', 'convert_units', 'money_math']) {
    assert(registry.definitions().some((d) => d.name === name), `${name} is registered`);
  }
}

// --- calculate ---
{
  assert(evaluateExpression('(3*8*225) + (3*10*185)') === 3*8*225 + 3*10*185, 'multi-step parenthesized expression evaluates correctly');
  assert(evaluateExpression('15% * 240') === 36, '% is treated as percentage, not modulo');
  assert(evaluateExpression('2^10') === 1024, 'exponentiation works');
  assert(evaluateExpression('sqrt(144)') === 12, 'built-in math functions work');

  for (const bad of ['a = 5', '1; 2', 'this.constructor', '__proto__', 'function f(){}']) {
    let threw = false;
    try { evaluateExpression(bad); } catch { threw = true; }
    assert(threw, `rejects disallowed construct: "${bad}"`);
  }

  let threw = false;
  try { evaluateExpression('1/0 * 0'); } catch { threw = true; } // NaN, not finite
  assert(threw, 'a non-finite result throws rather than being returned');
}

// --- convert_units ---
{
  const lb = convertUnits(1, 'kg', 'lb');
  assert(Math.abs(lb.result - 2.2046226218) < 1e-9 && lb.dimension === 'weight', 'kg -> lb converts correctly');

  const sqm = convertUnits(100, 'sqft', 'sqm');
  assert(Math.abs(sqm.result - 9.290304) < 1e-9, 'sqft -> sqm converts correctly');

  const f = convertUnits(0, 'c', 'f');
  assert(f.result === 32 && f.dimension === 'temperature', '0C -> 32F (non-linear offset handled)');

  const gb = convertUnits(1, 'gb', 'mb');
  assert(gb.result === 1024, 'gb -> mb converts correctly');

  let threw = false;
  try { convertUnits(1, 'kg', 'sqft'); } catch { threw = true; }
  assert(threw, 'cross-dimension conversion (weight -> area) throws');

  threw = false;
  try { convertUnits(1, 'kg', 'parsecs'); } catch { threw = true; }
  assert(threw, 'an unrecognized unit throws');
}

// --- money_math ---
{
  const tip = computeMoneyMath({ operation: 'tip', amount: 240, ratePercent: 15 });
  assert(tip.tip === 36 && tip.total === 276, 'tip computes exactly');

  const split = computeMoneyMath({ operation: 'split', amount: 50, parts: 3 });
  assert(split.perPersonAmount === 16.66 && split.peopleWhoOweOneCentExtra === 2, '$50/3 splits to $16.66 with 2 people owing an extra cent (16.66*3 + 0.02 = 50.00)');

  const compound = computeMoneyMath({ operation: 'compound_interest', principal: 1000, ratePercent: 5, years: 1, compoundsPerYear: 12 });
  assert(Math.abs(compound.finalAmount - 1051.16) < 0.01, 'monthly-compounded interest matches the expected value to the cent');
}

// --- date_math ---
{
  const fakeSettings = { get: async () => 'America/New_York' };
  const tool = createDateMathTool(fakeSettings);

  const added = await tool.handler({ operation: 'add', date: '2026-03-15', amount: 90, unit: 'days' }, { userId: 'x', db: undefined });
  assert(added.resultDate === '2026-06-13', '90 days after 2026-03-15 lands on 2026-06-13 (leap-year-safe)');

  const leap = await tool.handler({ operation: 'add', date: '2028-02-28', amount: 1, unit: 'days' }, { userId: 'x', db: undefined });
  assert(leap.resultDate === '2028-02-29', 'adding 1 day across a leap-year Feb 29 lands correctly');

  const biz = await tool.handler({ operation: 'add', date: '2026-07-24', amount: 1, unit: 'business_days' }, { userId: 'x', db: undefined }); // Friday
  assert(biz.resultDate === '2026-07-27', 'adding 1 business day from a Friday skips the weekend to Monday');

  const diff = await tool.handler({ operation: 'diff', date: '2026-01-01', endDate: '2026-12-31' }, { userId: 'x', db: undefined });
  assert(diff.calendarDays === 364, 'calendar-day diff across a full non-leap year is 364');

  let threw = false;
  try {
    await tool.handler({ operation: 'add', date: '2026-02-30', amount: 1 }, { userId: 'x', db: undefined });
  } catch {
    threw = true;
  }
  assert(threw, 'an invalid calendar date (Feb 30) throws rather than silently rolling over');
}
