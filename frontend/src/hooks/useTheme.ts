import { useEffect, useState } from 'react';

const THEME_STORAGE_KEY = 'bb_theme';

type Theme = 'light' | 'dark';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Local display preference only — not household orchestrator config, so localStorage is the
// right home for it rather than a DB-backed setting (bb_principles.md §13).
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(THEME_STORAGE_KEY) as Theme | null) ?? systemTheme(),
  );

  useEffect(() => {
    document.body.classList.toggle('dark', theme === 'dark');
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return { theme, toggle };
}
