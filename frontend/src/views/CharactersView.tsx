import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import {
  ApiError,
  callTool,
  createChat,
  exportCharacterCard,
  importCharacterCard,
  seedSubjectFromCharacter,
  updateChat,
} from '../api/client';
import type { CharacterDetail, CharacterSummary, ContextStackPreset } from '../api/types';
import CharacterAvatarThumb from '../components/CharacterAvatarThumb';
import './CharactersView.css';

interface CharactersViewProps {
  apiKey: string | null;
  /** RP always opens with a real chatId already created below — the roster starts roleplay
   *  sessions only, never plain chats. */
  /** Opens (or focuses, if already open) an RP chat tab — wired to useTabs' openRp, which keeps
   *  RP chat a single slot: opening another RP chat replaces the existing one in place. */
  onOpenRp: (chatId: string, title?: string) => void;
  /** A character was deleted and its chats purged server-side — these are the deleted chat ids,
   *  so the app can close any open tabs for them and drop them from the history browsers. */
  onChatsDeleted?: (chatIds: string[]) => void;
  /** Bumped (App.tsx) whenever a card is imported from chub elsewhere, so this roster re-fetches
   *  and shows it without a manual reload. Same pattern as ChatBrowser's refreshKey. */
  refreshKey: number;
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
export default function CharactersView({ apiKey, onOpenRp, onChatsDeleted, refreshKey }: CharactersViewProps) {
  const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CharacterDetail | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [startingRp, setStartingRp] = useState(false);
  const [studioSeedStatus, setStudioSeedStatus] = useState<string | null>(null);
  const [mobileShowEditor, setMobileShowEditor] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // dragenter/dragleave fire on every child boundary crossing, not just the container's own edge —
  // a counter (rather than a plain boolean) is the standard way to tell "left a child" from "left
  // the whole drop zone" without flicker.
  const dragCounter = useRef(0);

  const refresh = useCallback(
    async (selectAfter?: string) => {
      try {
        const result = await callTool<CharacterSummary[]>('get_characters', {}, apiKey);
        setCharacters(result);
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
        const result = await callTool<CharacterDetail>('get_character', { characterId: id }, apiKey);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, refreshKey]);

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
      setError(err instanceof ApiError ? err.message : 'failed to save card');
    } finally {
      setSaving(false);
    }
  }

  async function removeCharacter() {
    if (!detail?.found) return;
    if (!window.confirm(`Delete "${detail.name}"? This can't be undone.`)) return;
    try {
      const result = await callTool<{ deleted: boolean; deletedChatIds?: string[] }>(
        'delete_character',
        { characterId: detail.characterId },
        apiKey,
      );
      // The server purged the character's chats with it (they're unusable without the persona);
      // tell the app so it closes any open tabs for them and refreshes the history browsers.
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
      await exportCharacterCard(detail.characterId, format, apiKey);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to export card');
    }
  }

  // studio-character-bridge-plan.md Part A: create-or-refresh this character's subject entity
  // in Portrait Studio from its persona. An explicit operator click every time — the server
  // overwrites an existing subject entity's standing_instructions unconditionally, so clicking
  // again after editing the persona is how the Studio copy is deliberately refreshed.
  async function sendToPortraitStudio() {
    if (!detail?.found) return;
    setStudioSeedStatus('Seeding…');
    setError(null);
    try {
      const result = await seedSubjectFromCharacter(detail.characterId, apiKey);
      setStudioSeedStatus(result.action === 'created' ? 'Seeded — tune it in Portrait Studio.' : 'Refreshed in Portrait Studio.');
      window.setTimeout(() => setStudioSeedStatus(null), 4000);
    } catch (err) {
      setStudioSeedStatus(null);
      setError(err instanceof ApiError ? err.message : 'failed to seed Portrait Studio subject');
    }
  }

  // Shared by the file-picker input and drag-and-drop: imports each file in turn (a card PNG or
  // JSON per drop is normal, so this is a sequence, not a single import) and lands on whichever one
  // imported last, since selecting all of them at once isn't a thing this editor supports.
  async function handleImportFiles(files: File[]) {
    setError(null);
    let lastImportedId: string | null = null;
    const failures: string[] = [];
    for (const file of files) {
      try {
        const imported = await importCharacterCard(file, apiKey);
        lastImportedId = imported.characterId;
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

  // Creates a kind: 'rp' chat (db/migrations/0049_chat_kind.sql) — the only kind a character
  // starts from here now. The created chat runs with no tools at all (DEFAULT_RP_TOOLS = [],
  // 2026-08-10 — the RP model just executes its prompt stack) and no household_memory leakage by
  // construction (chatSessions.ts), and opens into its own RP sidebar
  // section/tab type rather than the general chat one. The Prompt Stack picker itself still lives
  // in the RP chat's own settings panel once it's open — this just auto-applies whichever preset
  // the user has marked default (migration 0061), the same explicit signal a manual Apply click
  // would send, so a fresh RP chat doesn't start with no stack at all unless the user genuinely
  // has no default set.
  async function startRp() {
    if (!detail?.found) return;
    setStartingRp(true);
    setError(null);
    try {
      const chat = await createChat(apiKey, { title: detail.name, kind: 'rp' });
      await callTool('apply_character_to_chat', { characterId: detail.characterId, chatId: chat.chatId }, apiKey);
      await applyDefaultStack(chat.chatId);
      onOpenRp(chat.chatId, detail.name);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to start RP');
    } finally {
      setStartingRp(false);
    }
  }

  // Best-effort — same "won't block on this" shape removePreset's delete_prompt_preset call uses:
  // a missing or failed default stack shouldn't stop the RP chat from opening, just leave it with
  // no system prompt yet (the same state it started in before this feature existed). Applies the
  // user's named default prompt stack (migration 0061, apply_prompt_stack_to_chat), and enables
  // the async heuristic cleanup subloop — the cleanup shape (header/footer/antislop) is RP-only
  // by design, so every new RP chat opts in at creation, stamped at now() so the subloop only
  // ever touches messages that land after this point. Either can fail independently.
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

  if (characters === null) {
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
        {characters.length === 0 && <div className="empty-state">No cards yet &mdash; create one or import a card.</div>}
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
          &larr; Cards
        </button>

        {error && <div className="error-banner">{error}</div>}

        {!showEditor && <div className="empty-state">Pick a card, create a new one, or import one.</div>}

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
            {!creatingNew && detail?.found && (
              <div className="characters-studio-seed">
                <button
                  type="button"
                  className="characters-studio-seed-btn"
                  disabled={draft.persona.trim() === '' || studioSeedStatus === 'Seeding…'}
                  title={
                    draft.persona.trim() === ''
                      ? 'The character has no persona yet — write one first.'
                      : 'Create or refresh this character\'s subject entity in Portrait Studio (its persona becomes the entity\'s instructions)'
                  }
                  onClick={() => void sendToPortraitStudio()}
                >
                  Send to Portrait Studio
                </button>
                {studioSeedStatus && <span className="characters-studio-seed-status">{studioSeedStatus}</span>}
              </div>
            )}
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
