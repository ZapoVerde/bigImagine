import { useState } from 'react';
import {
  ApiError,
  adminGetCanonSettings,
  adminGetChatMemorySettings,
  adminListConnections,
  adminSetCanonSettings,
  adminSetChatMemorySettings,
} from '../api/client';
import { useAdminUnlock } from '../hooks/useAdminUnlock';
import { useChatMemorySyncStatus } from '../hooks/useChatMemorySyncStatus';
import type { CanonSettings, ChatMemorySettings, ChatMemorySyncStatusRow } from '../api/types';
import './RagView.css';

// The RAG management page (docs/chat-memory.md's read/write pipeline in one place, the way
// SillyTavern-Canonize's own RAG panel is): everything about how the chat-memory archive is
// built (the rolling sync's connection/timing/prompt knobs, moved here from SettingsView) and
// how the RP read path pulls it back (the auto-recall retrieval knobs + the canon-facts top-k
// that recall_canon_facts and the silent injection both share). The live sync-status table is
// the same adminGetChatMemorySyncStatus read the Review Panel uses — one row per chat, proof
// the write path actually ran.
//
// Admin-key unlock (mount-time Access probe, then a stored key, then the manual key form) is
// hooks/useAdminUnlock.ts, shared with SettingsView/ConnectionsView — attemptLoad below is this
// view's own "prove the key works" fetch: both settings GETs (chat-memory for the write-path
// knobs + the auto-recall knobs, canon for the facts top-k) + the connections list, since the
// retrieval section reads from both endpoints and the Chat Memory fieldset labels its
// "household default" option with the active connection's name.
//
// No apiKey prop: every call here is admin-gated (useAdminUnlock), same as ConnectionsView and
// the Review Panel — nothing user-scoped on this page.
export default function RagView() {
  // --- Chat Memory write-path settings (docs/chat-memory.md, moved from SettingsView) ---
  const [chatMemorySettings, setChatMemorySettingsState] = useState<ChatMemorySettings | null>(null);
  const [selectedChatMemoryProfile, setSelectedChatMemoryProfile] = useState('');
  const [selectedLiveWindowPairs, setSelectedLiveWindowPairs] = useState('');
  const [selectedSyncEveryPairs, setSelectedSyncEveryPairs] = useState('');
  const [selectedDigestHorizonPairs, setSelectedDigestHorizonPairs] = useState('');
  const [selectedChunkSummaryPrompt, setSelectedChunkSummaryPrompt] = useState('');
  const [selectedDistillPrompt, setSelectedDistillPrompt] = useState('');
  const [selectedHouseholdMemoryPrompt, setSelectedHouseholdMemoryPrompt] = useState('');
  const [selectedBridgePrompt, setSelectedBridgePrompt] = useState('');
  const [selectedLorebookCuratorPrompt, setSelectedLorebookCuratorPrompt] = useState('');
  const [selectedPeopleCuratorPrompt, setSelectedPeopleCuratorPrompt] = useState('');
  // RP read-path injection templates (io/chatMemory/memoryInjection.ts, 2026-08-13 component
  // split) — the bridge / plot_threads / auto_recall marker wrappers rendered per turn.
  const [selectedInjectBridgePrompt, setSelectedInjectBridgePrompt] = useState('');
  const [selectedInjectPlotPrompt, setSelectedInjectPlotPrompt] = useState('');
  const [selectedInjectAutoRecallPrompt, setSelectedInjectAutoRecallPrompt] = useState('');
  const [selectedAutoRecallChunkPrompt, setSelectedAutoRecallChunkPrompt] = useState('');
  const [chatMemoryStatus, setChatMemoryStatus] = useState('');

  // --- Retrieval knobs: the RP read path's auto-recall (recallForPrompt.ts, migration 0077)
  // + the canon-facts top-k (recall_canon_facts, live on every recall call). ---
  const [canonSettings, setCanonSettingsState] = useState<CanonSettings | null>(null);
  const [selectedAutoRecallEnabled, setSelectedAutoRecallEnabled] = useState(true);
  const [selectedAutoRecallPairs, setSelectedAutoRecallPairs] = useState('');
  const [selectedAutoRecallChunkTopK, setSelectedAutoRecallChunkTopK] = useState('');
  const [selectedCanonRecallTopK, setSelectedCanonRecallTopK] = useState('');
  const [retrievalStatus, setRetrievalStatus] = useState('');

  // Read-only — set from the one active row in adminListConnections(), purely to label the Chat
  // Memory fieldset's "household default" option below. Editing connections lives in
  // views/ConnectionsView.tsx now.
  const [activeConnectionName, setActiveConnectionName] = useState('');

  function applyChatMemorySettings(settings: ChatMemorySettings) {
    setChatMemorySettingsState(settings);
    setSelectedChatMemoryProfile(settings.profile ?? '');
    setSelectedLiveWindowPairs(settings.liveWindowPairs === null ? '' : String(settings.liveWindowPairs));
    setSelectedSyncEveryPairs(settings.syncEveryPairs === null ? '' : String(settings.syncEveryPairs));
    setSelectedDigestHorizonPairs(settings.digestHorizonPairs === null ? '' : String(settings.digestHorizonPairs));
    setSelectedChunkSummaryPrompt(settings.chunkSummaryPrompt);
    setSelectedDistillPrompt(settings.distillPrompt);
    setSelectedHouseholdMemoryPrompt(settings.householdMemoryPrompt);
    setSelectedBridgePrompt(settings.bridgePrompt);
    setSelectedLorebookCuratorPrompt(settings.lorebookCuratorPrompt);
    setSelectedPeopleCuratorPrompt(settings.peopleCuratorPrompt);
    setSelectedInjectBridgePrompt(settings.injectBridgePrompt);
    setSelectedInjectPlotPrompt(settings.injectPlotPrompt);
    setSelectedInjectAutoRecallPrompt(settings.injectAutoRecallPrompt);
    setSelectedAutoRecallChunkPrompt(settings.autoRecallChunkPrompt);
    setSelectedAutoRecallEnabled(settings.autoRecallEnabled);
    setSelectedAutoRecallPairs(settings.autoRecallPairs === null ? '' : String(settings.autoRecallPairs));
    setSelectedAutoRecallChunkTopK(settings.autoRecallChunkTopK === null ? '' : String(settings.autoRecallChunkTopK));
  }

  function applyCanonSettings(settings: CanonSettings) {
    setCanonSettingsState(settings);
    setSelectedCanonRecallTopK(String(settings.recallTopK));
  }

  // Whatever proves the key works — every admin GET this tab needs on first load. Shared unlock
  // state (adminKey/checking/unlocked/loadError, the mount-time no-key-then-stored-key probe, the
  // manual Load button's handler) lives in useAdminUnlock, not duplicated here.
  async function attemptLoad(key: string | null): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const [chatMemorySettingsResult, canonSettingsResult, connections] = await Promise.all([
        adminGetChatMemorySettings(key),
        adminGetCanonSettings(key),
        adminListConnections(key),
      ]);
      applyChatMemorySettings(chatMemorySettingsResult);
      applyCanonSettings(canonSettingsResult);
      setActiveConnectionName(connections.find((c) => c.isActive)?.name ?? '');
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  const { adminKey, setAdminKey, checking, unlocked, loadError, load } = useAdminUnlock(attemptLoad);

  // The sync-status table, once unlocked — same 30s poll cadence as the Review Panel.
  const { rows, refresh } = useChatMemorySyncStatus(adminKey, unlocked);

  // Only the fields that actually changed are sent — an untouched prompt textarea stays exactly
  // what it was (default or a prior override), it isn't silently re-saved as an override.
  async function saveChatMemorySettings() {
    if (!chatMemorySettings) return;
    const patch: Parameters<typeof adminSetChatMemorySettings>[0] = {};
    if (selectedChatMemoryProfile !== (chatMemorySettings.profile ?? '')) patch.profile = selectedChatMemoryProfile;
    const liveWindowPairs = Number(selectedLiveWindowPairs);
    if (selectedLiveWindowPairs && liveWindowPairs !== chatMemorySettings.liveWindowPairs) patch.live_window_pairs = liveWindowPairs;
    const syncEveryPairs = Number(selectedSyncEveryPairs);
    if (selectedSyncEveryPairs && syncEveryPairs !== chatMemorySettings.syncEveryPairs) patch.sync_every_pairs = syncEveryPairs;
    const digestHorizonPairs = Number(selectedDigestHorizonPairs);
    if (selectedDigestHorizonPairs && digestHorizonPairs !== chatMemorySettings.digestHorizonPairs) {
      patch.digest_horizon_pairs = digestHorizonPairs;
    }
    if (selectedChunkSummaryPrompt !== chatMemorySettings.chunkSummaryPrompt) patch.chunk_summary_prompt = selectedChunkSummaryPrompt;
    if (selectedDistillPrompt !== chatMemorySettings.distillPrompt) patch.distill_prompt = selectedDistillPrompt;
    if (selectedHouseholdMemoryPrompt !== chatMemorySettings.householdMemoryPrompt) {
      patch.household_memory_prompt = selectedHouseholdMemoryPrompt;
    }
    if (selectedBridgePrompt !== chatMemorySettings.bridgePrompt) patch.bridge_prompt = selectedBridgePrompt;
    if (selectedLorebookCuratorPrompt !== chatMemorySettings.lorebookCuratorPrompt) {
      patch.lorebook_curator_prompt = selectedLorebookCuratorPrompt;
    }
    if (selectedPeopleCuratorPrompt !== chatMemorySettings.peopleCuratorPrompt) {
      patch.people_curator_prompt = selectedPeopleCuratorPrompt;
    }
    if (Object.keys(patch).length === 0) return;

    setChatMemoryStatus('');
    try {
      const updated = await adminSetChatMemorySettings(patch, adminKey);
      applyChatMemorySettings(updated);
    } catch (err) {
      setChatMemoryStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
      return;
    }
    setChatMemoryStatus('Saved — takes effect on the next sync tick, no restart needed.');
  }

  function resetChatMemoryPrompt(
    field:
      | 'chunkSummaryPrompt'
      | 'distillPrompt'
      | 'householdMemoryPrompt'
      | 'bridgePrompt'
      | 'lorebookCuratorPrompt'
      | 'peopleCuratorPrompt'
      | 'injectBridgePrompt'
      | 'injectPlotPrompt'
      | 'injectAutoRecallPrompt'
      | 'autoRecallChunkPrompt',
  ) {
    if (field === 'chunkSummaryPrompt') setSelectedChunkSummaryPrompt('');
    if (field === 'distillPrompt') setSelectedDistillPrompt('');
    if (field === 'householdMemoryPrompt') setSelectedHouseholdMemoryPrompt('');
    if (field === 'bridgePrompt') setSelectedBridgePrompt('');
    if (field === 'lorebookCuratorPrompt') setSelectedLorebookCuratorPrompt('');
    if (field === 'peopleCuratorPrompt') setSelectedPeopleCuratorPrompt('');
    if (field === 'injectBridgePrompt') setSelectedInjectBridgePrompt('');
    if (field === 'injectPlotPrompt') setSelectedInjectPlotPrompt('');
    if (field === 'injectAutoRecallPrompt') setSelectedInjectAutoRecallPrompt('');
    if (field === 'autoRecallChunkPrompt') setSelectedAutoRecallChunkPrompt('');
  }

  // The retrieval knobs split across two endpoints: the auto-recall trio lives in
  // chat-memory-settings (recallForPrompt.ts reads them live on every RP prompt assembly), the
  // canon top-k in canon-settings (recall_canon_facts reads it live on every recall call). A
  // combined Save patches whichever actually changed — both no-ops leave the fieldset untouched.
  async function saveRetrievalSettings() {
    if (!chatMemorySettings || !canonSettings) return;
    const memoryPatch: Parameters<typeof adminSetChatMemorySettings>[0] = {};
    if (selectedAutoRecallEnabled !== chatMemorySettings.autoRecallEnabled) {
      memoryPatch.auto_recall_enabled = selectedAutoRecallEnabled;
    }
    const autoRecallPairs = Number(selectedAutoRecallPairs);
    if (selectedAutoRecallPairs && autoRecallPairs !== chatMemorySettings.autoRecallPairs) {
      memoryPatch.auto_recall_pairs = autoRecallPairs;
    }
    const autoRecallChunkTopK = Number(selectedAutoRecallChunkTopK);
    if (selectedAutoRecallChunkTopK && autoRecallChunkTopK !== chatMemorySettings.autoRecallChunkTopK) {
      memoryPatch.auto_recall_chunk_top_k = autoRecallChunkTopK;
    }
    if (selectedInjectBridgePrompt !== chatMemorySettings.injectBridgePrompt) memoryPatch.inject_bridge_prompt = selectedInjectBridgePrompt;
    if (selectedInjectPlotPrompt !== chatMemorySettings.injectPlotPrompt) memoryPatch.inject_plot_prompt = selectedInjectPlotPrompt;
    if (selectedInjectAutoRecallPrompt !== chatMemorySettings.injectAutoRecallPrompt) {
      memoryPatch.inject_auto_recall_prompt = selectedInjectAutoRecallPrompt;
    }
    if (selectedAutoRecallChunkPrompt !== chatMemorySettings.autoRecallChunkPrompt) {
      memoryPatch.auto_recall_chunk_prompt = selectedAutoRecallChunkPrompt;
    }
    const canonPatch: Parameters<typeof adminSetCanonSettings>[0] = {};
    const canonRecallTopK = Number(selectedCanonRecallTopK);
    if (selectedCanonRecallTopK && canonRecallTopK !== canonSettings.recallTopK) {
      canonPatch.recall_top_k = canonRecallTopK;
    }
    if (Object.keys(memoryPatch).length === 0 && Object.keys(canonPatch).length === 0) return;

    setRetrievalStatus('');
    const succeeded: string[] = [];
    try {
      if (Object.keys(memoryPatch).length > 0) {
        const updated = await adminSetChatMemorySettings(memoryPatch, adminKey);
        applyChatMemorySettings(updated);
        succeeded.push('retrieval');
      }
      if (Object.keys(canonPatch).length > 0) {
        const updated = await adminSetCanonSettings(canonPatch, adminKey);
        applyCanonSettings(updated);
        succeeded.push('canon');
      }
    } catch (err) {
      // The two endpoints are saved sequentially; if the second fails the first already
      // persisted. Say exactly what happened rather than a blanket error, so the user knows
      // which half is already live and which to retry.
      const failed = Object.keys(memoryPatch).length > 0 && !succeeded.includes('retrieval') ? 'retrieval' : 'canon';
      setRetrievalStatus(
        succeeded.length > 0
          ? `error: ${err instanceof ApiError ? err.message : 'failed to save'} — ${succeeded.join(' and ')} already saved, ${failed} not`
          : err instanceof ApiError
            ? `error: ${err.message}`
            : 'failed to save',
      );
      return;
    }
    setRetrievalStatus('Saved — takes effect on the next RP turn / recall call, no restart needed.');
  }

  if (checking) {
    return <div className="rag-view" />;
  }

  if (!unlocked) {
    return (
      <div className="rag-view">
        <h1>RAG</h1>
        <label>
          Admin API key
          <br />
          <input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} />
        </label>
        <br />
        <button onClick={load}>Load</button>
        {loadError && <div className="error-banner">{loadError}</div>}
      </div>
    );
  }

  return (
    <div className="rag-view">
      <h1>RAG</h1>
      <div className="status rag-view-intro">
        Everything about the chat-memory pipeline in one place: the write path (how the rolling sync
        builds the archive — chunk/summarize/distill + the RP curators) and the read path (what the
        RP auto-recall and recall_canon_facts pull back into the prompt). The live sync-status table
        below is the same admin read as the Review Panel — proof the write path actually ran.
      </div>

      <fieldset>
        <legend>Chat Memory — how the archive is built</legend>
        <label>
          Connection
          <br />
          <select value={selectedChatMemoryProfile} onChange={(e) => setSelectedChatMemoryProfile(e.target.value)}>
            <option value="">(household default{activeConnectionName ? ` — ${activeConnectionName}` : ''})</option>
            {(chatMemorySettings?.profileNames ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <span className="model-connection-note">Which connection runs the rolling summarize/recall pipeline's calls — leave blank to use the active connection.</span>
        </label>
        <br />
        <label>
          Live window (turn pairs)
          <br />
          <input
            type="number"
            min="1"
            value={selectedLiveWindowPairs}
            onChange={(e) => setSelectedLiveWindowPairs(e.target.value)}
            placeholder="8"
          />
        </label>
        <br />
        <label>
          Sync every (turn pairs)
          <br />
          <input
            type="number"
            min="1"
            value={selectedSyncEveryPairs}
            onChange={(e) => setSelectedSyncEveryPairs(e.target.value)}
            placeholder="8"
          />
        </label>
        <br />
        <label>
          Digest horizon (turn pairs)
          <br />
          <input
            type="number"
            min="1"
            value={selectedDigestHorizonPairs}
            onChange={(e) => setSelectedDigestHorizonPairs(e.target.value)}
            placeholder="24"
          />
        </label>
        <div className="status">
          Live window: how many of the most recent turn pairs stay in full view. Sync every: how many pairs accumulate past
          that before the next chunk/summarize/distill pass runs. Digest horizon: how far back the key-ideas digest re-reads
          chunk summaries on each sync, not just what's brand new since the last one.
        </div>
        <br />
        <label>
          Chunk summary prompt {chatMemorySettings?.chunkSummaryPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea value={selectedChunkSummaryPrompt} onChange={(e) => setSelectedChunkSummaryPrompt(e.target.value)} rows={3} />
        </label>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('chunkSummaryPrompt')}>
          Reset to default
        </button>
        <br />
        <label>
          Key-ideas digest prompt {chatMemorySettings?.distillPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea value={selectedDistillPrompt} onChange={(e) => setSelectedDistillPrompt(e.target.value)} rows={3} />
        </label>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('distillPrompt')}>
          Reset to default
        </button>
        <br />
        <label>
          Long-term memory prompt {chatMemorySettings?.householdMemoryPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea value={selectedHouseholdMemoryPrompt} onChange={(e) => setSelectedHouseholdMemoryPrompt(e.target.value)} rows={3} />
        </label>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('householdMemoryPrompt')}>
          Reset to default
        </button>
        <br />
        <label>
          RP bridge prompt (SCENE / EVENTS / PLOT) {chatMemorySettings?.bridgePromptIsDefault && <em>(default)</em>}
          <br />
          <textarea value={selectedBridgePrompt} onChange={(e) => setSelectedBridgePrompt(e.target.value)} rows={20} />
        </label>
        <div className="status">
          Used only for 'rp'-kind chats, in place of the key-ideas digest prompt above: reads the raw transcript and this
          chat's own previous SCENE/EVENTS output every sync tick to maintain an evolving scene, a table of upcoming
          events, and arc-tagged plot entries — the storytelling-continuity lane, kept separate from the household
          digest lane per chat kind.
        </div>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('bridgePrompt')}>
          Reset to default
        </button>
        <br />
        <label>
          Lorebook curator prompt (place / thing / concept) {chatMemorySettings?.lorebookCuratorPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea
            value={selectedLorebookCuratorPrompt}
            onChange={(e) => setSelectedLorebookCuratorPrompt(e.target.value)}
            rows={20}
          />
        </label>
        <div className="status">
          Runs every sync tick alongside the RP bridge prompt above, for 'rp'-kind chats only: reviews the transcript
          against every existing approved place/thing/concept entry and proposes updates, new entries, and duplicate
          flags — CNZ's periodic lorebook curator.
        </div>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('lorebookCuratorPrompt')}>
          Reset to default
        </button>
        <br />
        <label>
          People curator prompt (person) {chatMemorySettings?.peopleCuratorPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea value={selectedPeopleCuratorPrompt} onChange={(e) => setSelectedPeopleCuratorPrompt(e.target.value)} rows={20} />
        </label>
        <div className="status">
          Runs every sync tick alongside the RP bridge prompt above, for 'rp'-kind chats only: maintains a living
          seven-section record for every named person — CNZ's periodic people curator.
        </div>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('peopleCuratorPrompt')}>
          Reset to default
        </button>
        <br />
        <button onClick={saveChatMemorySettings}>Save</button>
        <div className="status">{chatMemoryStatus}</div>
      </fieldset>

      <fieldset>
        <legend>Retrieval — what the RP read path pulls</legend>
        <label>
          <input
            type="checkbox"
            checked={selectedAutoRecallEnabled}
            onChange={(e) => setSelectedAutoRecallEnabled(e.target.checked)}
          />
          Auto-recall every RP turn
          <span className="model-connection-note">
            On by default: at prompt-stack assembly the last few turn-pairs are embedded and the top archived
            chunks + approved canon facts are injected silently (the CNZ-style read path, docs/chat-memory.md
            "The RP Read Path"). Off = only the explicit recall tools inject, when the model calls them.
          </span>
        </label>
        <br />
        <label>
          Query size (turn pairs)
          <br />
          <input
            type="number"
            min="1"
            value={selectedAutoRecallPairs}
            onChange={(e) => setSelectedAutoRecallPairs(e.target.value)}
            placeholder="3"
          />
        </label>
        <div className="status">How many trailing turn-pairs are embedded as the recall query (the knob behind AUTO_RECALL_PAIRS).</div>
        <br />
        <label>
          Full-turn chunks injected
          <br />
          <input
            type="number"
            min="1"
            max="12"
            value={selectedAutoRecallChunkTopK}
            onChange={(e) => setSelectedAutoRecallChunkTopK(e.target.value)}
            placeholder="4"
          />
        </label>
        <div className="status">How many archived full-turn chunks the silent recall injects (AUTO_RECALL_CHUNK_TOP_K, capped at 12).</div>
        <br />
        <label>
          Canon facts injected
          <br />
          <input
            type="number"
            min="1"
            value={selectedCanonRecallTopK}
            onChange={(e) => setSelectedCanonRecallTopK(e.target.value)}
            placeholder="8"
          />
        </label>
        <div className="status">
          How many approved canon facts both the silent recall and the recall_canon_facts tool return (canon_recall_top_k,
          read live on every recall call). The extraction pass that proposes new facts is Director Pass work — see
          docs/canonize-plan.md §2.
        </div>
        <br />
        <hr />
        <div className="status">
          Component injection templates — how the three RP memory markers (bridge / plot threads / auto recall) are
          rendered into the prompt stack, CNZ-style. Each slot is its own prompt you can order in the preset; empty
          component = the slot emits nothing. Available variables: bridge: {'{{scene}} {{events}}'}; plot: {'{{plot}}'};
          auto recall: {'{{text}} {{facts}}'} (chunk template: {'{{text}} {{turn_range}} {{header}} {{char_name}}'}), with
          optional {'{{#if var}}…{{/if}}'} blocks. Edit the preset's markers in the Prompt Stacks tab.
        </div>
        <label>
          Bridge injection prompt (scene + events) {chatMemorySettings?.injectBridgePromptIsDefault && <em>(default)</em>}
          <br />
          <textarea value={selectedInjectBridgePrompt} onChange={(e) => setSelectedInjectBridgePrompt(e.target.value)} rows={5} />
        </label>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('injectBridgePrompt')}>
          Reset to default
        </button>
        <br />
        <label>
          Plot threads injection prompt {chatMemorySettings?.injectPlotPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea value={selectedInjectPlotPrompt} onChange={(e) => setSelectedInjectPlotPrompt(e.target.value)} rows={5} />
        </label>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('injectPlotPrompt')}>
          Reset to default
        </button>
        <br />
        <label>
          Auto-recall injection prompt {chatMemorySettings?.injectAutoRecallPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea
            value={selectedInjectAutoRecallPrompt}
            onChange={(e) => setSelectedInjectAutoRecallPrompt(e.target.value)}
            rows={5}
          />
        </label>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('injectAutoRecallPrompt')}>
          Reset to default
        </button>
        <br />
        <label>
          Auto-recall chunk template {chatMemorySettings?.autoRecallChunkPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea value={selectedAutoRecallChunkPrompt} onChange={(e) => setSelectedAutoRecallChunkPrompt(e.target.value)} rows={5} />
        </label>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('autoRecallChunkPrompt')}>
          Reset to default
        </button>
        <br />
        <button onClick={saveRetrievalSettings}>Save</button>
        <div className="status">{retrievalStatus}</div>
      </fieldset>

      <fieldset>
        <legend>Sync status</legend>
        <button className="rag-refresh" onClick={refresh}>
          Refresh
        </button>
        <SyncStatusTable rows={rows} />
      </fieldset>
    </div>
  );
}

