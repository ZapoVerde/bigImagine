import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, callTool, createChat, exportCharacterCard, importCharacterCard } from '../api/client';
import type { CharacterDetail, CharacterSummary } from '../api/types';
import CharacterAvatarThumb from '../components/CharacterAvatarThumb';
import './CharactersView.css';

interface CharactersViewProps {
  apiKey: string | null;
  onOpenChat: (chatId?: string, title?: string) => void;
}

interface Draft {
  name: string;
  persona: string;
  scenario: string;
  systemPrompt: string;
  exampleDialogue: string;
  greetings: string[];
}

const BLANK_DRAFT: Draft = { name: '', persona: '', scenario: '', systemPrompt: '', exampleDialogue: '', greetings: [] };

function draftFromDetail(detail: CharacterDetail): Draft {
  if (!detail.found) return BLANK_DRAFT;
  return {
    name: detail.name,
    persona: detail.persona,
    scenario: detail.scenario,
    systemPrompt: detail.systemPrompt,
    exampleDialogue: detail.exampleDialogue,
    greetings: detail.greetings,
  };
}

// The Character Roster (plan: "loading a card, saving a card, exporting a card, picking a card"):
// a mobile master-detail picker cloned from PromptStacksView's own shape (list pane + detail pane,
// mobileShowEditor toggling which one shows below the phone-width breakpoint). Unlike
// PromptStacksView, the list only carries id+name (get_characters is summary-only), so picking a
// row fetches the full detail separately via get_character — loadDetail() below is called
// explicitly wherever the selection changes, rather than driven off a useEffect keyed on
// selectedId, since saving an *already-selected* character needs a fresh fetch too and a same-value
// setSelectedId wouldn't retrigger an effect.
export default function CharactersView({ apiKey, onOpenChat }: CharactersViewProps) {
  const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CharacterDetail | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [startingChat, setStartingChat] = useState(false);
  const [mobileShowEditor, setMobileShowEditor] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(
    async (selectAfter?: string) => {
      try {
        const result = await callTool<CharacterSummary[]>('get_characters', {}, apiKey);
        setCharacters(result);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'failed to load characters');
      }
      if (selectAfter) setSelectedId(selectAfter);
    },
    [apiKey],
  );

  const loadDetail = useCallback(
    async (id: string) => {
      setDetail(null);
      try {
        const result = await callTool<CharacterDetail>('get_character', { characterId: id }, apiKey);
        setDetail(result);
        setDraft(draftFromDetail(result));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'failed to load character');
      }
    },
    [apiKey],
  );

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  function selectCharacter(id: string) {
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
        draft.scenario !== detail.scenario ||
        draft.systemPrompt !== detail.systemPrompt ||
        draft.exampleDialogue !== detail.exampleDialogue ||
        JSON.stringify(draft.greetings) !== JSON.stringify(detail.greetings)));

  async function save() {
    if (!draft.name.trim()) {
      setError('A character needs a name.');
      return;
    }
    const greetings = draft.greetings.map((g) => g.trim()).filter((g) => g.length > 0);
    setSaving(true);
    setError(null);
    try {
      if (creatingNew) {
        const created = await callTool<{ characterId: string; name: string }>(
          'create_character',
          {
            name: draft.name.trim(),
            persona: draft.persona,
            scenario: draft.scenario,
            system_prompt: draft.systemPrompt,
            example_dialogue: draft.exampleDialogue,
            greetings,
          },
          apiKey,
        );
        setCreatingNew(false);
        await refresh(created.characterId);
        await loadDetail(created.characterId);
      } else if (detail?.found) {
        await callTool(
          'update_character',
          {
            characterId: detail.characterId,
            name: draft.name.trim(),
            persona: draft.persona,
            scenario: draft.scenario,
            system_prompt: draft.systemPrompt,
            example_dialogue: draft.exampleDialogue,
            greetings,
          },
          apiKey,
        );
        await refresh(detail.characterId);
        await loadDetail(detail.characterId);
      }
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to save character');
    } finally {
      setSaving(false);
    }
  }

  async function removeCharacter() {
    if (!detail?.found) return;
    if (!window.confirm(`Delete "${detail.name}"? This can't be undone.`)) return;
    try {
      await callTool('delete_character', { characterId: detail.characterId }, apiKey);
      setSelectedId(null);
      setDetail(null);
      setMobileShowEditor(false);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to delete character');
    }
  }

  async function doExport(format: 'png' | 'json') {
    if (!detail?.found) return;
    try {
      await exportCharacterCard(detail.characterId, format, apiKey);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to export character');
    }
  }

  async function handleImportFile(file: File) {
    setError(null);
    try {
      const imported = await importCharacterCard(file, apiKey);
      setCreatingNew(false);
      await refresh(imported.characterId);
      await loadDetail(imported.characterId);
      setMobileShowEditor(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to import character card');
    }
  }

  // Always a brand-new chat, never the one currently open elsewhere — see plan's own note on why
  // this can't silently overwrite an in-progress conversation.
  async function startChat() {
    if (!detail?.found) return;
    setStartingChat(true);
    setError(null);
    try {
      const chat = await createChat(apiKey, { title: detail.name });
      await callTool('apply_character_to_chat', { characterId: detail.characterId, chatId: chat.chatId }, apiKey);
      onOpenChat(chat.chatId, detail.name);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to start chat');
    } finally {
      setStartingChat(false);
    }
  }

  if (characters === null) {
    return <div className="characters-view loading">Loading characters&hellip;</div>;
  }

  const showEditor = creatingNew || selectedId !== null;

  return (
    <div className={`characters-view${mobileShowEditor ? ' mobile-editor' : ''}`}>
      <div className="characters-list">
        <div className="characters-list-header">
          <span>Characters</span>
          <div className="characters-list-header-actions">
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
          className="characters-import-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void handleImportFile(file);
          }}
        />
        {characters.length === 0 && <div className="empty-state">No characters yet &mdash; create one or import a card.</div>}
        {characters.map((c) => (
          <div
            key={c.characterId}
            className={`characters-row${c.characterId === selectedId ? ' selected' : ''}`}
            onClick={() => selectCharacter(c.characterId)}
          >
            <CharacterAvatarThumb characterId={c.characterId} apiKey={apiKey} className="characters-row-avatar" />
            <span className="characters-row-name">{c.name}</span>
          </div>
        ))}
      </div>

      <div className="characters-editor">
        <button type="button" className="characters-back" onClick={() => setMobileShowEditor(false)}>
          &larr; Characters
        </button>

        {error && <div className="error-banner">{error}</div>}

        {!showEditor && <div className="empty-state">Pick a character, create a new one, or import a card.</div>}

        {showEditor && !creatingNew && detail === null && <div className="empty-state">Loading&hellip;</div>}

        {(creatingNew || detail?.found) && (
          <>
            <div className="characters-editor-header">
              {!creatingNew && detail?.found && (
                <CharacterAvatarThumb characterId={detail.characterId} apiKey={apiKey} className="characters-editor-avatar" />
              )}
              <input
                className="characters-name-input"
                value={draft.name}
                onChange={(e) => updateDraft({ name: e.target.value })}
                placeholder="Character name"
              />
              {!creatingNew && detail?.found && (
                <button type="button" className="characters-delete-btn" onClick={removeCharacter}>
                  Delete
                </button>
              )}
            </div>

            <label className="characters-field">
              Persona
              <textarea rows={4} value={draft.persona} onChange={(e) => updateDraft({ persona: e.target.value })} />
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
                <button type="button" className="characters-start-chat-btn" onClick={startChat} disabled={startingChat}>
                  {startingChat ? 'Starting…' : 'Start chat with this character'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
