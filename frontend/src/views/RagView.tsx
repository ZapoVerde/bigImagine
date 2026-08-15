import { useEffect, useState } from 'react';
import {
  ApiError,
  adminGetCanonSettings,
  adminGetChatMemorySettings,
  adminGetChunkResizeStatus,
  adminListConnections,
  adminSetCanonSettings,
  adminSetChatMemorySettings,
  adminTriggerChunkResize,
} from '../api/client';
import { useAdminUnlock } from '../hooks/useAdminUnlock';
import { useChatMemorySyncStatus } from '../hooks/useChatMemorySyncStatus';
import type { CanonSettings, ChatMemorySettings, ChatMemorySyncStatusRow, ChunkResizeStatus } from '../api/types';
import ChunkResizeWarningModal from '../components/ChunkResizeWarningModal';
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
  const [selectedChunkPairs, setSelectedChunkPairs] = useState('');
  const [selectedChunkSummaryPrompt, setSelectedChunkSummaryPrompt] = useState('');
  const [selectedDistillPrompt, setSelectedDistillPrompt] = useState('');
  const [selectedHouseholdMemoryPrompt, setSelectedHouseholdMemoryPrompt] = useState('');
  const [selectedBridgePrompt, setSelectedBridgePrompt] = useState('');
  const [selectedWorldCuratorPrompt, setSelectedWorldCuratorPrompt] = useState('');
  const [selectedPeopleCuratorPrompt, setSelectedPeopleCuratorPrompt] = useState('');
  // RP read-path injection templates (io/chatMemory/memoryInjection.ts, 2026-08-13 component
  // split) — the bridge / plot_threads / auto_recall / recent_history marker wrappers rendered
  // per turn. recent_history (2026-08-10) renders the active context: the live-window turns, last
  // sent turn included, inside whatever HTML tags the preset authored around the slot.
  const [selectedInjectBridgePrompt, setSelectedInjectBridgePrompt] = useState('');
  const [selectedInjectPlotPrompt, setSelectedInjectPlotPrompt] = useState('');
  const [selectedInjectAutoRecallPrompt, setSelectedInjectAutoRecallPrompt] = useState('');
  const [selectedInjectRecentHistoryPrompt, setSelectedInjectRecentHistoryPrompt] = useState('');
  const [selectedAutoRecallChunkPrompt, setSelectedAutoRecallChunkPrompt] = useState('');
  const [selectedAutoRecallLeadInPrompt, setSelectedAutoRecallLeadInPrompt] = useState('');
  const [selectedInjectSyncSummariesPrompt, setSelectedInjectSyncSummariesPrompt] = useState('');
  const [selectedSyncSummaryEntryPrompt, setSelectedSyncSummaryEntryPrompt] = useState('');
  const [chatMemoryStatus, setChatMemoryStatus] = useState('');
  // The chunk-size backfill's singleton progress row (docs/plans/chunk-size-resize-plan.md) —
  // polled while 'running'; also read once on unlock so a pass started in another session shows up.
  const [chunkResizeStatus, setChunkResizeStatus] = useState<ChunkResizeStatus | null>(null);
  const [chunkResizeModalOpen, setChunkResizeModalOpen] = useState(false);

  // --- Retrieval knobs: the RP read path's auto-recall (recallForPrompt.ts, migration 0077)
  // + the canon-facts top-k (recall_canon_facts, live on every recall call). ---
  const [canonSettings, setCanonSettingsState] = useState<CanonSettings | null>(null);
  const [selectedAutoRecallEnabled, setSelectedAutoRecallEnabled] = useState(true);
  const [selectedAutoRecallPairs, setSelectedAutoRecallPairs] = useState('');
  const [selectedAutoRecallChunkTopK, setSelectedAutoRecallChunkTopK] = useState('');
  const [selectedAutoRecallMin, setSelectedAutoRecallMin] = useState('');
  const [selectedAutoRecallPoolMultiple, setSelectedAutoRecallPoolMultiple] = useState('');
  const [selectedAutoRecallCutoffMode, setSelectedAutoRecallCutoffMode] = useState<'mean' | 'mean+1sd' | 'mean+2sd'>('mean');
  const [selectedAutoRecallLeadInChunks, setSelectedAutoRecallLeadInChunks] = useState('');
  const [selectedCanonRecallTopK, setSelectedCanonRecallTopK] = useState('');
  const [selectedCanonRecallMin, setSelectedCanonRecallMin] = useState('');
  // Ranked plot-arc lane knobs (migration 0097, io/chatMemory/recallPlotLane.ts) — Max cards,
  // Min floor, and the recency floor in sync ticks.
  const [selectedPlotRecallTopK, setSelectedPlotRecallTopK] = useState('');
  const [selectedPlotRecallMin, setSelectedPlotRecallMin] = useState('');
  const [selectedPlotRecallFloorSyncs, setSelectedPlotRecallFloorSyncs] = useState('');
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
    setSelectedChunkPairs(settings.chunkPairs === null ? '' : String(settings.chunkPairs));
    setSelectedChunkSummaryPrompt(settings.chunkSummaryPrompt);
    setSelectedDistillPrompt(settings.distillPrompt);
    setSelectedHouseholdMemoryPrompt(settings.householdMemoryPrompt);
    setSelectedBridgePrompt(settings.bridgePrompt);
    setSelectedWorldCuratorPrompt(settings.worldCuratorPrompt);
    setSelectedPeopleCuratorPrompt(settings.peopleCuratorPrompt);
    setSelectedInjectBridgePrompt(settings.injectBridgePrompt);
    setSelectedInjectPlotPrompt(settings.injectPlotPrompt);
    setSelectedInjectAutoRecallPrompt(settings.injectAutoRecallPrompt);
    setSelectedInjectRecentHistoryPrompt(settings.injectRecentHistoryPrompt);
    setSelectedAutoRecallChunkPrompt(settings.autoRecallChunkPrompt);
    setSelectedAutoRecallLeadInPrompt(settings.autoRecallLeadInPrompt);
    setSelectedInjectSyncSummariesPrompt(settings.injectSyncSummariesPrompt);
    setSelectedSyncSummaryEntryPrompt(settings.syncSummaryEntryPrompt);
    setSelectedAutoRecallEnabled(settings.autoRecallEnabled);
    setSelectedAutoRecallPairs(settings.autoRecallPairs === null ? '' : String(settings.autoRecallPairs));
    setSelectedAutoRecallChunkTopK(settings.autoRecallChunkTopK === null ? '' : String(settings.autoRecallChunkTopK));
    setSelectedAutoRecallMin(settings.autoRecallMin === null ? '' : String(settings.autoRecallMin));
    setSelectedAutoRecallPoolMultiple(settings.autoRecallPoolMultiple === null ? '' : String(settings.autoRecallPoolMultiple));
    setSelectedAutoRecallCutoffMode(settings.autoRecallCutoffMode === null ? 'mean' : settings.autoRecallCutoffMode);
    setSelectedAutoRecallLeadInChunks(settings.autoRecallLeadInChunks === null ? '' : String(settings.autoRecallLeadInChunks));
    setSelectedPlotRecallTopK(settings.plotRecallTopK === null ? '' : String(settings.plotRecallTopK));
    setSelectedPlotRecallMin(settings.plotRecallMin === null ? '' : String(settings.plotRecallMin));
    setSelectedPlotRecallFloorSyncs(settings.plotRecallFloorSyncs === null ? '' : String(settings.plotRecallFloorSyncs));
  }

  function applyCanonSettings(settings: CanonSettings) {
    setCanonSettingsState(settings);
    setSelectedCanonRecallTopK(String(settings.recallTopK));
    setSelectedCanonRecallMin(settings.recallMin === null ? '' : String(settings.recallMin));
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
    const chunkPairs = Number(selectedChunkPairs);
    if (selectedChunkPairs && chunkPairs !== chatMemorySettings.chunkPairs) patch.chunk_pairs = chunkPairs;
    if (selectedChunkSummaryPrompt !== chatMemorySettings.chunkSummaryPrompt) patch.chunk_summary_prompt = selectedChunkSummaryPrompt;
    if (selectedDistillPrompt !== chatMemorySettings.distillPrompt) patch.distill_prompt = selectedDistillPrompt;
    if (selectedHouseholdMemoryPrompt !== chatMemorySettings.householdMemoryPrompt) {
      patch.household_memory_prompt = selectedHouseholdMemoryPrompt;
    }
    if (selectedBridgePrompt !== chatMemorySettings.bridgePrompt) patch.bridge_prompt = selectedBridgePrompt;
    if (selectedWorldCuratorPrompt !== chatMemorySettings.worldCuratorPrompt) {
      patch.world_curator_prompt = selectedWorldCuratorPrompt;
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

  // The chunk-size input's guarded save: a new size only affects NEW chunks, so changing it asks
  // whether to also fire the one-time re-chunk backfill (ChunkResizeWarningModal). Any other
  // field's change saves straight through — the modal only appears when chunk-pairs actually
  // changed. "Change setting only" = the plain save; "Change and re-chunk now" = the plain save,
  // then trigger the backfill (its progress appears below the fieldset's Save button).
  async function handleChatMemorySave() {
    if (!chatMemorySettings) return;
    const chunkPairs = Number(selectedChunkPairs);
    const chunkPairsChanged = !!selectedChunkPairs && chunkPairs !== chatMemorySettings.chunkPairs;
    if (chunkPairsChanged) {
      setChunkResizeModalOpen(true);
      return;
    }
    await saveChatMemorySettings();
  }

  // Fire the one-time re-chunk backfill (orchestrator/chatChunkResize.ts, claimed atomically —
  // 409 when a pass is already live). Fire-and-forget on the server; we optimistically read the
  // just-claimed 'running' row so the poll below picks up progress immediately.
  async function triggerChunkResize() {
    try {
      await adminTriggerChunkResize(adminKey);
      setChunkResizeStatus(await adminGetChunkResizeStatus(adminKey));
      setChatMemoryStatus('');
    } catch (err) {
      setChatMemoryStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to start re-chunk');
    }
  }

  // Poll the backfill's singleton progress row: once on unlock (a pass may already be running
  // from another session), then every 2s while one is running, stopping at done/error.
  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    async function poll() {
      try {
        const status = await adminGetChunkResizeStatus(adminKey);
        if (!cancelled) setChunkResizeStatus(status);
      } catch {
        // Best-effort — a failed poll leaves the last-known state; the next tick retries.
      }
    }
    void poll();
    if (chunkResizeStatus?.status !== 'running') return;
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [unlocked, adminKey, chunkResizeStatus?.status]);

  function resetChatMemoryPrompt(
    field:
      | 'chunkSummaryPrompt'
      | 'distillPrompt'
      | 'householdMemoryPrompt'
      | 'bridgePrompt'
      | 'worldCuratorPrompt'
      | 'peopleCuratorPrompt'
      | 'injectBridgePrompt'
      | 'injectPlotPrompt'
      | 'injectAutoRecallPrompt'
      | 'injectRecentHistoryPrompt'
      | 'autoRecallChunkPrompt'
      | 'autoRecallLeadInPrompt'
      | 'injectSyncSummariesPrompt'
      | 'syncSummaryEntryPrompt',
  ) {
    if (field === 'chunkSummaryPrompt') setSelectedChunkSummaryPrompt('');
    if (field === 'distillPrompt') setSelectedDistillPrompt('');
    if (field === 'householdMemoryPrompt') setSelectedHouseholdMemoryPrompt('');
    if (field === 'bridgePrompt') setSelectedBridgePrompt('');
    if (field === 'worldCuratorPrompt') setSelectedWorldCuratorPrompt('');
    if (field === 'peopleCuratorPrompt') setSelectedPeopleCuratorPrompt('');
    if (field === 'injectBridgePrompt') setSelectedInjectBridgePrompt('');
    if (field === 'injectPlotPrompt') setSelectedInjectPlotPrompt('');
    if (field === 'injectAutoRecallPrompt') setSelectedInjectAutoRecallPrompt('');
    if (field === 'injectRecentHistoryPrompt') setSelectedInjectRecentHistoryPrompt('');
    if (field === 'autoRecallChunkPrompt') setSelectedAutoRecallChunkPrompt('');
    if (field === 'autoRecallLeadInPrompt') setSelectedAutoRecallLeadInPrompt('');
    if (field === 'injectSyncSummariesPrompt') setSelectedInjectSyncSummariesPrompt('');
    if (field === 'syncSummaryEntryPrompt') setSelectedSyncSummaryEntryPrompt('');
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
    const autoRecallMin = Number(selectedAutoRecallMin);
    if (selectedAutoRecallMin && autoRecallMin !== chatMemorySettings.autoRecallMin) {
      memoryPatch.auto_recall_chunk_min = autoRecallMin;
    }
    const autoRecallPoolMultiple = Number(selectedAutoRecallPoolMultiple);
    if (selectedAutoRecallPoolMultiple && autoRecallPoolMultiple !== chatMemorySettings.autoRecallPoolMultiple) {
      memoryPatch.auto_recall_pool_multiple = autoRecallPoolMultiple;
    }
    if (selectedAutoRecallCutoffMode !== (chatMemorySettings.autoRecallCutoffMode ?? 'mean')) {
      memoryPatch.auto_recall_cutoff_mode = selectedAutoRecallCutoffMode;
    }
    const plotRecallTopK = Number(selectedPlotRecallTopK);
    if (selectedPlotRecallTopK && plotRecallTopK !== chatMemorySettings.plotRecallTopK) {
      memoryPatch.plot_recall_top_k = plotRecallTopK;
    }
    const plotRecallMin = Number(selectedPlotRecallMin);
    if (selectedPlotRecallMin && plotRecallMin !== chatMemorySettings.plotRecallMin) {
      memoryPatch.plot_recall_min = plotRecallMin;
    }
    const plotRecallFloorSyncs = Number(selectedPlotRecallFloorSyncs);
    if (selectedPlotRecallFloorSyncs && plotRecallFloorSyncs !== chatMemorySettings.plotRecallFloorSyncs) {
      memoryPatch.plot_recall_floor_syncs = plotRecallFloorSyncs;
    }
    if (selectedInjectBridgePrompt !== chatMemorySettings.injectBridgePrompt) memoryPatch.inject_bridge_prompt = selectedInjectBridgePrompt;
    if (selectedInjectPlotPrompt !== chatMemorySettings.injectPlotPrompt) memoryPatch.inject_plot_prompt = selectedInjectPlotPrompt;
    if (selectedInjectAutoRecallPrompt !== chatMemorySettings.injectAutoRecallPrompt) {
      memoryPatch.inject_auto_recall_prompt = selectedInjectAutoRecallPrompt;
    }
    if (selectedInjectRecentHistoryPrompt !== chatMemorySettings.injectRecentHistoryPrompt) {
      memoryPatch.inject_recent_history_prompt = selectedInjectRecentHistoryPrompt;
    }
    if (selectedAutoRecallChunkPrompt !== chatMemorySettings.autoRecallChunkPrompt) {
      memoryPatch.auto_recall_chunk_prompt = selectedAutoRecallChunkPrompt;
    }
    // Lead-in window: 0 is meaningful (disables lead-ins), so an empty field means "leave
    // unset" while a typed 0 must patch — unlike the positive-only knobs above.
    const autoRecallLeadInChunks = Number(selectedAutoRecallLeadInChunks);
    if (selectedAutoRecallLeadInChunks !== '' && autoRecallLeadInChunks !== chatMemorySettings.autoRecallLeadInChunks) {
      memoryPatch.auto_recall_lead_in_chunks = autoRecallLeadInChunks;
    }
    if (selectedAutoRecallLeadInPrompt !== chatMemorySettings.autoRecallLeadInPrompt) {
      memoryPatch.auto_recall_lead_in_prompt = selectedAutoRecallLeadInPrompt;
    }
    if (selectedInjectSyncSummariesPrompt !== chatMemorySettings.injectSyncSummariesPrompt) {
      memoryPatch.inject_sync_summaries_prompt = selectedInjectSyncSummariesPrompt;
    }
    if (selectedSyncSummaryEntryPrompt !== chatMemorySettings.syncSummaryEntryPrompt) {
      memoryPatch.sync_summary_entry_prompt = selectedSyncSummaryEntryPrompt;
    }
    const canonPatch: Parameters<typeof adminSetCanonSettings>[0] = {};
    const canonRecallTopK = Number(selectedCanonRecallTopK);
    if (selectedCanonRecallTopK && canonRecallTopK !== canonSettings.recallTopK) {
      canonPatch.recall_top_k = canonRecallTopK;
    }
    const canonRecallMin = Number(selectedCanonRecallMin);
    if (selectedCanonRecallMin && canonRecallMin !== canonSettings.recallMin) {
      canonPatch.recall_min = canonRecallMin;
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
        <br />
        <label>
          Chunk size (turn pairs)
          <br />
          <input
            type="number"
            min="1"
            value={selectedChunkPairs}
            onChange={(e) => setSelectedChunkPairs(e.target.value)}
            placeholder="2"
          />
        </label>
        <div className="status">
          Live window: how many of the most recent turn pairs stay in full view. Sync every: how many pairs accumulate past
          that before the next chunk/summarize/distill pass runs. Digest horizon: how far back the key-ideas digest re-reads
          chunk summaries on each sync, not just what's brand new since the last one. Chunk size: how many turn-pairs each
          archived chunk holds (2 = the classic 4-message chunk) — changing it only affects NEW chunks; use
          "Re-chunk existing archives" below to bring existing archives in line.
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
          World memory curator prompt (place / thing / concept) {chatMemorySettings?.worldCuratorPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea
            value={selectedWorldCuratorPrompt}
            onChange={(e) => setSelectedWorldCuratorPrompt(e.target.value)}
            rows={20}
          />
        </label>
        <div className="status">
          Runs every sync tick alongside the RP bridge prompt above, for 'rp'-kind chats only: reviews the transcript
          against every existing approved place/thing/concept entry and proposes updates, new entries, and duplicate
          flags — CNZ's periodic world-memory curator.
        </div>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('worldCuratorPrompt')}>
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
        <button onClick={handleChatMemorySave}>Save</button>
        <button type="button" onClick={triggerChunkResize}>
          Re-chunk existing archives at this size
        </button>
        <div className="status">
          {chatMemoryStatus}
          {chunkResizeStatus?.status === 'running'
            ? `${chatMemoryStatus ? ' ' : ''}Re-chunking&hellip; ${chunkResizeStatus.chatsDone}/${chunkResizeStatus.chatsTotal} chats (started ${new Date(chunkResizeStatus.startedAt ?? '').toLocaleString()})`
            : chunkResizeStatus?.status === 'done'
              ? `Re-chunked ${chunkResizeStatus.chatsTotal} chats${chatMemoryStatus ? ` — ${chatMemoryStatus}` : ''}.`
              : chunkResizeStatus?.status === 'error'
                ? `Re-chunk failed: ${chunkResizeStatus.error ?? 'unknown error'}${chatMemoryStatus ? ` — ${chatMemoryStatus}` : ''}`
                : ''}
        </div>
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
          Chunk Max (full-turn chunks injected)
          <br />
          <input
            type="number"
            min="1"
            max="12"
            value={selectedAutoRecallChunkTopK}
            onChange={(e) => setSelectedAutoRecallChunkTopK(e.target.value)}
            placeholder="8"
          />
        </label>
        <div className="status">
          The Max ceiling for archived full-turn chunks the silent recall injects (AUTO_RECALL_CHUNK_TOP_K, capped at 12) —
          the most the dynamic cutoff will ever keep.
        </div>
        <br />
        <label>
          Chunk Min
          <br />
          <input
            type="number"
            min="1"
            value={selectedAutoRecallMin}
            onChange={(e) => setSelectedAutoRecallMin(e.target.value)}
            placeholder="2"
          />
        </label>
        <div className="status">
          The Min floor: how many chunks are injected at minimum even when the pool distribution says nothing clears the
          threshold (chat_memory_auto_recall_chunk_min). Clamped to the Max at read time.
        </div>
        <br />
        <label>
          Pool Multiple
          <br />
          <input
            type="number"
            min="1"
            step="0.5"
            value={selectedAutoRecallPoolMultiple}
            onChange={(e) => setSelectedAutoRecallPoolMultiple(e.target.value)}
            placeholder="2"
          />
        </label>
        <div className="status">
          The candidate pool the cutoff measures is Pool Multiple × Max (min 6, capped at 40) —
          chat_memory_auto_recall_pool_multiple, Canonize's own ragPoolMultiple.
        </div>
        <br />
        <label>
          Cutoff Mode
          <br />
          <select
            value={selectedAutoRecallCutoffMode}
            onChange={(e) => setSelectedAutoRecallCutoffMode(e.target.value as 'mean' | 'mean+1sd' | 'mean+2sd')}
          >
            <option value="mean">Mean</option>
            <option value="mean+1sd">Mean + 1 SD</option>
            <option value="mean+2sd">Mean + 2 SD</option>
          </select>
        </label>
        <div className="status">
          How strict the threshold is, in raw distance space where lower is better: Mean keeps everything closer than the
          pool's mean distance; the +SD modes demand results stand below mean − 1/2×σ (chat_memory_auto_recall_cutoff_mode).
        </div>
        <br />
        <label>
          Lead-in window (preceding chunks)
          <br />
          <input
            type="number"
            min="0"
            max="3"
            value={selectedAutoRecallLeadInChunks}
            onChange={(e) => setSelectedAutoRecallLeadInChunks(e.target.value)}
            placeholder="2"
          />
        </label>
        <div className="status">
          How many preceding chunks' summaries ride along with each recalled chunk (chat_memory_auto_recall_lead_in_chunks,
          default 2, capped at 3) — "what led up to this" context anchoring a retrieved chunk in its conversation flow.
          0 disables lead-ins entirely.
        </div>
        <br />
        <label>
          Canon facts Max (non-rejected facts injected)
          <br />
          <input
            type="number"
            min="1"
            value={selectedCanonRecallTopK}
            onChange={(e) => setSelectedCanonRecallTopK(e.target.value)}
            placeholder="8"
          />
        </label>
        <br />
        <label>
          Canon facts Min
          <br />
          <input
            type="number"
            min="1"
            value={selectedCanonRecallMin}
            onChange={(e) => setSelectedCanonRecallMin(e.target.value)}
            placeholder="2"
          />
        </label>
        <div className="status">
          How many canon facts the silent recall returns (canon_recall_top_k, read live on every recall call). The
          silent recall injects any non-rejected fact (bi_principles.md §15: a proposed fact is already live); the
          explicit recall_canon_facts tool call keeps its own narrower approved-only filter. Since the RAG dynamic
          cutoff (migrations 0091/0092) this is the fact lane's
          per-channel Max: the recall fetches a candidate pool (Pool Multiple × Max above) and keeps only the facts that
          clear the cutoff's distance threshold, never fewer than Canon facts Min (canon_recall_min) nor more than this
          Max. The extraction pass that proposes new facts is Director Pass work — see docs/canonize-plan.md §2.
        </div>
        <br />
        <label>
          Plot arcs Max (cards injected)
          <br />
          <input
            type="number"
            min="1"
            value={selectedPlotRecallTopK}
            onChange={(e) => setSelectedPlotRecallTopK(e.target.value)}
            placeholder="6"
          />
        </label>
        <div className="status">
          The Max ceiling for ranked plot-arc cards the silent recall injects (chat_memory_plot_recall_top_k, default 6) —
          fewer than the fact lane's 8 because each card is a first-entry + last-three-entries block. Each card traces
          back to specific canon_facts rows (bi_principles.md §16).
        </div>
        <br />
        <label>
          Plot arcs Min
          <br />
          <input
            type="number"
            min="1"
            value={selectedPlotRecallMin}
            onChange={(e) => setSelectedPlotRecallMin(e.target.value)}
            placeholder="1"
          />
        </label>
        <div className="status">
          The Min floor: how many plot-arc cards are injected at minimum even when the pool distribution says nothing
          clears the threshold (chat_memory_plot_recall_min). Clamped to the Max at read time.
        </div>
        <br />
        <label>
          Plot recency floor (syncs)
          <br />
          <input
            type="number"
            min="1"
            value={selectedPlotRecallFloorSyncs}
            onChange={(e) => setSelectedPlotRecallFloorSyncs(e.target.value)}
            placeholder="2"
          />
        </label>
        <div className="status">
          An arc touched in the chat's last N sync ticks (chat_sync_points ordinal recency) stays visible regardless of
          its similarity score (chat_memory_plot_recall_floor_syncs, default 2) — Canonize's "supplemented by
          recency-based filler". The floor counts toward the Max, never on top of it.
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
          Recent-history injection prompt (the active context: live-window turns, last sent turn
          included) {chatMemorySettings?.injectRecentHistoryPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea
            value={selectedInjectRecentHistoryPrompt}
            onChange={(e) => setSelectedInjectRecentHistoryPrompt(e.target.value)}
            rows={5}
          />
        </label>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('injectRecentHistoryPrompt')}>
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
        <label>
          Lead-in chunk template {chatMemorySettings?.autoRecallLeadInPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea
            value={selectedAutoRecallLeadInPrompt}
            onChange={(e) => setSelectedAutoRecallLeadInPrompt(e.target.value)}
            rows={5}
          />
        </label>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('autoRecallLeadInPrompt')}>
          Reset to default
        </button>
        <br />
        <label>
          Sync-summaries injection prompt (the open-sync-point wrapper, e.g. between bridge and
          recent_history) {chatMemorySettings?.injectSyncSummariesPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea
            value={selectedInjectSyncSummariesPrompt}
            onChange={(e) => setSelectedInjectSyncSummariesPrompt(e.target.value)}
            rows={5}
          />
        </label>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('injectSyncSummariesPrompt')}>
          Reset to default
        </button>
        <br />
        <label>
          Sync-summary entry template (one bare chunk summary, e.g. {'[{{text}}]'}){' '}
          {chatMemorySettings?.syncSummaryEntryPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea
            value={selectedSyncSummaryEntryPrompt}
            onChange={(e) => setSelectedSyncSummaryEntryPrompt(e.target.value)}
            rows={5}
          />
        </label>
        <br />
        <button type="button" onClick={() => resetChatMemoryPrompt('syncSummaryEntryPrompt')}>
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

      {chunkResizeModalOpen && (
        <ChunkResizeWarningModal
          onCancel={() => setChunkResizeModalOpen(false)}
          onChangeOnly={async () => {
            setChunkResizeModalOpen(false);
            await saveChatMemorySettings();
          }}
          onChangeAndRechunk={async () => {
            setChunkResizeModalOpen(false);
            await saveChatMemorySettings();
            await triggerChunkResize();
          }}
        />
      )}
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