function SyncStatusTable({ rows }: { rows: ChatMemorySyncStatusRow[] | null }) {
  if (rows === null) {
    return <div className="status">Loading sync status&hellip;</div>;
  }
  if (rows.length === 0) {
    return <div className="status">No chats have gone through the memory sync loop yet.</div>;
  }
  const healthy = rows.filter((r) => r.lastStatus === 'ok').length;
  const skipped = rows.filter((r) => r.lastStatus === 'skipped').length;
  const errored = rows.filter((r) => r.lastStatus === 'error').length;
  const lastTick = rows.reduce<string | null>(
    (latest, r) => (latest === null || r.lastAttemptAt > latest ? r.lastAttemptAt : latest),
    null,
  );
  return (
    <>
      <div className="status">
        {`${healthy} healthy / ${skipped} skipped / ${errored} errored`}
        {lastTick ? ` — last tick ${new Date(lastTick).toLocaleString()}` : ''}
      </div>
      <table className="rag-sync-table">
        <thead>
          <tr>
            <th>Chat</th>
            <th>Status</th>
            <th>Last attempt</th>
            <th>Last success</th>
            <th>Chunks / entries</th>
            <th>Canon facts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.chatId}>
              <td>{r.chatTitle}</td>
              <td>
                <span className={`rag-badge-${r.lastStatus}`}>{r.lastStatus}</span>
                {r.consecutiveErrors > 1 && <span className="rag-consecutive"> ×{r.consecutiveErrors}</span>}
              </td>
              <td>{new Date(r.lastAttemptAt).toLocaleString()}</td>
              <td>{r.lastSuccessAt ? new Date(r.lastSuccessAt).toLocaleString() : '—'}</td>
              <td>
                {r.lastChunksAdded ?? '—'} / {r.lastEntriesUpdated ?? '—'}
              </td>
              <td>
                {r.canonProposedCount} proposed / {r.canonApprovedCount} approved
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
