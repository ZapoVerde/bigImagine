import { useEffect, useRef } from 'react';
import type { SummonableType } from '../../hooks/useTabs';
import './AppNavDrawer.css';

// The "come here to do a task" specialist views. This is the same set the empty-chat landing
// used to show as pills (ChatView.tsx) — now app-wide, behind the top-left hamburger. Settings
// used to live in TabStrip's own gear icon; it's folded in here as an ordinary entry instead.
export interface AppNavOption {
  type: SummonableType;
  label: string;
  icon: string;
}

export const APP_NAV_OPTIONS: AppNavOption[] = [
  { type: 'notes', label: 'Notes', icon: '📝' },
  { type: 'documents', label: 'Documents', icon: '📄' },
  { type: 'characters', label: 'Characters', icon: '🎭' },
  { type: 'browse-chub', label: 'Browse Chub', icon: '🔍' },
  { type: 'rag', label: 'RAG', icon: '🧠' },
  { type: 'promptstacks', label: 'Prompt Stacks', icon: '🧩' },
  { type: 'connections', label: 'Connections', icon: '🔌' },
  { type: 'portraits', label: 'Portraits', icon: '🎨' },
  { type: 'cleanup', label: 'Cleanup', icon: '🧹' },
  { type: 'locations', label: 'Locations', icon: '📍' },
  { type: 'lorebooks', label: 'Lorebooks', icon: '📖' },
  { type: 'stats', label: 'Stats', icon: '📊' },
  { type: 'settings', label: 'Settings', icon: '⚙️' },
];

interface AppNavDrawerProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (type: SummonableType) => void;
}

// App-wide navigation drawer behind the tab-bar's top-left hamburger: the specialist views
// (principle 5's opt-in escape hatch, formerly the landing-page pills). A left slide-in drawer
// over a full-screen backdrop — modal, so the story surface underneath stays untouched until an
// option is picked or the drawer is dismissed.
export default function AppNavDrawer({ open, onClose, onNavigate }: AppNavDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Ref so the mount-time effect below never re-subscribes when App re-creates onClose each
  // render (same pattern as ChubCardModal's onCloseRef).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Modal contract while open (mirrors ChubCardModal): lock background scroll, close on Escape,
  // move focus into the drawer (and restore it to the hamburger on close), keep Tab from
  // escaping into the app behind it.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
      previouslyFocused?.focus();
    };
  }, [open]);

  function onPanelKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], textarea, input, select, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const onPanelItself = document.activeElement === panelRef.current;
    if ((e.shiftKey && (document.activeElement === first || onPanelItself)) || (!e.shiftKey && document.activeElement === last)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }

  if (!open) return null;

  return (
    <div className="app-nav-layer">
      <div className="app-nav-backdrop" onClick={onClose} />
      <div className="app-nav-drawer" role="dialog" aria-modal="true" aria-label="App navigation" ref={panelRef} onKeyDown={onPanelKeyDown}>
        <div className="app-nav-header">
          <span className="app-nav-title">Go to</span>
          <button ref={closeButtonRef} type="button" className="app-nav-close" title="Close menu" aria-label="Close menu" onClick={onClose}>
            &times;
          </button>
        </div>
        <nav className="app-nav-list">
          {APP_NAV_OPTIONS.map((opt) => (
            <button
              key={opt.type}
              type="button"
              className="app-nav-item"
              onClick={() => {
                onNavigate(opt.type);
                onClose();
              }}
            >
              <span className="app-nav-icon">{opt.icon}</span>
              {opt.label}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
