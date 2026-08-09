import { useEffect, useState } from 'react';
import {
  ApiError,
  adminGetChatBackgroundSettings,
  adminGetImageSettings,
  adminGetLocationRenderStatus,
  adminSetChatBackgroundSettings,
  adminSetImageSettings,
} from '../api/client';
import { useAdminUnlock } from '../hooks/useAdminUnlock';
import type { ChatBackgroundSettings, ImageSettings, LocationRenderStatusRow } from '../api/types';
import './BackgroundsView.css';

// The Backgrounds management page — every bg-gen knob in one place, the way RagView pulled the
// chat-memory pipeline out of SettingsView. Three sections:
//   1. Image Generation (moved from SettingsView): the Master Image Prompt Template
//      synthesizeImagePrompt.ts expands per render (endpoint.md §4.2), the room-describer prompt
//      describeLocation.ts expands (describer.md, migration 0078), and how many trailing
//      turn-pairs the describer reads as context. The active image backend itself is managed in
//      the Connections tab (io/imageConnections.ts) — this page tunes what gets sent to it.
//   2. Chat Background (moved from SettingsView): how the rendered location background is
//      displayed in ChatView — the parallax pan toggle, the dimming veil, and the bubble fill
//      (parallax_fade_teststep.md §2.2, migration 0073).
//   3. Render status: the proof-it-ran read (bi_principles.md §11) — which stages each recent
//      location actually completed (described → defined → rendered → render hash), the same
//      admin GET the pipeline's own logs back, in table form like RagView's sync-status table.
//
// Admin-key unlock (mount-time Access probe, then a stored key, then the manual key form) is
// hooks/useAdminUnlock.ts, shared with SettingsView/ConnectionsView/RagView — attemptLoad below
// is this view's own "prove the key works" fetch: both settings GETs, since the whole page is
// those two fieldsets. The render-status read is fetched after unlock (useEffect) and again on
// Refresh, so a status failure never blocks the settings from loading.
//
// No apiKey prop: every call here is admin-gated (useAdminUnlock), same as ConnectionsView and
// RagView.
export default function BackgroundsView() {
  // --- Image Generation settings (endpoint.md §2.2, bi_principles.md §18) ---
  const [imageSettings, setImageSettingsState] = useState<ImageSettings | null>(null);
  const [selectedImageTemplate, setSelectedImageTemplate] = useState('');
  const [selectedDescriberPrompt, setSelectedDescriberPrompt] = useState('');
  const [selectedDescriberHistoryPairs, setSelectedDescriberHistoryPairs] = useState('');
  const [imageStatus, setImageStatus] = useState('');

  // --- Chat Background settings (parallax_fade_teststep.md §2.2 + migration 0073) ---
  const [chatBackgroundParallax, setChatBackgroundParallax] = useState(false);
  const [selectedParallax, setSelectedParallax] = useState(false);
  const [chatBackgroundOverlayOpacity, setChatBackgroundOverlayOpacity] = useState(0.5);
  const [selectedOverlayOpacity, setSelectedOverlayOpacity] = useState(0.5);
  const [chatBackgroundOverlayShade, setChatBackgroundOverlayShade] = useState('#000000');
  const [selectedOverlayShade, setSelectedOverlayShade] = useState('#000000');
  const [chatBackgroundBubbleOpacity, setChatBackgroundBubbleOpacity] = useState(0.7);
  const [selectedBubbleOpacity, setSelectedBubbleOpacity] = useState(0.7);
  const [chatBackgroundBubbleUserShade, setChatBackgroundBubbleUserShade] = useState('#4f46e5');
  const [selectedBubbleUserShade, setSelectedBubbleUserShade] = useState('#4f46e5');
  const [chatBackgroundBubbleAssistantShade, setChatBackgroundBubbleAssistantShade] = useState('#26272c');
  const [selectedBubbleAssistantShade, setSelectedBubbleAssistantShade] = useState('#26272c');
  const [chatBackgroundStatus, setChatBackgroundStatus] = useState('');

  // --- Render status (proof the pipeline ran, bi_principles.md §11) ---
  const [renderRows, setRenderRows] = useState<LocationRenderStatusRow[] | null>(null);
  const [renderError, setRenderError] = useState('');

  function applyImageSettings(settings: ImageSettings) {
    setImageSettingsState(settings);
    setSelectedImageTemplate(settings.template);
    setSelectedDescriberPrompt(settings.describerPrompt);
    setSelectedDescriberHistoryPairs(settings.describerHistoryPairs);
  }

  function applyChatBackgroundSettings(settings: ChatBackgroundSettings) {
    setChatBackgroundParallax(settings.parallaxEnabled);
    setSelectedParallax(settings.parallaxEnabled);
    setChatBackgroundOverlayOpacity(settings.overlayOpacity);
    setSelectedOverlayOpacity(settings.overlayOpacity);
    setChatBackgroundOverlayShade(settings.overlayShade);
    setSelectedOverlayShade(settings.overlayShade);
    setChatBackgroundBubbleOpacity(settings.bubbleOpacity);
    setSelectedBubbleOpacity(settings.bubbleOpacity);
    setChatBackgroundBubbleUserShade(settings.bubbleUserShade);
    setSelectedBubbleUserShade(settings.bubbleUserShade);
    setChatBackgroundBubbleAssistantShade(settings.bubbleAssistantShade);
    setSelectedBubbleAssistantShade(settings.bubbleAssistantShade);
  }

  async function loadRenderStatus(key: string | null) {
    try {
      setRenderRows(await adminGetLocationRenderStatus(key));
      setRenderError('');
    } catch (err) {
      setRenderError(err instanceof ApiError ? err.message : 'failed to load render status');
    }
  }

  // Whatever proves the key works — every admin GET this tab needs on first load. Shared unlock
  // state (adminKey/checking/unlocked/loadError, the mount-time no-key-then-stored-key probe, the
  // manual Load button's handler) lives in useAdminUnlock, not duplicated here.
  async function attemptLoad(key: string | null): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const [imageSettingsResult, chatBackgroundSettingsResult] = await Promise.all([
        adminGetImageSettings(key),
        adminGetChatBackgroundSettings(key),
      ]);
      applyImageSettings(imageSettingsResult);
      applyChatBackgroundSettings(chatBackgroundSettingsResult);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  const { adminKey, setAdminKey, checking, unlocked, loadError, load } = useAdminUnlock(attemptLoad);

  // The render-status table's own fetch, after unlock — a status failure must never block the
  // settings fieldsets above it (Refresh re-runs the same read).
  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    adminGetLocationRenderStatus(adminKey)
      .then((rows) => {
        if (!cancelled) {
          setRenderRows(rows);
          setRenderError('');
        }
      })
      .catch((err) => {
        if (!cancelled) setRenderError(err instanceof ApiError ? err.message : 'failed to load render status');
      });
    return () => {
      cancelled = true;
    };
  }, [unlocked, adminKey]);

  // Only the fields that actually changed are sent — an untouched prompt textarea stays exactly
  // what it was (default or a prior override), it isn't silently re-saved as an override.
  async function saveImageSettings() {
    if (!imageSettings) return;
    const patch: { template?: string; describer_prompt?: string; describer_history_pairs?: string } = {};
    if (selectedImageTemplate !== imageSettings.template) patch.template = selectedImageTemplate;
    if (selectedDescriberPrompt !== imageSettings.describerPrompt) patch.describer_prompt = selectedDescriberPrompt;
    if (selectedDescriberHistoryPairs !== imageSettings.describerHistoryPairs) {
      patch.describer_history_pairs = selectedDescriberHistoryPairs;
    }
    if (Object.keys(patch).length === 0) return;
    setImageStatus('');
    try {
      const updated = await adminSetImageSettings(patch, adminKey);
      applyImageSettings(updated);
      setImageStatus('Saved — applies to the next location render, no restart needed.');
    } catch (err) {
      setImageStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
    }
  }

  async function saveChatBackgroundSettings() {
    const value: ChatBackgroundSettings = {
      parallaxEnabled: selectedParallax,
      overlayOpacity: selectedOverlayOpacity,
      overlayShade: selectedOverlayShade,
      bubbleOpacity: selectedBubbleOpacity,
      bubbleUserShade: selectedBubbleUserShade,
      bubbleAssistantShade: selectedBubbleAssistantShade,
    };
    if (
      value.parallaxEnabled === chatBackgroundParallax &&
      value.overlayOpacity === chatBackgroundOverlayOpacity &&
      value.overlayShade === chatBackgroundOverlayShade &&
      value.bubbleOpacity === chatBackgroundBubbleOpacity &&
      value.bubbleUserShade === chatBackgroundBubbleUserShade &&
      value.bubbleAssistantShade === chatBackgroundBubbleAssistantShade
    ) {
      return;
    }
    setChatBackgroundStatus('');
    try {
      const updated = await adminSetChatBackgroundSettings(value, adminKey);
      applyChatBackgroundSettings(updated);
      setChatBackgroundStatus('Saved — takes effect on the next chat view load, no restart needed.');
    } catch (err) {
      setChatBackgroundStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
    }
  }

  if (checking) {
    return <div className="backgrounds-view" />;
  }

  if (!unlocked) {
    return (
      <div className="backgrounds-view">
        <h1>Backgrounds</h1>
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
    <div className="backgrounds-view">
      <h1>Backgrounds</h1>
      <div className="status backgrounds-view-intro">
        Everything about location backgrounds in one place: how the background image is created
        (the image-gen template + the room describer that feeds it) and how it's shown in the chat
        (the parallax pan, the dimming veil, and the bubble fill). The active image backend itself
        is managed on the Connections tab. The render-status table below is proof the pipeline
        actually ran — the same admin read the pipeline's logs back.
      </div>

      <fieldset>
        <legend>Image Generation</legend>
        <label>
          Master image prompt template {imageSettings?.templateIsDefault && <em>(default)</em>}
          <br />
          <textarea
            value={selectedImageTemplate}
            onChange={(e) => setSelectedImageTemplate(e.target.value)}
            rows={8}
            placeholder="e.g. {{style_prefix}} Concept Art for Video Games, {{visual_description}}, {{time_of_day}}, {{weather}}, {{mood}} lighting…"
          />
        </label>
        <div className="status">
          The prompt synthesis template (endpoint.md §4.2): macros expanded per render are{' '}
          <code>{'{{visual_description}}'}</code>, <code>{'{{time_of_day}}'}</code>,{' '}
          <code>{'{{weather}}'}</code>, <code>{'{{mood}}'}</code>, <code>{'{{lighting}}'}</code> and{' '}
          <code>{'{{style_prefix}}'}</code>. Empty means the built-in default (bi_principles.md
          §18) — there is no separate reset action; clearing the field is how you ask for the
          default back.
        </div>
        <br />
        <label>
          Room-describer prompt {imageSettings?.describerPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea
            value={selectedDescriberPrompt}
            onChange={(e) => setSelectedDescriberPrompt(e.target.value)}
            rows={10}
            placeholder="[SYSTEM: TASK — LOCATION VISUAL ARCHIVIST]… (the built-in default)"
          />
        </label>
        <div className="status">
          The describer LLM call that turns a newly-minted location name into a real room
          description (describer.md). Macros expanded per call are{' '}
          <code>{'{{location_name}}'}</code> and <code>{'{{context}}'}</code>. The reply's{' '}
          <code>Visuals:</code> half fills <code>visual_description</code> (which flows into the
          template above); <code>Definition:</code> fills the location's definition. Empty means
          the built-in default.
        </div>
        <label>
          Room-describer context (turn-pairs)
          <br />
          <input
            type="text"
            inputMode="numeric"
            value={selectedDescriberHistoryPairs}
            onChange={(e) => setSelectedDescriberHistoryPairs(e.target.value)}
            placeholder="1"
          />
        </label>
        <div className="status">
          How many trailing turn-pairs the describer reads as narrative context (default 1). Leave
          empty for the default.
        </div>
        <br />
        <button
          onClick={saveImageSettings}
          disabled={
            !imageSettings ||
            (selectedImageTemplate === imageSettings.template &&
              selectedDescriberPrompt === imageSettings.describerPrompt &&
              selectedDescriberHistoryPairs === imageSettings.describerHistoryPairs)
          }
        >
          Save
        </button>
        <div className="status">{imageStatus}</div>
      </fieldset>

      <fieldset>
        <legend>Chat Background</legend>
        <label>
          <input type="checkbox" checked={selectedParallax} onChange={(e) => setSelectedParallax(e.target.checked)} />{' '}
          Parallax pan on the chat location background
        </label>
        <div className="status">
          The location background pans gently opposite the pointer / device tilt
          (parallax_fade_teststep.md §2), matching SillyTavern-Vistalyze's parallax. Off by
          default; takes effect on the next chat view load.
        </div>
        <label>
          Background overlay opacity ({Math.round(selectedOverlayOpacity * 100)}%)
          <br />
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(selectedOverlayOpacity * 100)}
            onChange={(e) => setSelectedOverlayOpacity(Number(e.target.value) / 100)}
          />
        </label>
        <div className="status">
          The dimming veil over the location image — lower it to let the background show more
          clearly between the bubbles (which keep their own opacity below).
        </div>
        <label>
          Background overlay shade
          <br />
          <input type="color" value={selectedOverlayShade} onChange={(e) => setSelectedOverlayShade(e.target.value)} />
        </label>
        <div className="status">The veil's color — black by default; pick a tint to warm or cool the background.</div>
        <label>
          Bubble opacity ({Math.round(selectedBubbleOpacity * 100)}%)
          <br />
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(selectedBubbleOpacity * 100)}
            onChange={(e) => setSelectedBubbleOpacity(Number(e.target.value) / 100)}
          />
        </label>
        <div className="status">
          How much of the background shows through the bubbles' fill (the bubble text stays fully
          opaque).
        </div>
        <label>
          User bubble shade
          <br />
          <input type="color" value={selectedBubbleUserShade} onChange={(e) => setSelectedBubbleUserShade(e.target.value)} />
        </label>
        <label>
          Assistant bubble shade
          <br />
          <input
            type="color"
            value={selectedBubbleAssistantShade}
            onChange={(e) => setSelectedBubbleAssistantShade(e.target.value)}
          />
        </label>
        <br />
        <button
          onClick={saveChatBackgroundSettings}
          disabled={
            selectedParallax === chatBackgroundParallax &&
            selectedOverlayOpacity === chatBackgroundOverlayOpacity &&
            selectedOverlayShade === chatBackgroundOverlayShade &&
            selectedBubbleOpacity === chatBackgroundBubbleOpacity &&
            selectedBubbleUserShade === chatBackgroundBubbleUserShade &&
            selectedBubbleAssistantShade === chatBackgroundBubbleAssistantShade
          }
        >
          Save
        </button>
        <div className="status">{chatBackgroundStatus}</div>
      </fieldset>

      <fieldset>
        <legend>Render status</legend>
        <button className="bg-refresh" onClick={() => loadRenderStatus(adminKey)}>
          Refresh
        </button>
        <div className="status">
          One row per recently-touched location: described = the describer (or name seed) filled
          visual_description, defined = the describer's Definition half landed, rendered = a
          background image exists, hash = the cache-validation key is set. A row stuck short of
          rendered is a generation that hasn't fired or failed — same reading as the pipeline's
          logs.
        </div>
        <RenderStatusTable rows={renderRows} error={renderError} />
      </fieldset>
    </div>
  );
}

