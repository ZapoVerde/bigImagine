import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, callTool } from '../api/client';
import { markerLabel, MARKER_KEYS } from '../api/markerLabels';
import type { ContextStackPreset, ContextStackSlot } from '../api/types';
import './PromptStacksView.css';

interface PromptStacksViewProps {
  apiKey: string | null;
}

function slotLabel(slot: ContextStackSlot): string {
  if (slot.label) return slot.label;
  return slot.slotType === 'marker' ? markerLabel(slot.markerKey ?? '') : `Custom block (${slot.customRole ?? 'system'})`;
}

function newMarkerSlot(markerKey: string): ContextStackSlot {
  return { slotType: 'marker', markerKey, enabled: true };
}

function newCustomSlot(): ContextStackSlot {
  return { slotType: 'custom', enabled: true, customRole: 'system', customContent: '' };
}

// --- migration 0086: slot groups (contiguous groupName runs) ---
// slotGroupRunsDisplay keeps EMPTY-name runs (groupName set but not yet named): the editor must
// show the toggle ON and the opener's name box for a mid-edit group even though it ships no tags
// yet — that is exactly the state "toggle on, type the name" lives in. The SANITIZED-name
// equality mirrors the backend's groupRuns rule (assemblePromptStack.ts); isBareSlot below holds
// the backend's empty-name→no-tags consequence (unnamed members render red until named).

function sanitizeGroupName(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

export interface SlotGroupRun {
  /** Sanitized group name ('' while the opener is mid-edit — such a run emits no tags yet). */
  name: string;
  startIndex: number;
  endIndex: number;
}

/** Display runs: contiguous runs of groupName-set slots, empty names included (they get no color
 *  stripe and no closer chip — those need a name — but the toggle shows ON and the opener shows
 *  its name box so the user can type one). The SANITIZED-name equality mirrors the backend's
 *  groupRuns rule (assemblePromptStack.ts) exactly; the only difference is keeping empty-name
 *  runs visible so "toggle on, type the name" works in the editor. */
function slotGroupRunsDisplay(slots: ContextStackSlot[]): SlotGroupRun[] {
  const runs: SlotGroupRun[] = [];
  let i = 0;
  while (i < slots.length) {
    if (slots[i]!.groupName === undefined) {
      i++;
      continue;
    }
    const name = sanitizeGroupName(slots[i]!.groupName);
    let j = i + 1;
    while (j < slots.length && slots[j]!.groupName !== undefined && sanitizeGroupName(slots[j]!.groupName) === name) j++;
    runs.push({ name, startIndex: i, endIndex: j - 1 });
    i = j;
  }
  return runs;
}

/** Stable hue for a group name, drawn from a palette that EXCLUDES red — red is reserved for the
 *  coverage warning (an enabled slot whose content has no enclosing tags). Same name → same hue. */
function groupHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 1000;
  return 20 + (h % 320); // 20..339 — red (≈0-20, 340-360) excluded
}

/** True when the trimmed content is enclosed in ONE matching HTML-style tag pair — the same shape
 *  the 0085 toggle and 0086 groups produce. Tag names may contain spaces (kept verbatim), the
 *  comparison is case-insensitive and trailing whitespace-tolerant. Used by the red-coverage rule
 *  so a HAND-tagged custom block counts as covered even with the toggle off: the check is about
 *  the content that ships, not about which button was pushed. */
function contentIsWrapped(content: string): boolean {
  return /^<([^<>]+)>[\s\S]*?<\/\1>\s*$/i.test(content.trim());
}

/** Red-coverage rule: an enabled slot whose content ships bare is highlighted red. A slot is
 *  covered (not bare) when: the 0085 toggle wraps it, it is a member of a NAMED group (0086),
 *  or — for custom blocks — its content is already enclosed in a matching tag pair by hand.
 *  Disabled slots and empty custom blocks render nothing, so they don't count. Marker slots'
 *  content is assembled server-side per chat, so only the toggle/group rules can apply to them
 *  here — the editor never sees the text that ships for a marker. */
function isBareSlot(slot: ContextStackSlot): boolean {
  if (slot.enabled === false) return false;
  if (slot.tagEnabled) return false;
  if (sanitizeGroupName(slot.groupName)) return false;
  if (slot.slotType === 'custom') {
    const content = slot.customContent?.trim();
    if (!content) return false;
    if (contentIsWrapped(content)) return false;
  }
  return true;
}

