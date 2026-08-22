import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  ApiError,
  callTool,
  createChat,
  exportCard,
  importCard,
  updateChat,
} from '../api/client';
import type { CardDetail, CardSummary, ContextStackPreset } from '../api/types';
import CardAvatarThumb from '../components/CardAvatarThumb';
import './CardsView.css';

interface CardsViewProps {
  apiKey: string | null;
  onOpenRp: (chatId: string, title?: string) => void;
  onChatsDeleted?: (chatIds: string[]) => void;
  refreshKey: number;
}

interface Draft {
  name: string;
  persona: string;
  appearance: string;
  scenario: string;
  systemPrompt: string;
  exampleDialogue: string;
  greetings: string[];
}

const BLANK_DRAFT: Draft = { name: '', persona: '', appearance: '', scenario: '', systemPrompt: '', exampleDialogue: '', greetings: [] };

function draftFromDetail(detail: CardDetail): Draft {
  if (!detail.found) return BLANK_DRAFT;
  return {
    name: detail.name,
    persona: detail.persona,
    appearance: detail.appearance,
    scenario: detail.scenario,
    systemPrompt: detail.systemPrompt,
    exampleDialogue: detail.exampleDialogue,
    greetings: detail.greetings,
  };
}

export default function CardsView({ apiKey, onOpenRp, onChatsDeleted, refreshKey }: CardsViewProps) {
  const [cards, setCards] = useState<CardSummary[] | null>(null);
  const [sortMode, setSortMode] = useState<'newest' | 'name'>('newest');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [startingRp, setStartingRp] = useState(false);
  const [mobileShowEditor, setMobileShowEditor] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounter = useRef(0);

  const sortedCards = useMemo(() => {
    const arr = [...(cards ?? [])];
    if (sortMode === 'newest') {
      arr.sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          a.name.localeCompare(b.name) ||
          a.cardId.localeCompare(b.cardId),
      );
    } else {
      arr.sort(
        (a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
          b.createdAt.localeCompare(a.createdAt) ||
          a.cardId.localeCompare(b.cardId),
      );
    }
    return arr;
  }, [cards, sortMode]);

  const refresh = useCallback(
    async (selectAfter?: string) => {
      try {
        const result = await callTool<CardSummary[]>('get_cards', {}, apiKey);
        setCards(result);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'failed to load cards');
      }
      if (selectAfter) setSelectedId(selectAfter);
    },
    [apiKey],
  );

  const loadDetail = useCallback(
    async (id: string) => {
      setDetail(null);
      try {
        const result = await callTool<CardDetail>('get_card', { cardId: id }, apiKey);
        setDetail(result);
        setDraft(draftFromDetail(result));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'failed to load card');
      }
    },
    [apiKey],
  );

  useEffect(() => {
    void refresh();
  }, [apiKey, refreshKey]);

  function selectCard(id: string) {
    setSelectedId(id);
    setCreatingNew(false);
    setMobileShowEditor(true);
    setError(null);
    void loadDetail(id);
  }

  function startNew() {
    setSelectedId(null);
    setDetail(null);
    setCreatingNew(true);
    setDraft(BLANK_DRAFT);
    setMobileShowEditor(true);
    setError(null);
  }

  function updateDraft(patch: Partial<Draft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function updateGreeting(index: number, value: string) {
    setDraft((prev) => ({ ...prev, greetings: prev.greetings.map((g, i) => (i === index ? value : g)) }));
  }

  function addGreeting() {
    setDraft((prev) => ({ ...prev, greetings: [...prev.greetings, ''] }));
  }

  function removeGreeting(index: number) {
    setDraft((prev) => ({ ...prev, greetings: prev.greetings.filter((_, i) => i !== index) }));
  }

  function moveGreeting(index: number, dir: -1 | 1) {
    setDraft((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.greetings.length) return prev;
      const next = [...prev.greetings];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return { ...prev, greetings: next };
    });
  }

  const dirty =
    creatingNew ||
    (detail?.found === true &&
      (draft.name.trim() !== detail.name ||
        draft.persona !== detail.persona ||
        draft.appearance !== detail.appearance ||
        draft.scenario !== detail.scenario ||
        draft.systemPrompt !== detail.systemPrompt ||
        draft.exampleDialogue !== detail.exampleDialogue ||
        JSON.stringify(draft.greetings) !== JSON.stringify(detail.greetings)));

  async function save() {
    if (!draft.name.trim()) {
      setError('A card needs a name.');
      return;
    }
    const greetings = draft.greetings.map((g) => g.trim()).filter((g) => g.length > 0);
    setSaving(true);
    setError(null);
    try {
      if (creatingNew) {
        const created = await callTool<{ cardId: string; name: string }>(
          'create_card',
          {
            name: draft.name.trim(),
            persona: draft.persona,
            appearance: draft.appearance,
            scenario: draft.scenario,
            system_prompt: draft.systemPrompt,
            example_dialogue: draft.exampleDialogue,
            greetings,
          },
          apiKey,
        );
        setCreatingNew(false);
        await refresh(created.cardId);
        await loadDetail(created.cardId);
      } else if (detail?.found) {
        await callTool(
          'update_card',
          {
            cardId: detail.cardId,
            name: draft.name.trim(),
            persona: draft.persona,
            appearance: draft.appearance,
            scenario: draft.scenario,
            system_prompt: draft.systemPrompt,
            example_dialogue: draft.exampleDialogue,
            greetings,
          },
          apiKey,
        );
        await refresh(detail.cardId);
        await loadDetail(detail.cardId);
      }
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to save card');
    } finally {
      setSaving(false);
    }
  }

  async function removeCard() {
    if (!detail?.found) return;
    if (!window.confirm(`Delete "${detail.name}"? This can't be undone.`)) return;
    try {
      const result = await callTool<{ deleted: boolean; deletedChatIds?: string[] }>(
        'delete_card',
        { cardId: detail.cardId },
        apiKey,
      );
      onChatsDeleted?.(result.deletedChatIds ?? []);
      setSelectedId(null);
      setDetail(null);
      setMobileShowEditor(false);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete card');
    }
  }

  async function doExport(format: 'png' | 'json') {
    if (!detail?.found) return;
    try {
      await exportCard(detail.cardId, format, apiKey);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to export card');
    }
  }

  async function handleImportFiles(files: File[]) {
    setError(null);
    let lastImportedId: string | null = null;
    const failures: string[] = [];
    for (const file of files) {
      try {
        const imported = await importCard(file, apiKey);
        lastImportedId = imported.cardId;
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof ApiError ? err.message : 'failed to import'}`);
      }
    }
    if (lastImportedId) {
      setCreatingNew(false);
      await refresh(lastImportedId);
      await loadDetail(lastImportedId);
      setMobileShowEditor(true);
    }
    if (failures.length > 0) setError(failures.join('; '));
  }

  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragCounter.current += 1;
    setDragOver(true);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDragOver(false);
  }

  async function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) await handleImportFiles(files);
  }

  async function startRp() {
    if (!detail?.found) return;
    setStartingRp(true);
    setError(null);
    try {
      const chat = await createChat(apiKey, { title: detail.name, kind: 'rp' });
      await callTool('apply_card_to_chat', { cardId: detail.cardId, chatId: chat.chatId }, apiKey);
      await applyDefaultStack(chat.chatId);
      onOpenRp(chat.chatId, detail.name);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to start RP');
    } finally {
      setStartingRp(false);
    }
  }

  async function applyDefaultStack(chatId: string) {
    try {
      const stacks = await callTool<ContextStackPreset[]>('get_context_stack_presets', {}, apiKey);
      const defaultStack = stacks.find((s) => s.isDefault);
      if (defaultStack) {
        await callTool('apply_prompt_stack_to_chat', { chatId, presetId: defaultStack.presetId }, apiKey);
      }
      await updateChat(chatId, { cleanup_enabled_at: new Date().toISOString() }, apiKey);
    } catch {
      // best-effort
    }
  }

  if (cards === null) {
    return <div className="characters-view loading">Loading cards&hellip;</div>;
  }

  const showEditor = creatingNew || selectedId !== null;

  return (
    <div
      className={`characters-view${mobileShowEditor ? ' mobile-editor' : ''}${dragOver ? ' drag-over' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e)}
    >
      {dragOver && (
        <div className="characters-drop-overlay">
          <span>Drop a character card (PNG or JSON) to import</span>
        </div>
      )}
      <div className="characters-list">
        <div className="characters-list-header">
          <span>Cards</span>
          <div className="characters-list-header-actions">
            <div className="characters-sort-toggle" role="group" aria-label="Sort cards">
              <button
                type="button"
                className={sortMode === 'newest' ? 'active' : ''}
                aria-pressed={sortMode === 'newest'}
                onClick={() => setSortMode('newest')}
              >
                Latest
              </button>
              <button
                type="button"
                className={sortMode === 'name' ? 'active' : ''}
                aria-pressed={sortMode === 'name'}
                onClick={() => setSortMode('name')}
              >
                A–Z
              </button>
            </div>
            <button type="button" className="characters-import-btn" onClick={() => fileInputRef.current?.click()}>
              Import
            </button>
            <button type="button" className="characters-new-btn" onClick={startNew}>
              + New
            </button>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".png,.json,image/png,application/json"
          multiple
          className="characters-import-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length > 0) void handleImportFiles(files);
          }}
        />
        {cards.length === 0 && <div className="empty-state">No cards yet &mdash; create one or import a card.</div>}
        {sortedCards.map((c) => (
          <div
            key={c.cardId}
            className={`characters-row${c.cardId === selectedId ? ' selected' : ''}`}
            onClick={() => selectCard(c.cardId)}
          >
            <CardAvatarThumb cardId={c.cardId} apiKey={apiKey} className="characters-row-avatar" />
            <span className="characters-row-name">{c.name}</span>
          </div>
        ))}
      </div>

      <div className="characters-editor">
        <button type="button" className="characters-back" onClick={() => setMobileShowEditor(false)}>
          &larr; Cards
        </button>

        {error && <div className="error-banner">{error}</div>}

        {!showEditor && <div className="empty-state">Pick a card, create a new one, or import one.</div>}

        {showEditor && !creatingNew && detail === null && <div className="empty-state">Loading&hellip;</div>}

        {(creatingNew || detail?.found) && (
          <>
            <div className="characters-editor-header">
              {!creatingNew && detail?.found && (
                <CardAvatarThumb cardId={detail.cardId} apiKey={apiKey} className="characters-editor-avatar" />
              )}
              <input
                className="characters-name-input"
                value={draft.name}
                onChange={(e) => updateDraft({ name: e.target.value })}
                placeholder="Character name"
              />
              {!creatingNew && detail?.found && (
                <button type="button" className="characters-delete-btn" onClick={removeCard}>
                  Delete
                </button>
              )}
            </div>

            <label className="characters-field">
              Persona
              <textarea rows={4} value={draft.persona} onChange={(e) => updateDraft({ persona: e.target.value })} />
            </label>
            <label className="characters-field">
              Appearance
              <textarea
                rows={3}
                value={draft.appearance}
                onChange={(e) => updateDraft({ appearance: e.target.value })}
                placeholder="Physical traits only — body type, height, build, facial features, natural hair colour, permanent features (scars, birthmarks). Exclude clothing, accessories, current hairstyle, injuries."
              />
            </label>
            <label className="characters-field">
              Scenario
              <textarea rows={3} value={draft.scenario} onChange={(e) => updateDraft({ scenario: e.target.value })} />
            </label>
            <label className="characters-field">
              System Prompt
              <textarea rows={3} value={draft.systemPrompt} onChange={(e) => updateDraft({ systemPrompt: e.target.value })} />
            </label>
            <label className="characters-field">
              Example Dialogue
              <textarea rows={3} value={draft.exampleDialogue} onChange={(e) => updateDraft({ exampleDialogue: e.target.value })} />
            </label>

            <div className="characters-greetings">
              <span className="characters-greetings-label">Greetings</span>
              {draft.greetings.map((g, idx) => (
                <div key={idx} className="characters-greeting-row">
                  <div className="characters-greeting-reorder">
                    <button type="button" disabled={idx === 0} onClick={() => moveGreeting(idx, -1)} aria-label="Move greeting up">
                      &#9650;
                    </button>
                    <button
                      type="button"
                      disabled={idx === draft.greetings.length - 1}
                      onClick={() => moveGreeting(idx, 1)}
                      aria-label="Move greeting down"
                    >
                      &#9660;
                    </button>
                  </div>
                  <textarea rows={2} value={g} onChange={(e) => updateGreeting(idx, e.target.value)} />
                  <button
                    type="button"
                    className="characters-greeting-delete"
                    onClick={() => removeGreeting(idx)}
                    aria-label="Remove greeting"
                  >
                    &times;
                  </button>
                </div>
              ))}
              <button type="button" onClick={addGreeting}>
                + Add greeting
              </button>
            </div>

            <div className="characters-actions">
              <button onClick={save} disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              {saved && <span className="saved-note">Saved.</span>}
              {!creatingNew && detail?.found && (
                <>
                  <button type="button" onClick={() => doExport('png')}>
                    Export PNG
                  </button>
                  <button type="button" onClick={() => doExport('json')}>
                    Export JSON
                  </button>
                </>
              )}
            </div>

            {!creatingNew && detail?.found && (
              <div className="characters-start-chat">
                <button type="button" className="characters-start-chat-btn" onClick={startRp} disabled={startingRp}>
                  {startingRp ? 'Starting…' : 'Start RP'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
