import type { TabInstance } from '../hooks/useTabs';

interface TabStripProps {
  tabs: TabInstance[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
  /** Omitted entirely under Cloudflare Access SSO — there's no key to change. */
  onChangeKey?: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** App-wide navigation drawer (AppNavDrawer) — open state + toggle, driven by App so the
   *  drawer overlays app-main rather than living inside this header. */
  navOpen: boolean;
  onToggleNav: () => void;
}

export default function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onOpenSettings,
  onChangeKey,
  sidebarCollapsed,
  onToggleSidebar,
  navOpen,
  onToggleNav,
}: TabStripProps) {
  return (
    <header className="tab-bar">
      {/* App-wide nav drawer: the specialist views (Notes, Characters, RAG, ...) that used to be
          the empty-chat landing pills. Always visible — this is the platform's front-door menu,
          not a mobile-only fallback. */}
      <button
        className="app-nav-button"
        title={navOpen ? 'Close menu' : 'Menu'}
        aria-label={navOpen ? 'Close menu' : 'Menu'}
        aria-haspopup="dialog"
        aria-expanded={navOpen}
        onClick={onToggleNav}
      >
        ☰
      </button>
      {/* Mobile-only "summoning arrow": the left rail collapses to nothing on narrow screens
          (Sidebar.css), so this is the only way left to open it there. Hidden on desktop, where
          the rail's own header toggle already does the job. */}
      <button
        className="sidebar-summon mobile-only"
        title={sidebarCollapsed ? 'Open menu' : 'Close menu'}
        onClick={onToggleSidebar}
      >
        {sidebarCollapsed ? '☰' : '«'}
      </button>
      <h1>BigImagine</h1>
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
      <button className="settings-gear" title="Settings" onClick={onOpenSettings}>
        ⚙
      </button>
      {onChangeKey && (
        <button className="change-key" onClick={onChangeKey}>
          change key
        </button>
      )}
    </header>
  );
}
