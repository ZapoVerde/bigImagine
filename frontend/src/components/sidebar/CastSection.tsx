/**
 * @file frontend/src/components/sidebar/CastSection.tsx
 * @stamp 2026-08-15
 * @architectural-role Stateful Owner (bi_principles.md §8) — owns this section's collapsed
 *   state and its own roster+presence fetches; renders pure list rows
 * @description
 * rp-cast-infrastructure-plan.md Part C — the RP sidebar's "Cast" section: who's known to this
 * chat, with a live presence indicator for whoever the current scene's `Present:` line says is
 * here right now. The roster comes from the chat-scoped get_characters tool (?chat_id=…, Part B
 * — user-authored rows plus this chat's auto-registered ones); presence comes from the
 * now-chat-scoped get_scenes tool, whose matching scene row's character_ids (matched against the
 * active chat's session.sceneId, up-reported by ChatView through App) are the present set.
 *
 * Structured like TurnDrawerSection.tsx: own useState collapse state, own header/toggle/chevron
 * button, own lazy fetch(es) gated on not-collapsed, cancelled-flag guarded, chat-id-tagged
 * results so a stale fetch from a previous chat is never shown after a chat switch. Two
 * differences from Timing, both deliberate: it defaults EXPANDED (Cast is the actual feature of
 * this plan — glanceable without a click, still fully collapsible), and it has no snapshot
 * overlay — its two tool calls are the whole data source, re-run per chat switch and while
 * expanded whenever the sceneId changes (a turn that landed a header updates presence live).
 *
 * Empty states: a chat with no linked characters → "No characters known to this chat yet."; a
 * chat with no sceneId yet (no turn has landed a header) → the roster renders with no presence
 * indicators, not an error. Presence is a simple dot on rows whose characterId is in the active
 * scene's character_ids.
 *
 * @api-declaration
 * CastSection({ apiKey, chatId, sceneId }) — sceneId: string | null
 *
 * @contract
 *   assertions:
 *     purity:          impure (fetches, local state)
 *     state_ownership: [collapsed, roster, scenes, loadChatId, error]
 *     external_io:     [callTool: get_characters, get_scenes]
 */

import { useEffect, useState } from 'react';
import { ApiError, callTool } from '../../api/client';
import type { CharacterSummary } from '../../api/types';
import CharacterAvatarThumb from '../CharacterAvatarThumb';
import './CastSection.css';

interface CastSectionProps {
  apiKey: string | null;
  /** The active RP chat — both tool calls are chat-scoped to it (?chat_id=…, Part B), and the
   *  results are tagged with it so a stale fetch from a previous chat is never shown. */
  chatId: string;
  /** The active chat's scene_id cache pointer (segway.md §2.2), up-reported by ChatView — the
   *  get_scenes row whose character_ids are "present". Null = no header has landed yet. */
  sceneId: string | null;
}

interface SceneSummary {
  sceneId: string;
  name: string;
  activeLocationId: string | null;
  characterIds: string[];
}

export default function CastSection({ apiKey, chatId, sceneId }: CastSectionProps) {
  // Default expanded — Cast is the feature, not a secondary debug panel (rp-cast-infrastructure-
  // plan.md Part C); still fully collapsible like Timing.
  const [collapsed, setCollapsed] = useState(false);
  const [roster, setRoster] = useState<CharacterSummary[] | null>(null);
  const [scenes, setScenes] = useState<SceneSummary[] | null>(null);
  // loadChatId tags which chat the fetched data belongs to — a chat switch clears the display
  // until the new chat's fetch lands, never showing the previous chat's cast under it.
  const [loadChatId, setLoadChatId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (collapsed) return;
    let cancelled = false;
    setError(null);
    Promise.all([
      callTool<CharacterSummary[]>('get_characters', {}, apiKey, chatId),
      callTool<SceneSummary[]>('get_scenes', {}, apiKey, chatId),
    ])
      .then(([chars, scenesResult]) => {
        if (cancelled) return;
        setRoster(chars);
        setScenes(scenesResult);
        setLoadChatId(chatId);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'failed to load cast');
      });
    return () => {
      cancelled = true;
    };
    // Re-run on sceneId change too: a turn that landed a header (or switched scenes) changes the
    // active scene's presence, and this section is the live read of it.
  }, [collapsed, chatId, sceneId, apiKey]);

  // Presence = the roster characters in the active scene's character_ids. No sceneId yet (or a
  // scene row that hasn't been fetched yet) → no presence indicators, not an error.
  const activeScene = scenes?.find((s) => s.sceneId === sceneId) ?? null;
  const presentIds = new Set(activeScene?.characterIds ?? []);
  const visibleRoster = loadChatId === chatId ? roster : null;

  return (
    <section className="cast-section">
      <div className="cast-header">
        <button
          type="button"
          className="cast-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand cast' : 'Collapse cast'}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span className="cast-chevron">{collapsed ? '▸' : '▾'}</span>
          <span>Cast</span>
        </button>
      </div>
      {!collapsed && (
        <div className="cast-content">
          {error && <div className="cast-error">{error}</div>}
          {!error && visibleRoster === null && <div className="cast-empty">Loading&hellip;</div>}
          {!error && visibleRoster !== null && visibleRoster.length === 0 && (
            <div className="cast-empty">No characters known to this chat yet.</div>
          )}
          {!error && visibleRoster !== null && visibleRoster.length > 0 && (
            <ul className="cast-rows">
              {visibleRoster.map((c) => {
                const present = presentIds.has(c.characterId);
                return (
                  <li key={c.characterId} className={`cast-row${present ? ' present' : ''}`}>
                    <CharacterAvatarThumb characterId={c.characterId} apiKey={apiKey} className="cast-row-avatar" />
                    <span className="cast-row-name">{c.name}</span>
                    <span
                      className={`cast-presence${present ? ' on' : ''}`}
                      title={present ? 'Present in the current scene' : 'Not present in the current scene'}
                      aria-hidden="true"
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