function RenderStatusTable({ rows, error }: { rows: LocationRenderStatusRow[] | null; error: string }) {
  if (error) {
    return <div className="status bg-error">{error}</div>;
  }
  if (rows === null) {
    return <div className="status">Loading render status&hellip;</div>;
  }
  if (rows.length === 0) {
    return <div className="status">No locations have been through the bg-gen pipeline yet.</div>;
  }
  const described = rows.filter((r) => r.described).length;
  const rendered = rows.filter((r) => r.rendered).length;
  const lastRender = rows.reduce<string | null>(
    (latest, r) => (r.imageGeneratedAt && (latest === null || r.imageGeneratedAt > latest) ? r.imageGeneratedAt : latest),
    null,
  );
  return (
    <>
      <div className="status">
        {`${rows.length} locations — ${described} described, ${rendered} rendered`}
        {lastRender ? ` — last render ${new Date(lastRender).toLocaleString()}` : ''}
      </div>
      <table className="bg-status-table">
        <thead>
          <tr>
            <th>Location</th>
            <th>Status</th>
            <th>Described</th>
            <th>Defined</th>
            <th>Rendered</th>
            <th>Hash</th>
            <th>Last image</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.locationId}>
              <td>{r.name}</td>
              <td>
                <span className="bg-badge-status">{r.status}</span>
              </td>
              <td>
                <span className={r.described ? 'badge-yes' : 'badge-no'}>{r.described ? 'yes' : 'no'}</span>
              </td>
              <td>
                <span className={r.defined ? 'badge-yes' : 'badge-no'}>{r.defined ? 'yes' : 'no'}</span>
              </td>
              <td>
                <span className={r.rendered ? 'badge-yes' : 'badge-no'}>{r.rendered ? 'yes' : 'no'}</span>
              </td>
              <td>
                <span className={r.hasRenderHash ? 'badge-yes' : 'badge-no'}>{r.hasRenderHash ? 'yes' : 'no'}</span>
              </td>
              <td>{r.imageGeneratedAt ? new Date(r.imageGeneratedAt).toLocaleString() : '—'}</td>
              <td>{new Date(r.updatedAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
