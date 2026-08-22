/**
 * @file frontend/src/components/sidebar/CastSection.tsx
 * @stamp 2026-08-22
 * @architectural-role Stateful Owner (bi_principles.md §8) — owns this section's collapsed
 *   state and its own roster+presence fetches; renders expandable rows + anchored action menus
 * @description
 * rp-cast-infrastructure-plan.md Part C — the RP sidebar's "Cast" section: who's known to this
 * chat, with a live presence indicator for whoever the current scene's `Present:` line says is
 * here right now. The roster comes from the chat-scoped get_characters tool (?chat_id=…, called
 * with castOnly: true per rp-cast-library-repair.md Part A — only this chat's linked
 * auto-registered characters, never the user's whole card library); presence comes from the
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
 * Expanded character detail (2026-08-22): clicking the character's avatar/name/row body expands
 * that character beneath the compact row. Only one character is expanded at a time. Expansion
 * lazily loads that character through get_character scoped with the active chatId (needed for
 * RP-born characters via character_chat_links). The expansion shows an editable Description field
 * bound to the character's existing persona, with Save / saving state / saved-or-error feedback.
 * The ⋯ button does NOT toggle expansion — it opens an anchored action menu (Send to Studio,
 * Remove from cast) with outside-click and Escape dismissal, only one open at a time.
 *
 * @api-declaration
 * CastSection({ apiKey, chatId, sceneId }) — sceneId: string | null
 *
 * @contract
 *   assertions:
 *     purity:          impure (fetches, local state)
 *     state_ownership: [collapsed, roster, scenes, loadChatId, error, expandedId, detail, draft,
 *                       detailLoading, detailError, saving, saveStatus, openMenuId,
 *                       studioBusyId, studioMessage, removingId, removeMessage, pendingRemoveId]
 *     external_io:     [callTool: get_characters, get_scenes, get_character, update_character,
 *                       sendCastCharacterToStudio, remove_character_from_chat]
 */

