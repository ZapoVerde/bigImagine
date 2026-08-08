// Shared by ChubResultCard.tsx and ChubCardModal.tsx's stat rows — one copy of the relative-date
// formatting instead of two that could drift. Pure function; no imports.
export function formatRelativeDate(iso: string): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffDays = Math.round((then - Date.now()) / (24 * 60 * 60 * 1000));
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(diffDays) < 1) return 'today';
  if (Math.abs(diffDays) < 30) return rtf.format(diffDays, 'day');
  if (Math.abs(diffDays) < 365) return rtf.format(Math.round(diffDays / 30), 'month');
  return rtf.format(Math.round(diffDays / 365), 'year');
}
