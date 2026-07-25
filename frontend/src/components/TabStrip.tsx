import type { TabInstance } from '../hooks/useTabs';

interface TabStripProps {
  tabs: TabInstance[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  /** Omitted entirely under Cloudflare Access SSO — there's no key to change. */
  onChangeKey?: () => void;
}

export default function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  theme,
  onToggleTheme,
  onChangeKey,
}: TabStripProps) {
  return (
    <header className="tab-bar">
      <h1>bigBrain</h1>
      <nav>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab${tab.id === activeId ? ' active' : ''}`}
            onClick={() => onSelect(tab.id)}
          >
            <span className="tab-label">{tab.title}</span>
            <span
              className="tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              &times;
            </span>
          </button>
        ))}
        <button className="tab-new" title="New tab" onClick={onNew}>
          +
        </button>
      </nav>
      <button
        className="theme-toggle"
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        onClick={onToggleTheme}
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>
      {onChangeKey && (
        <button className="change-key" onClick={onChangeKey}>
          change key
        </button>
      )}
    </header>
  );
}