import { useEffect, useRef, useState } from 'react';
import { ApiError, callTool, refreshChatCharacterSprites, sendCastCharacterToStudio } from '../../api/client';
import type { CharacterDetail, CharacterSummary } from '../../api/types';
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
  // portrait-studio-standalone-subjects-plan.md Part C on the cast row: which character's send is
  // in flight (the button shows a busy state), and the most recent per-row result/error message.
  const [studioBusyId, setStudioBusyId] = useState<string | null>(null);
  const [studioMessage, setStudioMessage] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  // rp-cast-delete-plan.md: the per-row remove-from-chat affordance.
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeMessage, setRemoveMessage] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  // Cast Refresh Imagery — deterministic retry control (required behaviour)
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<'idle' | 'done' | 'partial' | 'failed'>('idle');
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);

  // ---- Expandable detail state (2026-08-22) ----
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CharacterDetail | null>(null);
  const [detailForId, setDetailForId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // Staleness guard for detail fetches — same pattern as roster fetch but per expanded character.
  const detailSeqRef = useRef(0);
  // Refs for menu outside-click detection (only one menu open at a time)
  const menuWrapRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  useEffect(() => {
    if (collapsed) return;
    let cancelled = false;
    setError(null);
    Promise.all([
      callTool<CharacterSummary[]>('get_characters', { castOnly: true }, apiKey, chatId),
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

  // On chatId change: close any character expansion, close any action menu, clear loaded
  // detail/draft/status state — retain roster/scenes stale protections via loadChatId.
  useEffect(() => {
    setExpandedId(null);
    setOpenMenuId(null);
    setDetail(null);
    setDetailForId(null);
    setDetailLoading(false);
    setDetailError(null);
    setDraft('');
    setSaveStatus(null);
    setSaving(false);
    setPendingRemoveId(null);
    // Do not clear roster/scenes here — visibleRoster gating handles staleness; the new fetch
    // will repopulate.
  }, [chatId]);

  // On collapse of overall Cast section: close any open row menu, clear expansion state.
  useEffect(() => {
    if (collapsed) {
      setOpenMenuId(null);
      setExpandedId(null);
    }
  }, [collapsed]);

  // Outside-click + Escape for the action menu (only one open at a time, no app-wide abstraction)
  useEffect(() => {
    if (openMenuId === null) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const wrap = menuWrapRefs.current.get(openMenuId);
      if (wrap && !wrap.contains(target)) {
        setOpenMenuId(null);
      } else if (!wrap) {
        // Fallback: if ref not registered yet, close on any outside click not inside menu surface
        const menuEl = document.querySelector(`[data-cast-menu="${openMenuId}"]`);
        if (menuEl && !menuEl.contains(target)) {
          // Also check if click was on the ⋯ button itself (it lives outside menu surface but inside wrap)
          const btn = document.querySelector(`[data-cast-menu-btn="${openMenuId}"]`);
          if (!btn || !btn.contains(target)) setOpenMenuId(null);
        }
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenuId(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenuId]);

  // Lazy detail loading — only when a character is expanded.
  useEffect(() => {
    if (expandedId === null) {
      setDetail(null);
      setDetailForId(null);
      setDetailLoading(false);
      setDetailError(null);
      setSaveStatus(null);
      return;
    }
    const seq = ++detailSeqRef.current;
    const thisId = expandedId;
    const thisChatId = chatId;
    setDetailLoading(true);
    setDetailError(null);
    setSaveStatus(null);
    callTool<CharacterDetail>('get_character', { characterId: thisId }, apiKey, thisChatId)
      .then((result) => {
        if (seq !== detailSeqRef.current) return;
        if (thisChatId !== chatId) return;
        if (thisId !== expandedId) return;
        if (!result.found) {
          setDetail(result);
          setDetailForId(thisId);
          setDetailError('Character not found.');
          setDraft('');
        } else {
          setDetail(result);
          setDetailForId(thisId);
          setDraft(result.persona);
          setDetailError(null);
        }
      })
      .catch((err) => {
        if (seq !== detailSeqRef.current) return;
        if (thisChatId !== chatId || thisId !== expandedId) return;
        setDetail(null);
        setDetailForId(thisId);
        setDetailError(err instanceof ApiError ? err.message : 'failed to load character');
      })
      .finally(() => {
        if (seq !== detailSeqRef.current) return;
        setDetailLoading(false);
      });
  }, [expandedId, chatId, apiKey]);

  // Presence = the roster characters in the active scene's character_ids. No sceneId yet (or a
  // scene row that hasn't been fetched yet) → no presence indicators, not an error.
  const activeScene = scenes?.find((s) => s.sceneId === sceneId) ?? null;
  const presentIds = new Set(activeScene?.characterIds ?? []);
  const visibleRoster = loadChatId === chatId ? roster : null;

  // portrait-studio-standalone-subjects-plan.md Part C: the cast row's "Send to Studio" — the
  // Roster's own no-chatId get_characters listing never includes RP-born characters (see the
  // plan's Out of Scope), so this row-level action sources characterId straight off the
  // chat-scoped cast list. Every click creates a brand-new, unlinked subject entity seeded from
  // the character's appearance (falling back to the persona) — no refresh-in-place anymore.
  async function sendToStudio(characterId: string) {
    setStudioBusyId(characterId);
    setStudioMessage(null);
    try {
      await sendCastCharacterToStudio(characterId, apiKey);
      setStudioMessage({ id: characterId, text: 'Sent to Studio.', ok: true });
      window.setTimeout(() => setStudioMessage((m) => (m?.id === characterId ? null : m)), 4000);
    } catch (err) {
      setStudioMessage({ id: characterId, text: err instanceof ApiError ? err.message : 'Studio seed failed.', ok: false });
    } finally {
      setStudioBusyId(null);
    }
  }

  // rp-cast-delete-plan.md: remove this character from the active chat's cast. chatId is passed
  // to callTool so the ?chat_id= query-string scoping applies (same as get_characters/get_scenes),
  // so a removal can never assert against a different chat. Guarded by loadChatId so a removal
  // fired just before a chat switch never updates the new chat's roster.
  async function removeFromCast(characterId: string) {
    setRemovingId(characterId);
    setRemoveMessage(null);
    try {
      const result = await callTool<{ removed: boolean }>('remove_character_from_chat', { characterId }, apiKey, chatId);
      if (loadChatId === chatId) {
        if (result.removed) {
          setRoster((r) => (r ? r.filter((c) => c.characterId !== characterId) : r));
          setRemoveMessage({ id: characterId, text: 'Removed from chat.', ok: true });
        } else {
          // The link (or user-scoped link) didn't exist — treat as an idempotent success: just
          // drop the row rather than surfacing an error (plan's Edge Cases).
          setRoster((r) => (r ? r.filter((c) => c.characterId !== characterId) : r));
          setRemoveMessage({ id: characterId, text: 'Removed from chat.', ok: true });
        }
        window.setTimeout(() => setRemoveMessage((m) => (m?.id === characterId ? null : m)), 4000);
      }
      // If the removed character is currently expanded or has its menu open, clear those states.
      if (expandedId === characterId) {
        setExpandedId(null);
      }
      if (openMenuId === characterId) {
        setOpenMenuId(null);
      }
      setPendingRemoveId(null);
    } catch (err) {
      if (loadChatId === chatId) {
        setRemoveMessage({ id: characterId, text: err instanceof ApiError ? err.message : 'Remove failed.', ok: false });
      }
    } finally {
      setRemovingId(null);
      setPendingRemoveId(null);
    }
  }

  function handleExpandToggle(characterId: string) {
    setOpenMenuId(null);
    setSaveStatus(null);
    if (expandedId === characterId) {
      setExpandedId(null);
    } else {
      setExpandedId(characterId);
    }
  }

  async function savePersona() {
    if (!detail || !detail.found || detailForId !== expandedId) return;
    if (saving || detailLoading) return;
    if (draft === detail.persona) return;
    setSaving(true);
    setSaveStatus(null);
    try {
      await callTool('update_character', { characterId: detail.characterId, persona: draft }, apiKey, chatId);
      // Update locally-held detail with returned draft value (simpler truthful state, no re-fetch).
      setDetail((prev) => {
        if (!prev || !prev.found) return prev;
        return { ...prev, persona: draft };
      });
      setSaveStatus({ ok: true, text: 'Saved.' });
      window.setTimeout(() => setSaveStatus((s) => (s?.ok ? null : s)), 2500);
    } catch (err) {
      setSaveStatus({ ok: false, text: err instanceof ApiError ? err.message : 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }

  async function handleRefreshImagery() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshStatus('idle');
    setRefreshMessage(null);
    try {
      const { results } = await refreshChatCharacterSprites(chatId, apiKey);
      const failed = results.filter((r) => r.status === 'failed');
      const ok = results.filter((r) => r.status !== 'failed');
      if (results.length === 0) {
        setRefreshStatus('done');
        setRefreshMessage('No present characters to refresh.');
      } else if (failed.length === 0) {
        setRefreshStatus('done');
        setRefreshMessage(`Refreshed ${ok.length} character${ok.length === 1 ? '' : 's'}.`);
      } else if (ok.length === 0) {
        setRefreshStatus('failed');
        setRefreshMessage(failed[0]?.reason ?? 'Refresh failed.');
      } else {
        setRefreshStatus('partial');
        setRefreshMessage(`${ok.length} ok, ${failed.length} failed — ${failed[0]?.reason ?? ''}`.trim());
      }
      // Cause SpriteStage to immediately re-fetch rather than wait for its poll interval
      window.dispatchEvent(new CustomEvent('bigimagine:sprite-refresh', { detail: { chatId } }));
      window.setTimeout(() => {
        setRefreshStatus('idle');
        setRefreshMessage(null);
      }, 4000);
    } catch (err) {
      setRefreshStatus('failed');
      setRefreshMessage(err instanceof ApiError ? err.message : 'Refresh failed.');
      window.setTimeout(() => {
        setRefreshStatus('idle');
        setRefreshMessage(null);
      }, 4000);
    } finally {
      setRefreshing(false);
    }
  }

  const expandedIsCurrentDetail = detail?.found === true && detailForId === expandedId;

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
        <button
          type="button"
          className={`cast-refresh-btn${refreshing ? ' refreshing' : ''}${refreshStatus !== 'idle' ? ` ${refreshStatus}` : ''}`}
          aria-label="Refresh imagery"
          title={
            refreshing
              ? 'Refreshing imagery…'
              : refreshMessage ?? 'Refresh imagery — retry missing portraits for present characters'
          }
          disabled={refreshing}
          onClick={() => void handleRefreshImagery()}
        >
          <span aria-hidden="true" className="cast-refresh-icon">
            {refreshing ? '◌' : refreshStatus === 'done' ? '✓' : refreshStatus === 'failed' || refreshStatus === 'partial' ? '⚠' : '↻'}
          </span>
        </button>
        {refreshMessage && <span className={`cast-refresh-status ${refreshStatus}`}>{refreshMessage}</span>}
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
                const isExpanded = expandedId === c.characterId;
                const isMenuOpen = openMenuId === c.characterId;
                const showStudioStatus = studioMessage?.id === c.characterId;
                const showRemoveStatus = removeMessage?.id === c.characterId;
                return (
                  <li key={c.characterId} className={`cast-row-wrap${isExpanded ? ' expanded' : ''}${present ? ' present' : ''}`}>
                    <div className="cast-row">
                      <button
                        type="button"
                        className="cast-row-main"
                        aria-expanded={isExpanded}
                        aria-label={`${c.name}${present ? ' — present' : ''}`}
                        onClick={() => handleExpandToggle(c.characterId)}
                      >
                        <CharacterAvatarThumb characterId={c.characterId} apiKey={apiKey} className="cast-row-avatar" />
                        <span className="cast-row-name">{c.name}</span>
                        <span
                          className={`cast-presence${present ? ' on' : ''}`}
                          title={present ? 'Present in the current scene' : 'Not present in the current scene'}
                          aria-hidden="true"
                        />
                        <span className="cast-row-chevron" aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
                      </button>
                      <div
                        className="cast-row-menu-wrap"
                        ref={(el) => {
                          menuWrapRefs.current.set(c.characterId, el);
                        }}
                      >
                        <button
                          type="button"
                          className="cast-row-menu-btn"
                          aria-haspopup="menu"
                          aria-expanded={isMenuOpen}
                          aria-label={`Actions for ${c.name}`}
                          data-cast-menu-btn={c.characterId}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenMenuId((prev) => (prev === c.characterId ? null : c.characterId));
                          }}
                        >
                          ⋯
                        </button>
                        {isMenuOpen && (
                          <div className="cast-row-menu" role="menu" data-cast-menu={c.characterId}>
                            <button
                              type="button"
                              role="menuitem"
                              className="cast-row-menu-item"
                              disabled={studioBusyId === c.characterId}
                              onClick={() => {
                                setOpenMenuId(null);
                                setPendingRemoveId(null);
                                void sendToStudio(c.characterId);
                              }}
                            >
                              {studioBusyId === c.characterId ? 'Sending…' : 'Send to Studio'}
                            </button>
                            {pendingRemoveId === c.characterId ? (
                              <button
                                type="button"
                                role="menuitem"
                                className="cast-row-menu-item danger confirm"
                                disabled={removingId === c.characterId}
                                onClick={() => {
                                  setOpenMenuId(null);
                                  void removeFromCast(c.characterId);
                                }}
                              >
                                {removingId === c.characterId ? 'Removing…' : 'Confirm remove?'}
                              </button>
                            ) : (
                              <button
                                type="button"
                                role="menuitem"
                                className="cast-row-menu-item danger"
                                disabled={removingId === c.characterId}
                                onClick={() => {
                                  setPendingRemoveId(c.characterId);
                                }}
                              >
                                Remove from cast
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="cast-row-detail">
                        {detailLoading && <div className="cast-detail-loading">Loading…</div>}
                        {!detailLoading && detailError && detailForId === c.characterId && (
                          <div className="cast-detail-error">{detailError}</div>
                        )}
                        {!detailLoading && !detailError && expandedIsCurrentDetail && (
                          <>
                            <label className="cast-detail-label" htmlFor={`cast-persona-${c.characterId}`}>
                              Description
                            </label>
                            <textarea
                              id={`cast-persona-${c.characterId}`}
                              className="cast-detail-textarea"
                              rows={4}
                              value={draft}
                              onChange={(e) => {
                                setDraft(e.target.value);
                                setSaveStatus(null);
                              }}
                              placeholder="Character description"
                            />
                            <div className="cast-detail-actions">
                              <button
                                type="button"
                                className="cast-detail-save-btn"
                                disabled={detailLoading || saving || draft === (detail as Extract<CharacterDetail, { found: true }>).persona}
                                onClick={() => void savePersona()}
                              >
                                {saving ? 'Saving…' : 'Save'}
                              </button>
                              {saveStatus && (
                                <span className={`cast-detail-status${saveStatus.ok ? ' ok' : ' err'}`}>{saveStatus.text}</span>
                              )}
                            </div>
                          </>
                        )}
                        {/* Transient per-row command statuses — shown beneath expanded area, not in row */}
                        {(showStudioStatus || showRemoveStatus) && (
                          <div className="cast-detail-command-status">
                            {showStudioStatus && (
                              <span className={`cast-detail-status${studioMessage!.ok ? ' ok' : ' err'}`}>{studioMessage!.text}</span>
                            )}
                            {showRemoveStatus && (
                              <span className={`cast-detail-status${removeMessage!.ok ? ' ok' : ' err'}`}>{removeMessage!.text}</span>
                            )}
                          </div>
                        )}
                        {!detailLoading && !detailError && !expandedIsCurrentDetail && (
                          <div className="cast-detail-loading">Loading…</div>
                        )}
                      </div>
                    )}
                    {/* Collapsed row still surfaces transient command status compactly below row if not expanded */}
                    {!isExpanded && (showStudioStatus || showRemoveStatus) && (
                      <div className="cast-row-command-status">
                        {showStudioStatus && (
                          <span className={`cast-row-command-text${studioMessage!.ok ? '' : ' err'}`}>{studioMessage!.text}</span>
                        )}
                        {showRemoveStatus && (
                          <span className={`cast-row-command-text${removeMessage!.ok ? '' : ' err'}`}>{removeMessage!.text}</span>
                        )}
                      </div>
                    )}
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
