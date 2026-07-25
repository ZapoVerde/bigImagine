/** Per-token USD strings straight from the vendor (OpenRouter only — DeepSeek's /models has no
 *  pricing field at all) shown as $ per 1M tokens, the unit every provider's own pricing page
 *  actually uses. Plain toFixed(2) goes to "$0.00" for anything under half a cent per 1M tokens,
 *  which is common for cheap models — fall back to 4 decimals so a real (if tiny) price is still
 *  visibly distinct from a genuinely free model. */
export function formatPricePerMillion(perToken: string): string {
  const perMillion = Number(perToken) * 1_000_000;
  if (perMillion === 0) return '$0';
  return perMillion < 0.01 ? `$${perMillion.toFixed(4)}` : `$${perMillion.toFixed(2)}`;
}