// A SillyTavern Prompt-Manager-style editor for plugins/context-stack-presets: a left list of
// saved presets (plus the shipped read-only builtins), a right pane with the selected preset's
// ordered, reorderable, individually-toggleable slot list. There is deliberately no "apply to this
// chat" control here — docs/spec.md §7.4 flags assignment (scenes/characters) as not yet wired,
// since those tables don't exist yet (docs/bootstrap.md); this is purely the preset library the
// backend already has and the frontend never surfaced.
//
// Edits are staged in local draft state and committed in one `update_context_stack_preset` call on
// Save — same "edit locally, commit on Save" shape as ChatView's own ChatSettings panel — rather
// than a network round-trip per checkbox toggle or drag.
export default function PromptStacksView({ apiKey }: PromptStacksViewProps) {
  const [presets, setPresets] = useState<ContextStackPreset[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  // Mobile master-detail: list and editor are both full-width panes below the breakpoint, only one
  // shown at a time (same shape ChatView's chat-canvas-switch uses for chat vs Canvas).
  const [mobileShowEditor, setMobileShowEditor] = useState(false);

  const [draftName, setDraftName] = useState('');
  const [draftSlots, setDraftSlots] = useState<ContextStackSlot[]>([]);

  const dragIndexRef = useRef<number | null>(null);

  const refresh = useCallback(
    async (selectAfter?: string) => {
      try {
        const result = await callTool<ContextStackPreset[]>('get_context_stack_presets', {}, apiKey);
        setPresets(result);
        setError(null);
        if (selectAfter) setSelectedId(selectAfter);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'failed to load prompt stacks');
      }
    },
    [apiKey],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = presets?.find((p) => p.presetId === selectedId) ?? null;
  const isBuiltin = selected?.isBuiltin ?? false;

  useEffect(() => {
    setDraftName(selected?.name ?? '');
    setDraftSlots(selected?.slots ?? []);
    setExpandedIndex(null);
    // Resync the draft whenever a different preset is picked, or this one's own updatedAt moves
    // (a save just landed and refresh() brought back the canonical row) — not on every unrelated
    // presets refetch, which would otherwise clobber an in-progress unsaved edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selected?.updatedAt]);

  function selectPreset(id: string) {
    setSelectedId(id);
    setMobileShowEditor(true);
  }

  async function createNew() {
    const name = window.prompt('Name this prompt stack');
    if (!name?.trim()) return;
    try {
      const created = await callTool<ContextStackPreset>(
        'create_context_stack_preset',
        { name: name.trim(), slots: [newMarkerSlot('system')] },
        apiKey,
      );
      await refresh(created.presetId);
      setMobileShowEditor(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to create prompt stack');
    }
  }

  /** Clone base name with dedup: "X copy", "X copy 2", "X copy 3", … — case-insensitive across
   *  all stacks (builtins included), so duplicates are impossible. */
  function cloneNameFor(baseName: string): string {
    const taken = new Set((presets ?? []).map((p) => p.name.trim().toLowerCase()));
    const base = `${baseName.trim()} copy`;
    if (!taken.has(base.toLowerCase())) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`.toLowerCase())) n++;
    return `${base} ${n}`;
  }

  async function clonePreset(preset: ContextStackPreset) {
    const name = cloneNameFor(preset.name);
    try {
      const created = await callTool<ContextStackPreset>(
        'create_context_stack_preset',
        { name, slots: preset.slots },
        apiKey,
      );
      // "Pop the user into the clone": the editor immediately selects the new stack, which is
      // fully editable — cloning a built-in yields a user-owned editable stack.
      await refresh(created.presetId);
      setMobileShowEditor(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to clone prompt stack');
    }
  }

  async function removePreset(preset: ContextStackPreset) {
    if (!window.confirm(`Delete "${preset.name}"? This can't be undone.`)) return;
    try {
      await callTool('delete_context_stack_preset', { presetId: preset.presetId }, apiKey);
      if (selectedId === preset.presetId) {
        setSelectedId(null);
        setMobileShowEditor(false);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete prompt stack');
    }
  }

  // Builtins are settable too (users.default_*_preset_id points at any preset_id regardless of
  // owner, migrations 0061/0071) — unlike edit/delete, "default" isn't gated on isBuiltin. Two
  // independent default slots per user: the prompt stack (isDefault) and the cleanup preset
  // (isCleanupDefault); the picker below chooses which of the two this preset becomes — one
  // preset can be both, or two presets can each own one. Setting the same kind again clears it
  // (the same toggle shape the single-button default had).
  async function setDefault(preset: ContextStackPreset, kind: 'prompt' | 'cleanup') {
    const isKindDefault = kind === 'cleanup' ? preset.isCleanupDefault : preset.isDefault;
    try {
      await callTool('set_default_context_stack_preset', isKindDefault ? { kind } : { presetId: preset.presetId, kind }, apiKey);
      await refresh(selectedId ?? undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to update default prompt stack');
    }
  }

  function updateSlot(index: number, patch: Partial<ContextStackSlot>) {
    setDraftSlots((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function toggleEnabled(index: number) {
    setDraftSlots((prev) => prev.map((s, i) => (i === index ? { ...s, enabled: !(s.enabled ?? true) } : s)));
  }

  /** Migration 0086: the single group toggle. ON joins the adjacent run if there is one (copies
   *  its name — every member of a run carries the same groupName), else starts a new run whose
   *  opener is this slot ('' — the name box appears on it). OFF drops the slot from its run. */
  function toggleGroup(index: number) {
    setDraftSlots((prev) => {
      const next = [...prev];
      const slot = next[index]!;
      if (sanitizeGroupName(slot.groupName) || slot.groupName !== undefined) {
        next[index] = { ...slot, groupName: undefined };
        return next;
      }
      const prevName = index > 0 ? next[index - 1]!.groupName : undefined;
      const nextName = index < next.length - 1 ? next[index + 1]!.groupName : undefined;
      const neighbour = prevName !== undefined ? prevName : nextName;
      next[index] = { ...slot, groupName: neighbour ?? '' };
      return next;
    });
  }

  /** Editing the opener's name box propagates to every member of the run (they all carry the
   *  same groupName, so contiguity + equality keep the run intact and the closer chip follows).
   *  Uses the DISPLAY runs: a mid-edit run has an empty name, so the backend-exact named-run
   *  rule wouldn't find it — but typing the name is exactly what turns it into a real run. */
  function setGroupName(index: number, name: string) {
    const run = slotGroupRunsDisplay(draftSlots).find((r) => index >= r.startIndex && index <= r.endIndex);
    setDraftSlots((prev) => prev.map((s, i) => (run && i >= run.startIndex && i <= run.endIndex ? { ...s, groupName: name } : s)));
  }

  function removeSlot(index: number) {
    setDraftSlots((prev) => prev.filter((_, i) => i !== index));
    setExpandedIndex(null);
  }

  function moveSlot(index: number, dir: -1 | 1) {
    setDraftSlots((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
    setExpandedIndex((prev) => (prev === index ? index + dir : prev));
  }

  function handleDrop(targetIndex: number) {
    const from = dragIndexRef.current;
    dragIndexRef.current = null;
    if (from === null || from === targetIndex) return;
    setDraftSlots((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(targetIndex, 0, moved!);
      return next;
    });
    setExpandedIndex(null);
  }

  function addMarkerSlot(key: string) {
    if (!key) return;
    setDraftSlots((prev) => [...prev, newMarkerSlot(key)]);
  }

  function addCustomSlot() {
    setDraftSlots((prev) => {
      const next = [...prev, newCustomSlot()];
      setExpandedIndex(next.length - 1);
      return next;
    });
  }

  const dirty =
    selected != null &&
    !isBuiltin &&
    (draftName.trim() !== selected.name || JSON.stringify(draftSlots) !== JSON.stringify(selected.slots));

  // Migration 0086: the group runs of the current draft — computed once per render, shared by the
  // opener name box, the closer chip, the member color stripe, and the bare-slot red highlight.
  // Display runs (empty-name runs included) so a freshly toggled, not-yet-named group still shows
  // its toggle ON and its opener's name box — the state "toggle on, type the name" lives in.
  const draftGroupRuns = slotGroupRunsDisplay(draftSlots);

  async function save() {
    if (!selected || isBuiltin) return;
    if (draftSlots.length === 0) {
      setError('A prompt stack needs at least one slot.');
      return;
    }
    for (const slot of draftSlots) {
      if (slot.slotType === 'custom' && !slot.customContent?.trim()) {
        setError('Every custom block needs content — fill it in or remove the slot.');
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const patch: { presetId: string; name?: string; slots: ContextStackSlot[] } = {
        presetId: selected.presetId,
        slots: draftSlots,
      };
      if (draftName.trim() && draftName.trim() !== selected.name) patch.name = draftName.trim();
      await callTool('update_context_stack_preset', patch, apiKey);
      await refresh(selected.presetId);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to save prompt stack');
    } finally {
      setSaving(false);
    }
  }

  if (presets === null) {
    return <div className="promptstacks-view loading">Loading prompt stacks&hellip;</div>;
  }

  return (
    <div className={`promptstacks-view${mobileShowEditor ? ' mobile-editor' : ''}`}>
      <div className="promptstacks-list">
        <div className="promptstacks-list-header">
          <span>Prompt Stacks</span>
          <button type="button" className="promptstacks-new-btn" onClick={createNew}>
            + New
          </button>
        </div>
        {presets.length === 0 && <div className="empty-state">No prompt stacks yet.</div>}
        {presets.map((preset) => (
          <div
            key={preset.presetId}
            className={`promptstacks-row${preset.presetId === selectedId ? ' selected' : ''}`}
            onClick={() => selectPreset(preset.presetId)}
          >
            <span className="promptstacks-row-name">{preset.name}</span>
            {preset.isBuiltin && <span className="promptstacks-row-badge">built-in</span>}
            {preset.isDefault && <span className="promptstacks-row-badge promptstacks-row-badge-default">default</span>}
          </div>
        ))}
      </div>

      <div className="promptstacks-editor">
        <button type="button" className="promptstacks-back" onClick={() => setMobileShowEditor(false)}>
          &larr; Prompt Stacks
        </button>

        {error && <div className="error-banner">{error}</div>}

        {!selected && <div className="empty-state">Pick a prompt stack, or create a new one.</div>}

        {selected && (
          <>
            <div className="promptstacks-editor-header">
              <input
                className="promptstacks-name-input"
                value={draftName}
                disabled={isBuiltin}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Prompt stack name"
              />
              <details className="promptstacks-default-menu">
                <summary
                  className={`promptstacks-default-btn${selected.isDefault || selected.isCleanupDefault ? ' active' : ''}`}
                >
                  {selected.isDefault || selected.isCleanupDefault ? 'Default ✓' : 'Set as default'}
                </summary>
                <div className="promptstacks-default-options">
                  <button type="button" onClick={() => setDefault(selected, 'prompt')}>
                    {selected.isDefault ? 'Clear as default prompt stack' : 'Set as default prompt stack'}
                  </button>
                  <button type="button" onClick={() => setDefault(selected, 'cleanup')}>
                    {selected.isCleanupDefault ? 'Clear as default cleanup' : 'Set as default cleanup'}
                  </button>
                </div>
              </details>
              <button type="button" onClick={() => clonePreset(selected)}>
                Clone
              </button>
              {!isBuiltin && (
                <button type="button" className="promptstacks-delete-btn" onClick={() => removePreset(selected)}>
                  Delete
                </button>
              )}
            </div>
            {isBuiltin && (
              <div className="status">Built-in prompt stacks are read-only &mdash; duplicate one to customize it.</div>
            )}

            <div className="stack-slot-list">
              {draftSlots.map((slot, idx) => {
                const run = draftGroupRuns.find((r) => idx >= r.startIndex && idx <= r.endIndex);
                const inGroup = run != null;
                const isOpener = inGroup && idx === run!.startIndex;
                const isCloser = inGroup && idx === run!.endIndex;
                const named = inGroup && run!.name !== '';
                const hue = named ? groupHue(run!.name) : undefined;
                return (
                  <div
                    key={idx}
                    className={`stack-slot-row${slot.enabled === false ? ' disabled' : ''}${expandedIndex === idx ? ' expanded' : ''}${named ? ' group-member' : ''}${isBareSlot(slot) ? ' bare' : ''}`}
                    style={hue !== undefined ? ({ ['--group-hue' as string]: `${hue}` } as React.CSSProperties) : undefined}
                    draggable={!isBuiltin}
                    onDragStart={() => {
                      dragIndexRef.current = idx;
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => handleDrop(idx)}
                  >
                    <div className="stack-slot-main">
                      <span className="stack-slot-grip" aria-hidden="true">
                        &#8942;&#8942;
                      </span>
                      <div className="stack-slot-reorder">
                        <button
                          type="button"
                          disabled={isBuiltin || idx === 0}
                          onClick={() => moveSlot(idx, -1)}
                          aria-label="Move slot up"
                        >
                          &#9650;
                        </button>
                        <button
                          type="button"
                          disabled={isBuiltin || idx === draftSlots.length - 1}
                          onClick={() => moveSlot(idx, 1)}
                          aria-label="Move slot down"
                        >
                          &#9660;
                        </button>
                      </div>
                      <label className="stack-slot-toggle" title={slot.enabled === false ? 'Slot disabled' : 'Toggle this slot on/off'}>
                        <input
                          type="checkbox"
                          checked={slot.enabled ?? true}
                          disabled={isBuiltin}
                          onChange={() => toggleEnabled(idx)}
                        />
                      </label>
                      <label
                        className={`stack-slot-tag-toggle${slot.tagEnabled ? ' on' : ''}`}
                        title="Wrap in HTML-style tags — encloses the name in <…> with a closing tag at the end (a hint to the LLM, not real HTML)"
                      >
                        <input
                          type="checkbox"
                          checked={slot.tagEnabled ?? false}
                          disabled={isBuiltin}
                          onChange={() => updateSlot(idx, { tagEnabled: !(slot.tagEnabled ?? false) })}
                        />
                        <span className="stack-slot-tag-glyph">{'< >'}</span>
                      </label>
                      <label
                        className={`stack-slot-group-toggle${inGroup ? ' on' : ''}`}
                        title="Group this slot with its neighbours — the first member of a run is the opener (its name box appears here), the last is the closer (</Name> chip). One set of tags wraps the whole run."
                      >
                        <input
                          type="checkbox"
                          checked={inGroup}
                          disabled={isBuiltin}
                          onChange={() => toggleGroup(idx)}
                        />
                        <span className="stack-slot-group-glyph">{'{ }'}</span>
                      </label>
                      {isOpener && !isBuiltin && (
                        <input
                          className="stack-slot-group-name"
                          value={slot.groupName ?? ''}
                          placeholder="Group name"
                          onChange={(e) => setGroupName(idx, e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      )}
                      <button
                        type="button"
                        className="stack-slot-label"
                        onClick={() => setExpandedIndex(expandedIndex === idx ? null : idx)}
                      >
                        {slotLabel(slot)}
                      </button>
                      {isCloser && named && (
                        <span className="stack-slot-group-close">{`</${run!.name}>`}</span>
                      )}
                      {!isBuiltin && (
                        <button
                          type="button"
                          className="stack-slot-delete"
                          onClick={() => removeSlot(idx)}
                          aria-label="Remove slot"
                        >
                          &times;
                        </button>
                      )}
                    </div>
                  {expandedIndex === idx && (
                    <div className="stack-slot-editor">
                      <label>
                        Label
                        <input
                          type="text"
                          placeholder={slot.slotType === 'marker' ? markerLabel(slot.markerKey ?? '') : 'Custom block'}
                          value={slot.label ?? ''}
                          disabled={isBuiltin}
                          onChange={(e) => updateSlot(idx, { label: e.target.value || undefined })}
                        />
                      </label>
                      {slot.slotType === 'marker' ? (
                        <label>
                          Field
                          <select
                            value={slot.markerKey ?? ''}
                            disabled={isBuiltin}
                            onChange={(e) => updateSlot(idx, { markerKey: e.target.value })}
                          >
                            {MARKER_KEYS.map((key) => (
                              <option key={key} value={key}>
                                {markerLabel(key)}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <>
                          <label>
                            Role
                            <select
                              value={slot.customRole ?? 'system'}
                              disabled={isBuiltin}
                              onChange={(e) => updateSlot(idx, { customRole: e.target.value as ContextStackSlot['customRole'] })}
                            >
                              <option value="system">system</option>
                              <option value="user">user</option>
                              <option value="assistant">assistant</option>
                            </select>
                          </label>
                          <label>
                            Content
                            <textarea
                              rows={4}
                              value={slot.customContent ?? ''}
                              disabled={isBuiltin}
                              onChange={(e) => updateSlot(idx, { customContent: e.target.value })}
                            />
                          </label>
                        </>
                      )}
                    </div>
                  )}
                </div>
                );
              })}
            </div>

            {!isBuiltin && (
              <div className="stack-slot-add-row">
                <select value="" onChange={(e) => addMarkerSlot(e.target.value)}>
                  <option value="">+ Add marker slot&hellip;</option>
                  {MARKER_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {markerLabel(key)}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={addCustomSlot}>
                  + Add custom block
                </button>
              </div>
            )}

            {!isBuiltin && (
              <div className="promptstacks-actions">
                <button onClick={save} disabled={!dirty || saving}>
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
                {saved && <span className="saved-note">Saved.</span>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
