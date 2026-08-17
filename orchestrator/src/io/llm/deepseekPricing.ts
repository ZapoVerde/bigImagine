/**
 * @file orchestrator/src/io/llm/deepseekPricing.ts
 * @stamp 2026-08-17
 * @architectural-role Pure Function — DeepSeek's official pricing page -> structured rates
 * @description
 * Parses https://api-docs.deepseek.com/quick_start/pricing/ (a static Docusaurus page, no JS
 * rendering — verified live) into per-model off-peak + peak rates (USD per 1M tokens), and the
 * UTC-hour predicate that decides which tier a call is billed at. Docs:
 * docs/plans/deepseek-pricing-sync.md.
 *
 * The page bills two rates per token type — off-peak (base) and peak (hours 01:00-04:00 and
 * 06:00-10:00 UTC) — so the sync stores both (migration 0109: the existing 0089 columns are the
 * off-peak/base tier; price_peak_* columns are the peak tier). Peak classification is by UTC
 * wall-clock only, never local time: DeepSeek defines peak hours in UTC, and this deployment's
 * admin sits in Perth (UTC+8) where e.g. 09:00 local = 01:00 UTC = peak.
 *
 * Parser rules (the "omit rather than guess" posture from the 0089 plan, applied to scraping):
 * a model id is only emitted when all six rates parse to a finite number >= 0 (matching
 * adminServer.ts's isPrice / the frontend editor's own parsePrice — $0.00 is a valid rate, not a
 * parse failure). A renamed/missing
 * row or an unparseable price silently drops that model (or the whole table when the MODEL header
 * is gone) — the sync then simply doesn't touch the affected connection's manually-entered
 * values. It never guesses a rate from another tier (no "peak is half of off-peak" derivation,
 * even though that holds today — a future pricing shape that breaks the 2x relationship must not
 * corrupt the stored data).
 *
 * matchDeepSeekPricing(baseUrl, model, byModel) picks out the derivation half of
 * deepseekPricingSync.ts's per-connection matching (host check + model lookup) — that module stays
 * an IO Wrapper (bi_principles.md §8: zero derivation logic) by delegating the "does this
 * connection's base URL + model resolve to a scraped price" decision here instead of inlining it.
 *
 * @api-declaration
 * parseDeepSeekPricingHtml(html) -> DeepSeekPricing[] — { model, offPeak, peak } per model, all
 *   six rates finite numbers >= 0; [] when the page has no recognizable pricing table
 * isPeakUtcHour(now = new Date()) -> boolean — hours 01-03 and 06-09 UTC are peak, all else off-peak
 * matchDeepSeekPricing(baseUrl, model, byModel) -> DeepSeekPricing | undefined — undefined when
 *   baseUrl is unparseable, its host isn't api.deepseek.com, or model isn't in byModel
 *
 * @contract
 *   assertions:
 *     purity:          pure (in-memory DOM parsing only — the module's only dependency, linkedom,
 *                      does no I/O; Date.now() only via the defaulted `now` param of isPeakUtcHour)
 *     state_ownership: []
 *     external_io:     []
 */

import { parseHTML } from 'linkedom';

/** Minimal structural shapes for linkedom's loosely-typed DOM — deliberately no bare `Element`/
 *  `Document` references, since the orchestrator's tsconfig has no DOM lib (tsconfig.base.json
 *  lib: ["ES2023"]). */
interface CellLike {
  textContent: string | null;
}
interface RowLike {
  querySelectorAll(selector: string): ArrayLike<CellLike>;
}
interface TableLike {
  querySelectorAll(selector: string): ArrayLike<RowLike>;
}
interface PricingDocumentLike {
  querySelectorAll(selector: string): ArrayLike<TableLike>;
}

export interface PriceTier {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheHitPerMillion: number;
}

export interface DeepSeekPricing {
  model: string;
  offPeak: PriceTier;
  peak: PriceTier;
}

const PRICING_LABELS = new Set([
  '1M INPUT TOKENS (CACHE HIT)',
  '1M INPUT TOKENS (CACHE MISS)',
  '1M OUTPUT TOKENS',
]);

const FIELD_BY_LABEL: Record<string, keyof PriceTier> = {
  '1M INPUT TOKENS (CACHE HIT)': 'cacheHitPerMillion',
  '1M INPUT TOKENS (CACHE MISS)': 'inputPerMillion',
  '1M OUTPUT TOKENS': 'outputPerMillion',
};

function cellTexts(row: RowLike): string[] {
  return Array.from(row.querySelectorAll('td, th'), (cell) => (cell.textContent ?? '').trim());
}

