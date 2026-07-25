import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  adminGetActiveProfile,
  adminGetCalendarSettings,
  adminGetNotionSettings,
  adminGetTimezone,
  adminListCredentials,
  adminListModelsForProfile,
  adminSetActiveProfile,
  adminSetCalendarSettings,
  adminSetCredential,
  adminSetNotionSettings,
  adminSetTimezone,
} from '../api/client';
import { formatPricePerMillion } from '../api/pricing';
import type { CalendarSettings, CredentialSummary, NotionSettings, ProfileModelsResult } from '../api/types';
import './SettingsView.css';

type ModelOption = ProfileModelsResult['models'][number];

// Intl.supportedValuesOf is a modern-browser API (well-supported by anything used with Cloudflare
// Access SSO) — a real dropdown of every IANA zone name beats a freeform text input that's easy
// to typo. Falls back to just the current value if the browser doesn't have it, rather than
// crashing the whole Settings tab over one missing API.
function listTimezoneOptions(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

// The browser always knows its own zone — surfacing it directly answers "which one am I on"
// without the user having to guess from a list of IANA names.
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
}

// GMT+X / GMT-X:XX next to each zone name, since most people know their offset from UTC long
// before they know their IANA zone name.
function formatUtcOffset(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(
      new Date(),
    );
    const offset = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    return offset.replace('GMT', 'UTC');
  } catch {
    return '';
  }
}

