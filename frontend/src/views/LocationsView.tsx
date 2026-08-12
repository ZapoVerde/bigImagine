import { useState } from 'react';
import {
  ApiError,
  adminGetLocationsAdmin,
  adminGetLocationSettings,
  adminSetLocationSettings,
} from '../api/client';
import { useAdminUnlock } from '../hooks/useAdminUnlock';
import type { LocationAdminRow, LocationSettings } from '../api/types';
import './LocationsView.css';

// The Locations management page — the location tracker's settings and its known-locations
// browser in one place (docs/plans/vistalyze_integration/location.md, migration 0083). Three sections:
//   1. Tracker settings: the header split toggle (places ↔ rooms via parent_location_id), the
//      marker-slot gate for the known-locations block, and the block's prompt text. The block
//      itself is always available as the "Active Location" marker slot in Prompt Stacks (same
//      tick/untick/reorder/delete as the rag markers) — this toggle just gates its value.
//   2. Room describer (moved here from the Backgrounds page): the describer prompt + turn-pair
//      count that turn a new location name into visual_description/definition.
//   3. Known locations: the read-only browser of every tracked location with its parent place
//      and lifecycle status — proof the tracker is populating (bi_principles.md §11).
//
// The header contract itself (the `[ Time | 🗓️ Date | 📍 Parent - Sub ]` + Present line format
// the scraper parses) is static — see the info box at the bottom.
//
// Admin-key unlock (mount-time Access probe, then a stored key, then the manual key form) is
// hooks/useAdminUnlock.ts, shared with SettingsView/ConnectionsView/RagView — attemptLoad below
// is this view's own "prove the key works" fetch: both settings and the browser, since the page
// is all of them. The browser is re-fetched after unlock and on Refresh, so a browser failure
// never blocks the settings fieldset.
export default function LocationsView() {
  // --- Tracker + describer settings ---
  const [locationSettings, setLocationSettingsState] = useState<LocationSettings | null>(null);
  const [selectedSplitEnabled, setSelectedSplitEnabled] = useState(false);
  const [selectedInjectionEnabled, setSelectedInjectionEnabled] = useState(false);
  const [selectedInjectionPrompt, setSelectedInjectionPrompt] = useState('');
  const [selectedDescriberPrompt, setSelectedDescriberPrompt] = useState('');
  const [selectedDescriberHistoryPairs, setSelectedDescriberHistoryPairs] = useState('');
  const [settingsStatus, setSettingsStatus] = useState('');

  // --- Known-locations browser ---
  const [locationRows, setLocationRows] = useState<LocationAdminRow[] | null>(null);
  const [browserError, setBrowserError] = useState('');

  function applyLocationSettings(settings: LocationSettings) {
    setLocationSettingsState(settings);
    setSelectedSplitEnabled(settings.splitEnabled);
    setSelectedInjectionEnabled(settings.injectionEnabled);
    setSelectedInjectionPrompt(settings.injectionPrompt);
    setSelectedDescriberPrompt(settings.describerPrompt);
    setSelectedDescriberHistoryPairs(settings.describerHistoryPairs);
  }

  async function loadBrowser(key: string | null) {
    try {
      setLocationRows(await adminGetLocationsAdmin(key));
      setBrowserError('');
    } catch (err) {
      setBrowserError(err instanceof ApiError ? err.message : 'failed to load locations');
    }
  }

  // Whatever proves the key works — every admin GET this tab needs on first load. Shared unlock
  // state (adminKey/checking/unlocked/loadError, the mount-time no-key-then-stored-key probe, the
  // manual Load button's handler) lives in useAdminUnlock, not duplicated here.
  async function attemptLoad(key: string | null): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const [settings, locations] = await Promise.all([
        adminGetLocationSettings(key),
        adminGetLocationsAdmin(key),
      ]);
      applyLocationSettings(settings);
      setLocationRows(locations);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  const { adminKey, setAdminKey, checking, unlocked, loadError, load } = useAdminUnlock(attemptLoad);

  // Only the fields that actually changed are sent — an untouched prompt textarea stays exactly
  // what it was (default or a prior override), it isn't silently re-saved as an override.
  async function saveLocationSettings() {
    if (!locationSettings) return;
    const patch: {
      split_enabled?: boolean;
      injection_enabled?: boolean;
      injection_prompt?: string;
      describer_prompt?: string;
      describer_history_pairs?: string;
    } = {};
    if (selectedSplitEnabled !== locationSettings.splitEnabled) patch.split_enabled = selectedSplitEnabled;
    if (selectedInjectionEnabled !== locationSettings.injectionEnabled) patch.injection_enabled = selectedInjectionEnabled;
    if (selectedInjectionPrompt !== locationSettings.injectionPrompt) patch.injection_prompt = selectedInjectionPrompt;
    if (selectedDescriberPrompt !== locationSettings.describerPrompt) patch.describer_prompt = selectedDescriberPrompt;
    if (selectedDescriberHistoryPairs !== locationSettings.describerHistoryPairs) {
      patch.describer_history_pairs = selectedDescriberHistoryPairs;
    }
    if (Object.keys(patch).length === 0) return;
    setSettingsStatus('');
    try {
      const updated = await adminSetLocationSettings(patch, adminKey);
      applyLocationSettings(updated);
      setSettingsStatus('Saved — takes effect on the next turn, no restart needed.');
    } catch (err) {
      setSettingsStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
    }
  }

  if (checking) {
    return <div className="locations-view" />;
  }

  if (!unlocked) {
    return (
      <div className="locations-view">
        <h1>Locations</h1>
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
    <div className="locations-view">
      <h1>Locations</h1>
      <div className="status locations-view-intro">
        How BigImagine tracks where the story happens: the header's{' '}
        <code>{'📍 Parent - Sub'}</code> is split into a place and its rooms, each new room gets
        described and rendered as a background, and the known-locations list is offered back to
        the narrator every turn so it reuses exact names (the location-tracker plan,
        docs/plans/vistalyze_integration/location.md). This page is every knob for that pipeline.
      </div>

      <fieldset>
        <legend>Tracker</legend>
        <label>
          <input
            type="checkbox"
            checked={selectedSplitEnabled}
            onChange={(e) => setSelectedSplitEnabled(e.target.checked)}
          />{' '}
          Split header locations into places and rooms
        </label>
        <div className="status">
          When on, a header location like <code>The Tavern - Kitchen</code> becomes a room row
          whose parent is the place row <code>The Tavern</code> (locations.parent_location_id,
          migration 0083). Legacy rows already in the table are backfilled once. Off restores
          today's flat behavior — the header string stays the single source of truth either way.
        </div>
        <label>
          <input
            type="checkbox"
            checked={selectedInjectionEnabled}
            onChange={(e) => setSelectedInjectionEnabled(e.target.checked)}
          />{' '}
          Inject the known-locations list into the narrator prompt
        </label>
        <div className="status">
          The tracker's output is the <code>{'<locations>'}</code> block — the known locations
          (every place, plus the current place's rooms) plus the rules for reusing them. It
          always lives in the Prompt Stacks editor as the{' '}
          <em>Active Location</em> marker slot — tick it, untick it, move it, or delete it like
          any rag marker. This toggle is the global gate on the block's value (off = the marker
          slot renders empty, so the stack keeps its shape).
        </div>
        <label>
          Known-locations block prompt {locationSettings?.injectionPromptIsDefault && <em>(default)</em>}
          <br />
          <textarea
            value={selectedInjectionPrompt}
            onChange={(e) => setSelectedInjectionPrompt(e.target.value)}
            rows={10}
            placeholder="The built-in default: the known-locations list + the match-exactly rules…"
          />
        </label>
        <div className="status">
          The rules text that accompanies the location list. The list itself is always generated
          from the table (current place's rooms first, then every other place); empty means the
          built-in default (bi_principles.md §18) — clearing the field is how you ask for the
          default back.
        </div>
        <br />
        <button
          onClick={saveLocationSettings}
          disabled={
            !locationSettings ||
            (selectedSplitEnabled === locationSettings.splitEnabled &&
              selectedInjectionEnabled === locationSettings.injectionEnabled &&
              selectedInjectionPrompt === locationSettings.injectionPrompt &&
              selectedDescriberPrompt === locationSettings.describerPrompt &&
              selectedDescriberHistoryPairs === locationSettings.describerHistoryPairs)
          }
        >
          Save
        </button>
        <div className="status">{settingsStatus}</div>
      </fieldset>

      <fieldset>
        <legend>Room describer</legend>
        <label>
          Room-describer prompt {locationSettings?.describerPromptIsDefault && <em>(default)</em>}
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
          Backgrounds page's image template); <code>Definition:</code> fills the location's
          definition. Empty means the built-in default. Moved here from the Backgrounds page —
          this is the tracker's home now.
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
      </fieldset>

      <fieldset>
        <legend>Known locations</legend>
        <button className="loc-refresh" onClick={() => loadBrowser(adminKey)}>
          Refresh
        </button>
        <div className="status">
          One row per tracked location: a place (parent) or a room beneath it, with its lifecycle
          status. Rows appear as the scraper parses header locations; a room's parent is the
          place derived from its name. Rooms outlive their swipe (transient → inactive on
          regenerate), so a stale row here is expected — the table is proof the tracker ran.
        </div>
        <LocationsTable rows={locationRows} error={browserError} />
      </fieldset>

      <div className="status locations-contract">
        <strong>Header contract.</strong> The scraper parses the first line of the reply:{' '}
        <code>{'[ TimeOfDay | 🗓️ DayOfWeek, Month DD, YYYY Era | 📍 Place - Room ]'}</code> followed
        by a <code>Present:</code> line listing named characters (excluding you). A room's name is
        the full <code>Place - Room</code> string; the place is the part before the first{' '}
        <code> - </code>. The known-locations block asks the narrator to keep using exact strings
        in this format.
      </div>
    </div>
  );
}

function LocationsTable({ rows, error }: { rows: LocationAdminRow[] | null; error: string }) {
  if (error) {
    return <div className="status loc-error">{error}</div>;
  }
  if (rows === null) {
    return <div className="status">Loading locations&hellip;</div>;
  }
  if (rows.length === 0) {
    return <div className="status">No locations tracked yet — the next header location the scraper parses will appear here.</div>;
  }
  const places = rows.filter((r) => !r.parentName).length;
  return (
    <>
      <div className="status">{`${rows.length} locations — ${places} places, ${rows.length - places} rooms`}</div>
      <table className="loc-status-table">
        <thead>
          <tr>
            <th>Location</th>
            <th>Status</th>
            <th>Chat(s)</th>
            <th>Image</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.locationId}>
              <td className={r.parentName ? 'loc-room-row' : ''}>{r.parentName ? `↳ ${r.name}` : r.name}</td>
              <td>
                <span className="loc-badge-status">{r.status}</span>
              </td>
              <td>
                {r.status === null ? (
                  <span className="badge-no">library</span>
                ) : r.chatTitles.length > 0 ? (
                  r.chatTitles.join(', ')
                ) : (
                  <span className="badge-no">none</span>
                )}
              </td>
              <td>
                {r.imageUrl ? (
                  <img className="loc-thumb" src={r.imageUrl} alt="" loading="lazy" />
                ) : (
                  <span className="badge-no">none</span>
                )}
              </td>
              <td>{new Date(r.updatedAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