function parsePrice(text: string): number | undefined {
  const value = Number(text.replace(/[$,\s]/g, ''));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseDeepSeekPricingHtml(html: string): DeepSeekPricing[] {
  const { document } = parseHTML(html) as unknown as { document: PricingDocumentLike };
  const tables = Array.from(document.querySelectorAll('table'));
  const table = tables.find((t) =>
    Array.from(t.querySelectorAll('tr')).some((row) => cellTexts(row).includes('MODEL')),
  );
  if (!table) return [];

  const rows = Array.from(table.querySelectorAll('tr'));
  const headerIdx = rows.findIndex((row) => cellTexts(row).includes('MODEL'));
  if (headerIdx < 0) return [];
  const headerCells = cellTexts(rows[headerIdx]!);
  const headerTail = headerCells.slice(headerCells.indexOf('MODEL') + 1);
  // Blank header cells are dropped from `models`, but the price-cell arrays below are built from
  // the same row's full cell list and never filtered — index-aligning `models` to `headerTail`
  // positionally (the old `.filter(Boolean)`) would silently shift every model after a blank
  // header cell onto the next model's prices. `modelColumnIndices` keeps each surviving model's
  // original column index so the bucket-assembly loop below reads the matching price-cell slot
  // regardless of any blank header cells earlier in the row.
  const models: string[] = [];
  const modelColumnIndices: number[] = [];
  headerTail.forEach((cell, i) => {
    if (!cell) return;
    models.push(cell);
    modelColumnIndices.push(i);
  });
  if (models.length === 0) return [];

  // Per-pricing-label arrays of per-model prices (index-aligned with `models`), each entry
  // undefined when that cell didn't parse. The rowspan'd label cell appears on the OFF-PEAK row
  // only; the PEAK row carries just ['PEAK', ...prices], so `pendingLabel` carries the label from
  // the OFF-PEAK row to the PEAK row that immediately follows it.
  const labelPrices = new Map<string, { offPeak: (number | undefined)[]; peak: (number | undefined)[] }>();
  let pendingLabel: string | undefined;
  for (const row of rows.slice(headerIdx + 1)) {
    const cells = cellTexts(row);
    const offPeakIdx = cells.indexOf('OFF-PEAK');
    if (offPeakIdx > 0) {
      // The label cell isn't reliably at cells[0]: the live page wraps the whole pricing block in
      // its own rowspan'd "PRICING(1)" cell that lands as an extra leading cell on only the first
      // row of the block (whichever token type comes first) — search the cells before OFF-PEAK for
      // a recognized label instead of assuming a fixed position.
      const label = cells.slice(0, offPeakIdx).find((cell) => PRICING_LABELS.has(cell));
      if (label !== undefined) {
        pendingLabel = label;
        labelPrices.set(label, { offPeak: cells.slice(offPeakIdx + 1).map(parsePrice), peak: [] });
      }
      continue;
    }
    if (cells[0] === 'PEAK' && pendingLabel !== undefined && PRICING_LABELS.has(pendingLabel)) {
      labelPrices.get(pendingLabel)!.peak = cells.slice(1).map(parsePrice);
      pendingLabel = undefined;
    }
  }

  // Assemble per-model tier objects; a model is emitted only once both tiers are complete
  // (all three fields set) — a partial tier set means the page is ambiguous for that model and
  // the connection keeps its current prices rather than being half-synced.
  const buckets = new Map<string, { offPeak: Partial<PriceTier>; peak: Partial<PriceTier> }>();
  for (const [label, prices] of labelPrices) {
    const field = FIELD_BY_LABEL[label];
    if (!field) continue;
    for (let i = 0; i < models.length; i++) {
      const column = modelColumnIndices[i]!;
      const offPeak = prices.offPeak[column];
      const peak = prices.peak[column];
      if (offPeak === undefined || peak === undefined) continue;
      const bucket = buckets.get(models[i]!) ?? { offPeak: {}, peak: {} };
      bucket.offPeak[field] = offPeak;
      bucket.peak[field] = peak;
      buckets.set(models[i]!, bucket);
    }
  }

  const result: DeepSeekPricing[] = [];
  for (const [model, bucket] of buckets) {
    const offPeak: Partial<PriceTier> = { ...bucket.offPeak };
    const peak: Partial<PriceTier> = { ...bucket.peak };
    if (
      offPeak.inputPerMillion === undefined ||
      offPeak.outputPerMillion === undefined ||
      offPeak.cacheHitPerMillion === undefined ||
      peak.inputPerMillion === undefined ||
      peak.outputPerMillion === undefined ||
      peak.cacheHitPerMillion === undefined
    ) {
      continue;
    }
    result.push({ model, offPeak: offPeak as PriceTier, peak: peak as PriceTier });
  }
  return result;
}

export type DeepSeekPricingMatch =
  | { status: 'matched'; pricing: DeepSeekPricing }
  | { status: 'unparseable-url' }
  | { status: 'no-match' };

/** Whether a connection's base URL + model resolves to a scraped DeepSeek price — the derivation
 *  half of deepseekPricingSync.ts's per-connection matching, pulled out here so that IO Wrapper
 *  stays free of derivation logic (bi_principles.md §8). Only connections whose base URL host is
 *  exactly api.deepseek.com are eligible; the caller decides what to do with each status
 *  ('unparseable-url' is the one case worth logging — the other two are silently normal). */
export function matchDeepSeekPricing(
  baseUrl: string | undefined | null,
  model: string,
  byModel: Map<string, DeepSeekPricing>,
): DeepSeekPricingMatch {
  if (!baseUrl) return { status: 'no-match' };
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return { status: 'unparseable-url' };
  }
  if (host !== 'api.deepseek.com') return { status: 'no-match' };
  const pricing = byModel.get(model);
  return pricing ? { status: 'matched', pricing } : { status: 'no-match' };
}

/** DeepSeek's published peak window — hours 01:00-04:00 and 06:00-10:00 UTC, half-open ranges
 *  ([01:00, 04:00) and [06:00, 10:00)), i.e. UTC hours 1, 2, 3, 6, 7, 8, 9. Classified by UTC
 *  wall-clock only — never local time, per the plan's timezone note. */
export function isPeakUtcHour(now: Date = new Date()): boolean {
  const hour = now.getUTCHours();
  return (hour >= 1 && hour <= 3) || (hour >= 6 && hour <= 9);
}