// Ported from the old standalone adminPage.ts — same two endpoints, same behavior (restart-on-
// save, poll /healthz until the orchestrator comes back). The admin key is deliberately kept in
// component state only, never localStorage: unlike the household API key gating the rest of this
// app, this one key can rotate every other credential in the system.
//
// Under Cloudflare Access, httpServer.ts's isAdminAuthorized trusts the Access identity directly
// (see client.ts's adminListCredentials/adminGetActiveProfile) — a second manually-typed secret
// on top of Access would be redundant friction, not real defense in depth, for a household app.
// So on mount this probes both admin endpoints with no key at all; if Access already covers it,
// Settings unlocks immediately and the key form never appears. Only a deployment with no Access
// configured (or a non-browser caller) ever needs to type the static admin key below.
export default function SettingsView() {
  const [adminKey, setAdminKey] = useState('');
  const [checking, setChecking] = useState(true);
  const [unlocked, setUnlocked] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [selectedName, setSelectedName] = useState('');
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('');
  const pollRef = useRef<number | null>(null);

  const [profileNames, setProfileNames] = useState<string[]>([]);
  const [activeProfile, setActiveProfile] = useState('');
  const [activeModel, setActiveModel] = useState('');
  const [selectedProfile, setSelectedProfile] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('');
  const connectionPollRef = useRef<number | null>(null);

  const [timezone, setTimezone] = useState('');
  const [selectedTimezone, setSelectedTimezone] = useState('');
  const [timezoneStatus, setTimezoneStatus] = useState('');
  const timezoneOptions = listTimezoneOptions();
  const deviceTimezone = browserTimezone();

  const [calendarOwnerUserId, setCalendarOwnerUserId] = useState('');
  const [selectedCalendarOwnerUserId, setSelectedCalendarOwnerUserId] = useState('');
  const [maskWorkCalendar, setMaskWorkCalendar] = useState(false);
  const [selectedMaskWorkCalendar, setSelectedMaskWorkCalendar] = useState(false);
  const [calendarStatus, setCalendarStatus] = useState('');
  const calendarPollRef = useRef<number | null>(null);

  const [notionOwnerUserId, setNotionOwnerUserId] = useState('');
  const [selectedNotionOwnerUserId, setSelectedNotionOwnerUserId] = useState('');
  const [notionDataSourceId, setNotionDataSourceId] = useState('');
  const [selectedNotionDataSourceId, setSelectedNotionDataSourceId] = useState('');
  const [notionStatus, setNotionStatus] = useState('');
  const notionPollRef = useRef<number | null>(null);

  function applyCalendarSettings(settings: CalendarSettings) {
    setCalendarOwnerUserId(settings.ownerUserId ?? '');
    setSelectedCalendarOwnerUserId(settings.ownerUserId ?? '');
    setMaskWorkCalendar(settings.maskWorkCalendar);
    setSelectedMaskWorkCalendar(settings.maskWorkCalendar);
  }

  function applyNotionSettings(settings: NotionSettings) {
    setNotionOwnerUserId(settings.ownerUserId ?? '');
    setSelectedNotionOwnerUserId(settings.ownerUserId ?? '');
    setNotionDataSourceId(settings.listsDataSourceId ?? '');
    setSelectedNotionDataSourceId(settings.listsDataSourceId ?? '');
  }

  useEffect(() => {
    (async () => {
      try {
        const [creds, connection, tz, calendarSettings, notionSettings] = await Promise.all([
          adminListCredentials(null),
          adminGetActiveProfile(null),
          adminGetTimezone(null),
          adminGetCalendarSettings(null),
          adminGetNotionSettings(null),
        ]);
        setCredentials(creds);
        setSelectedName(creds[0]?.name ?? '');
        setProfileNames(connection.profileNames);
        setActiveProfile(connection.activeProfile);
        setActiveModel(connection.activeModel);
        setSelectedProfile(connection.activeProfile);
        setSelectedModel(connection.activeModel);
        setTimezone(tz);
        setSelectedTimezone(tz);
        applyCalendarSettings(calendarSettings);
        applyNotionSettings(notionSettings);
        setUnlocked(true);
      } catch {
        // Not covered by Access (or Access isn't configured here) — fall back to the key form.
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  async function load() {
    setLoadError(null);
    try {
      const [creds, connection, tz, calendarSettings, notionSettings] = await Promise.all([
        adminListCredentials(adminKey),
        adminGetActiveProfile(adminKey),
        adminGetTimezone(adminKey),
        adminGetCalendarSettings(adminKey),
        adminGetNotionSettings(adminKey),
      ]);
      setCredentials(creds);
      setSelectedName(creds[0]?.name ?? '');
      setProfileNames(connection.profileNames);
      setActiveProfile(connection.activeProfile);
      setActiveModel(connection.activeModel);
      setSelectedProfile(connection.activeProfile);
      setSelectedModel(connection.activeModel);
      setTimezone(tz);
      setSelectedTimezone(tz);
      applyCalendarSettings(calendarSettings);
      applyNotionSettings(notionSettings);
      setUnlocked(true);
    } catch (err) {
      setLoadError(err instanceof ApiError && err.status === 401 ? 'invalid admin key' : 'error loading credentials');
    }
  }

  async function saveTimezone() {
    if (!selectedTimezone || selectedTimezone === timezone) return;
    setTimezoneStatus('');
    try {
      await adminSetTimezone(selectedTimezone, adminKey);
    } catch (err) {
      setTimezoneStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
      return;
    }
    setTimezone(selectedTimezone);
    setTimezoneStatus('Saved — takes effect on the next message, no restart needed.');
  }

  // Refetches the model catalog whenever a different connection is picked, so the model dropdown
  // always reflects the currently *selected* profile, not whichever one is live right now.
  useEffect(() => {
    if (!unlocked || !selectedProfile) return;
    let cancelled = false;
    setModelsError('');
    setModelsLoading(true);
    adminListModelsForProfile(selectedProfile, adminKey)
      .then((result) => {
        if (cancelled) return;
        setAvailableModels(result.models);
        setSelectedModel(selectedProfile === activeProfile ? activeModel : result.defaultModel);
      })
      .catch((err) => {
        if (cancelled) return;
        setModelsError(err instanceof ApiError ? err.message : 'failed to list models for this connection');
        setAvailableModels([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProfile, unlocked]);

  async function saveConnection() {
    if (!selectedModel || (selectedProfile === activeProfile && selectedModel === activeModel)) return;
    setConnectionStatus('');
    try {
      await adminSetActiveProfile(selectedProfile, selectedModel, adminKey);
    } catch (err) {
      setConnectionStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
      return;
    }
    setConnectionStatus('Saved. The orchestrator is restarting — this will take a few seconds.');

    connectionPollRef.current = window.setInterval(async () => {
      try {
        const res = await fetch('/healthz');
        if (res.ok) {
          if (connectionPollRef.current) clearInterval(connectionPollRef.current);
          setActiveProfile(selectedProfile);
          setActiveModel(selectedModel);
          setConnectionStatus('Back up — reload to confirm.');
        }
      } catch {
        // still restarting, keep polling
      }
    }, 2000);
  }

  // Boot-time settings (docs/bb_principles.md §13) — restart-on-save, same shape as saveConnection
  // above, since each is only read once when the thing it configures is constructed.
  async function saveCalendarSettings() {
    if (
      !selectedCalendarOwnerUserId ||
      (selectedCalendarOwnerUserId === calendarOwnerUserId && selectedMaskWorkCalendar === maskWorkCalendar)
    ) {
      return;
    }
    setCalendarStatus('');
    try {
      await adminSetCalendarSettings(
        { owner_user_id: selectedCalendarOwnerUserId, mask_work_calendar: selectedMaskWorkCalendar },
        adminKey,
      );
    } catch (err) {
      setCalendarStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
      return;
    }
    setCalendarStatus('Saved. The orchestrator is restarting — this will take a few seconds.');

    calendarPollRef.current = window.setInterval(async () => {
      try {
        const res = await fetch('/healthz');
        if (res.ok) {
          if (calendarPollRef.current) clearInterval(calendarPollRef.current);
          setCalendarOwnerUserId(selectedCalendarOwnerUserId);
          setMaskWorkCalendar(selectedMaskWorkCalendar);
          setCalendarStatus('Back up — reload to confirm.');
        }
      } catch {
        // still restarting, keep polling
      }
    }, 2000);
  }

  async function saveNotionSettings() {
    if (
      !selectedNotionOwnerUserId ||
      !selectedNotionDataSourceId ||
      (selectedNotionOwnerUserId === notionOwnerUserId && selectedNotionDataSourceId === notionDataSourceId)
    ) {
      return;
    }
    setNotionStatus('');
    try {
      await adminSetNotionSettings(
        { owner_user_id: selectedNotionOwnerUserId, lists_data_source_id: selectedNotionDataSourceId },
        adminKey,
      );
    } catch (err) {
      setNotionStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
      return;
    }
    setNotionStatus('Saved. The orchestrator is restarting — this will take a few seconds.');

    notionPollRef.current = window.setInterval(async () => {
      try {
        const res = await fetch('/healthz');
        if (res.ok) {
          if (notionPollRef.current) clearInterval(notionPollRef.current);
          setNotionOwnerUserId(selectedNotionOwnerUserId);
          setNotionDataSourceId(selectedNotionDataSourceId);
          setNotionStatus('Back up — reload to confirm.');
        }
      } catch {
        // still restarting, keep polling
      }
    }, 2000);
  }

  async function save() {
    if (!value) {
      setStatus('enter a value first');
      return;
    }
    setStatus('');
    try {
      await adminSetCredential(selectedName, value, adminKey);
    } catch (err) {
      setStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
      return;
    }
    setValue('');
    setStatus('Saved. The orchestrator is restarting — this will take a few seconds.');

    pollRef.current = window.setInterval(async () => {
      try {
        const res = await fetch('/healthz');
        if (res.ok) {
          if (pollRef.current) clearInterval(pollRef.current);
          setStatus('Back up — reload to confirm.');
        }
      } catch {
        // still restarting, keep polling
      }
    }, 2000);
  }

  if (checking) {
    return <div className="settings-view" />;
  }

  if (!unlocked) {
    return (
      <div className="settings-view">
        <h1>bigBrain — provider credentials</h1>
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
    <div className="settings-view">
      <h1>bigBrain — provider credentials</h1>

      <fieldset>
        <legend>Connection</legend>
        <select value={selectedProfile} onChange={(e) => setSelectedProfile(e.target.value)}>
          {profileNames.map((name) => (
            <option key={name} value={name}>
              {name}
              {name === activeProfile ? ' (active)' : ''}
            </option>
          ))}
        </select>
        <br />
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          disabled={modelsLoading || availableModels.length === 0}
        >
          {/* The currently selected model might not be in this connection's live catalog (a
              stale override, or the fetch simply hasn't resolved yet) — always include it so the
              <select> never silently shows blank for a real value. */}
          {[selectedModel, ...availableModels.map((m) => m.id)]
            .filter(Boolean)
            .filter((id, i, ids) => ids.indexOf(id) === i)
            .map((id) => {
              const model = availableModels.find((m) => m.id === id);
              return (
                <option key={id} value={id}>
                  {id}
                  {model?.pricing
                    ? ` — ${formatPricePerMillion(model.pricing.prompt)} in / ${formatPricePerMillion(model.pricing.completion)} out per 1M tok`
                    : ''}
                  {id === activeModel && selectedProfile === activeProfile ? ' (active)' : ''}
                </option>
              );
            })}
        </select>
        <br />
        <button
          onClick={saveConnection}
          disabled={
            modelsLoading || !selectedModel || (selectedProfile === activeProfile && selectedModel === activeModel)
          }
        >
          Switch &amp; Restart
        </button>
        {modelsLoading && <div className="status">Loading models…</div>}
        {modelsError && <div className="error-banner">{modelsError}</div>}
        <div className="status">{connectionStatus}</div>
      </fieldset>

      <fieldset>
        <legend>Timezone</legend>
        {deviceTimezone && (
          <div className="status">
            Your device is currently on <strong>{deviceTimezone}</strong> ({formatUtcOffset(deviceTimezone)})
          </div>
        )}
        {timezoneOptions.length > 0 ? (
          <select value={selectedTimezone} onChange={(e) => setSelectedTimezone(e.target.value)}>
            {[...new Set([selectedTimezone, ...timezoneOptions])].filter(Boolean).map((tz) => (
              <option key={tz} value={tz}>
                {tz} ({formatUtcOffset(tz)})
                {tz === timezone ? ' (current)' : ''}
                {tz === deviceTimezone ? ' (your device)' : ''}
              </option>
            ))}
          </select>
        ) : (
          <input value={selectedTimezone} onChange={(e) => setSelectedTimezone(e.target.value)} placeholder="e.g. America/New_York" />
        )}
        <br />
        <button onClick={saveTimezone} disabled={!selectedTimezone || selectedTimezone === timezone}>
          Save
        </button>
        <div className="status">{timezoneStatus}</div>
      </fieldset>

      <fieldset>
        <legend>Calendar</legend>
        <label>
          Owning user id
          <br />
          <input
            value={selectedCalendarOwnerUserId}
            onChange={(e) => setSelectedCalendarOwnerUserId(e.target.value)}
            placeholder="the bigBrain user Cozi/Outlook feed rows are attributed to"
          />
        </label>
        <br />
        <label>
          <input
            type="checkbox"
            checked={selectedMaskWorkCalendar}
            onChange={(e) => setSelectedMaskWorkCalendar(e.target.checked)}
          />
          Mask Outlook event titles/descriptions/locations
        </label>
        <br />
        <button
          onClick={saveCalendarSettings}
          disabled={
            !selectedCalendarOwnerUserId ||
            (selectedCalendarOwnerUserId === calendarOwnerUserId && selectedMaskWorkCalendar === maskWorkCalendar)
          }
        >
          Save &amp; Restart
        </button>
        <div className="status">{calendarStatus}</div>
      </fieldset>

      <fieldset>
        <legend>Notion Sync</legend>
        <label>
          Owning user id
          <br />
          <input
            value={selectedNotionOwnerUserId}
            onChange={(e) => setSelectedNotionOwnerUserId(e.target.value)}
            placeholder="the bigBrain user items typed directly into Notion get attributed to"
          />
        </label>
        <br />
        <label>
          Lists data source id
          <br />
          <input
            value={selectedNotionDataSourceId}
            onChange={(e) => setSelectedNotionDataSourceId(e.target.value)}
            placeholder="the 'bigBrain Lists' database's data_source_id"
          />
        </label>
        <br />
        <button
          onClick={saveNotionSettings}
          disabled={
            !selectedNotionOwnerUserId ||
            !selectedNotionDataSourceId ||
            (selectedNotionOwnerUserId === notionOwnerUserId && selectedNotionDataSourceId === notionDataSourceId)
          }
        >
          Save &amp; Restart
        </button>
        <div className="status">{notionStatus}</div>
      </fieldset>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Configured</th>
            <th>Last updated</th>
          </tr>
        </thead>
        <tbody>
          {credentials.map((cred) => (
            <tr key={cred.name}>
              <td>{cred.name}</td>
              <td className={cred.configured ? 'badge-yes' : 'badge-no'}>
                {cred.configured ? 'configured' : 'not set'}
              </td>
              <td>{cred.updatedAt ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <fieldset>
        <legend>Set / rotate a credential</legend>
        <select value={selectedName} onChange={(e) => setSelectedName(e.target.value)}>
          {credentials.map((cred) => (
            <option key={cred.name} value={cred.name}>
              {cred.name}
            </option>
          ))}
        </select>
        <br />
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="new value" />
        <br />
        <button onClick={save}>Save &amp; Restart</button>
      </fieldset>

      <div className="status">{status}</div>
    </div>
  );
}
