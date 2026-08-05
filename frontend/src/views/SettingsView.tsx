import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  adminGetActiveProfile,
  adminGetChatMemorySettings,
  adminGetNotificationSettings,
  adminGetPersonaSettings,
  adminGetPiaProxyUrl,
  adminGetScreenLockSettings,
  adminGetTimezone,
  adminListCredentials,
  adminListModelsForProfile,
  adminSetActiveProfile,
  adminSetChatMemorySettings,
  adminSetCredential,
  adminSetNotificationSettings,
  adminSetPersonaSettings,
  adminSetPiaProxyUrl,
  adminSetScreenLockSettings,
  adminSetTimezone,
} from '../api/client';
import { formatPricePerMillion } from '../api/pricing';
import { ADMIN_API_KEY_STORAGE_KEY } from '../api/authStorage';
import type {
  ChatMemorySettings,
  CredentialSummary,
  NotificationSettings,
  PersonaSettings,
  ProfileModelsResult,
  ScreenLockSettings,
} from '../api/types';
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
// save, poll /healthz until the orchestrator comes back). Persisted to localStorage
// (ADMIN_API_KEY_STORAGE_KEY) like the household key: this is a single-user deployment, so there's
// no household member whose access this key needs to withhold — re-typing it every page load
// would be pure friction with no real security benefit here.
//
// Under Cloudflare Access, httpServer.ts's isAdminAuthorized trusts the Access identity directly
// (see client.ts's adminListCredentials/adminGetActiveProfile) — a second manually-typed secret
// on top of Access would be redundant friction, not real defense in depth, for a household app.
// So on mount this probes both admin endpoints with no key at all; if Access already covers it,
// Settings unlocks immediately and the key form never appears. Only a deployment with no Access
// configured (or a non-browser caller) ever needs to type the static admin key below.
interface SettingsViewProps {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export default function SettingsView({ theme, onToggleTheme }: SettingsViewProps) {
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY) ?? '');
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
  // Which configured profiles are marked vision-capable (io/llm/profiles.ts's
  // LlmProfile.supportsVision) — not just the active one, since the checkbox below previews
  // whichever profile is currently *selected* in the dropdown, same live-preview shape as the
  // model dropdown next to it.
  const [visionCapableProfiles, setVisionCapableProfiles] = useState<string[]>([]);
  const [selectedSupportsVision, setSelectedSupportsVision] = useState(false);

  const [timezone, setTimezone] = useState('');
  const [selectedTimezone, setSelectedTimezone] = useState('');
  const [timezoneStatus, setTimezoneStatus] = useState('');
  const timezoneOptions = listTimezoneOptions();
  const deviceTimezone = browserTimezone();

  const [ntfyServerUrl, setNtfyServerUrl] = useState('');
  const [selectedNtfyServerUrl, setSelectedNtfyServerUrl] = useState('');
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [selectedNotificationsEnabled, setSelectedNotificationsEnabled] = useState(false);
  const [notificationSettingsStatus, setNotificationSettingsStatus] = useState('');

  // stacks/pia-proxy's internal address — plugins/characters' chub.ai import/search tools read this
  // live, no restart needed, same shape as timezone.
  const [piaProxyUrl, setPiaProxyUrl] = useState('');
  const [selectedPiaProxyUrl, setSelectedPiaProxyUrl] = useState('');
  const [piaProxyUrlStatus, setPiaProxyUrlStatus] = useState('');

  // The household's own name/description (docs/prompt-macros.md's Stage 1) — folded into a chat's
  // prompt stack when a preset enables the 'persona' marker slot, same no-restart shape as timezone.
  const [personaName, setPersonaName] = useState('');
  const [selectedPersonaName, setSelectedPersonaName] = useState('');
  const [personaDescription, setPersonaDescription] = useState('');
  const [selectedPersonaDescription, setSelectedPersonaDescription] = useState('');
  const [personaSettingsStatus, setPersonaSettingsStatus] = useState('');

  // ScreenLockOverlay.tsx's idle-timeout re-lock — screenLockPassword is intentionally read back
  // in full (bi_principles.md §12: it isn't a secret, see adminServer.ts's own note), same as
  // every other field on this tab, unlike a provider credential.
  const [screenLockPassword, setScreenLockPassword] = useState('');
  const [selectedScreenLockPassword, setSelectedScreenLockPassword] = useState('');
  const [screenLockTimeoutMinutes, setScreenLockTimeoutMinutes] = useState(5);
  const [selectedScreenLockTimeoutMinutes, setSelectedScreenLockTimeoutMinutes] = useState('5');
  const [screenLockStatus, setScreenLockStatus] = useState('');

  // docs/chat-memory.md — mirrors SillyTavern-Canonize's own "Connections & Prompts" panel.
  const [chatMemorySettings, setChatMemorySettingsState] = useState<ChatMemorySettings | null>(null);
  const [selectedChatMemoryProfile, setSelectedChatMemoryProfile] = useState('');
  const [selectedLiveWindowPairs, setSelectedLiveWindowPairs] = useState('');
  const [selectedSyncEveryPairs, setSelectedSyncEveryPairs] = useState('');
  const [selectedDigestHorizonPairs, setSelectedDigestHorizonPairs] = useState('');
  const [selectedChunkSummaryPrompt, setSelectedChunkSummaryPrompt] = useState('');
  const [selectedDistillPrompt, setSelectedDistillPrompt] = useState('');
  const [selectedHouseholdMemoryPrompt, setSelectedHouseholdMemoryPrompt] = useState('');
  const [chatMemoryStatus, setChatMemoryStatus] = useState('');

  function applyNotificationSettings(settings: NotificationSettings) {
    setNtfyServerUrl(settings.serverUrl ?? '');
    setSelectedNtfyServerUrl(settings.serverUrl ?? '');
    setNotificationsEnabled(settings.enabled);
    setSelectedNotificationsEnabled(settings.enabled);
  }

  function applyPersonaSettings(settings: PersonaSettings) {
    setPersonaName(settings.name);
    setSelectedPersonaName(settings.name);
    setPersonaDescription(settings.description);
    setSelectedPersonaDescription(settings.description);
  }

  function applyScreenLockSettings(settings: ScreenLockSettings) {
    setScreenLockPassword(settings.password);
    setSelectedScreenLockPassword(settings.password);
    setScreenLockTimeoutMinutes(settings.timeoutMinutes);
    setSelectedScreenLockTimeoutMinutes(String(settings.timeoutMinutes));
  }

  function applyChatMemorySettings(settings: ChatMemorySettings) {
    setChatMemorySettingsState(settings);
    setSelectedChatMemoryProfile(settings.profile ?? '');
    setSelectedLiveWindowPairs(settings.liveWindowPairs === null ? '' : String(settings.liveWindowPairs));
    setSelectedSyncEveryPairs(settings.syncEveryPairs === null ? '' : String(settings.syncEveryPairs));
    setSelectedDigestHorizonPairs(settings.digestHorizonPairs === null ? '' : String(settings.digestHorizonPairs));
    setSelectedChunkSummaryPrompt(settings.chunkSummaryPrompt);
    setSelectedDistillPrompt(settings.distillPrompt);
    setSelectedHouseholdMemoryPrompt(settings.householdMemoryPrompt);
  }

  // Shared by the mount-time probes (no key, then a stored key) and the manual Load button —
  // returns whether it unlocked so each caller can decide what to do next (persist the key,
  // evict a stale stored key, fall through to the key form).
  async function attemptLoad(key: string | null): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const [creds, connection, tz, notificationSettings, piaProxyUrlResult, personaSettings, screenLockSettings, chatMemorySettingsResult] =
        await Promise.all([
          adminListCredentials(key),
          adminGetActiveProfile(key),
          adminGetTimezone(key),
          adminGetNotificationSettings(key),
          adminGetPiaProxyUrl(key),
          adminGetPersonaSettings(key),
          adminGetScreenLockSettings(key),
          adminGetChatMemorySettings(key),
        ]);
      setCredentials(creds);
      setSelectedName(creds[0]?.name ?? '');
      setProfileNames(connection.profileNames);
      setActiveProfile(connection.activeProfile);
      setActiveModel(connection.activeModel);
      setSelectedProfile(connection.activeProfile);
      setSelectedModel(connection.activeModel);
      setVisionCapableProfiles(connection.visionCapableProfiles);
      setSelectedSupportsVision(connection.visionCapableProfiles.includes(connection.activeProfile));
      setTimezone(tz);
      setSelectedTimezone(tz);
      applyNotificationSettings(notificationSettings);
      setPiaProxyUrl(piaProxyUrlResult ?? '');
      setSelectedPiaProxyUrl(piaProxyUrlResult ?? '');
      applyPersonaSettings(personaSettings);
      applyScreenLockSettings(screenLockSettings);
      applyChatMemorySettings(chatMemorySettingsResult);
      setUnlocked(true);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  useEffect(() => {
    (async () => {
      if ((await attemptLoad(null)).ok) {
        setChecking(false);
        return;
      }
      // Not covered by Access (or Access isn't configured here) — try a previously-saved admin
      // key before falling back to the manual key form.
      const stored = localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY);
      if (stored) {
        setAdminKey(stored);
        if ((await attemptLoad(stored)).ok) {
          setChecking(false);
          return;
        }
        localStorage.removeItem(ADMIN_API_KEY_STORAGE_KEY);
      }
      setChecking(false);
    })();
  }, []);

  async function load() {
    setLoadError(null);
    const result = await attemptLoad(adminKey);
    if (result.ok) {
      localStorage.setItem(ADMIN_API_KEY_STORAGE_KEY, adminKey);
      return;
    }
    const err = result.error;
    setLoadError(err instanceof ApiError && err.status === 401 ? 'invalid admin key' : 'error loading credentials');
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

  async function savePiaProxyUrl() {
    if (!selectedPiaProxyUrl || selectedPiaProxyUrl === piaProxyUrl) return;
    setPiaProxyUrlStatus('');
    try {
      await adminSetPiaProxyUrl(selectedPiaProxyUrl, adminKey);
    } catch (err) {
      setPiaProxyUrlStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
      return;
    }
    setPiaProxyUrl(selectedPiaProxyUrl);
    setPiaProxyUrlStatus('Saved — takes effect on the next chub import/search call, no restart needed.');
  }

  async function savePersonaSettings() {
    if (selectedPersonaName === personaName && selectedPersonaDescription === personaDescription) return;
    setPersonaSettingsStatus('');
    try {
      await adminSetPersonaSettings({ name: selectedPersonaName, description: selectedPersonaDescription }, adminKey);
    } catch (err) {
      setPersonaSettingsStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
      return;
    }
    setPersonaName(selectedPersonaName);
    setPersonaDescription(selectedPersonaDescription);
    setPersonaSettingsStatus('Saved — takes effect the next time a preset applies the User Persona marker.');
  }

  async function saveNotificationSettings() {
    if (selectedNtfyServerUrl === ntfyServerUrl && selectedNotificationsEnabled === notificationsEnabled) return;
    setNotificationSettingsStatus('');
    try {
      await adminSetNotificationSettings(
        {
          ...(selectedNtfyServerUrl ? { server_url: selectedNtfyServerUrl } : {}),
          enabled: selectedNotificationsEnabled,
        },
        adminKey,
      );
    } catch (err) {
      setNotificationSettingsStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
      return;
    }
    if (selectedNtfyServerUrl) setNtfyServerUrl(selectedNtfyServerUrl);
    setNotificationsEnabled(selectedNotificationsEnabled);
    setNotificationSettingsStatus('Saved — takes effect on the next send_push_notification call, no restart needed.');
  }

  async function saveScreenLockSettings() {
    const timeoutValue = Number(selectedScreenLockTimeoutMinutes);
    if (!Number.isFinite(timeoutValue) || timeoutValue <= 0) {
      setScreenLockStatus('error: timeout must be a positive number of minutes');
      return;
    }
    if (selectedScreenLockPassword === screenLockPassword && timeoutValue === screenLockTimeoutMinutes) return;
    setScreenLockStatus('');
    try {
      await adminSetScreenLockSettings({ password: selectedScreenLockPassword, timeout_minutes: timeoutValue }, adminKey);
    } catch (err) {
      setScreenLockStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
      return;
    }
    setScreenLockPassword(selectedScreenLockPassword);
    setScreenLockTimeoutMinutes(timeoutValue);
    setScreenLockStatus('Saved — takes effect for this tab on its next reload, no restart needed.');
  }

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

  function resetChatMemoryPrompt(field: 'chunkSummaryPrompt' | 'distillPrompt' | 'householdMemoryPrompt') {
    if (field === 'chunkSummaryPrompt') setSelectedChunkSummaryPrompt('');
    if (field === 'distillPrompt') setSelectedDistillPrompt('');
    if (field === 'householdMemoryPrompt') setSelectedHouseholdMemoryPrompt('');
  }

  // Refetches the model catalog whenever a different connection is picked, so the model dropdown
  // always reflects the currently *selected* profile, not whichever one is live right now. The
  // vision checkbox follows the same live-preview shape — no fetch needed, visionCapableProfiles
  // already has every profile's flag.
  useEffect(() => {
    if (!unlocked || !selectedProfile) return;
    setSelectedSupportsVision(visionCapableProfiles.includes(selectedProfile));
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
  }, [selectedProfile, unlocked, visionCapableProfiles]);

  async function saveConnection() {
    const visionChanged = selectedSupportsVision !== visionCapableProfiles.includes(selectedProfile);
    if (!selectedModel || (selectedProfile === activeProfile && selectedModel === activeModel && !visionChanged)) {
      return;
    }
    setConnectionStatus('');
    try {
      await adminSetActiveProfile(selectedProfile, selectedModel, adminKey, selectedSupportsVision);
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
          setVisionCapableProfiles((prev) =>
            selectedSupportsVision
              ? Array.from(new Set([...prev, selectedProfile]))
              : prev.filter((name) => name !== selectedProfile),
          );
          setConnectionStatus('Back up — reload to confirm.');
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
        <h1>BigImagine — provider credentials</h1>
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
      <h1>BigImagine — provider credentials</h1>

      <fieldset>
        <legend>Theme</legend>
        <button onClick={onToggleTheme}>
          {theme === 'dark' ? '☀ Switch to light mode' : '☾ Switch to dark mode'}
        </button>
      </fieldset>

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
        <label>
          <input
            type="checkbox"
            checked={selectedSupportsVision}
            onChange={(e) => setSelectedSupportsVision(e.target.checked)}
          />
          {' '}This connection can see images (vision)
        </label>
        <br />
        <button
          onClick={saveConnection}
          disabled={
            modelsLoading ||
            !selectedModel ||
            (selectedProfile === activeProfile &&
              selectedModel === activeModel &&
              selectedSupportsVision === visionCapableProfiles.includes(selectedProfile))
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
        <legend>Notifications</legend>
        <label>
          Ntfy server URL
          <br />
          <input
            value={selectedNtfyServerUrl}
            onChange={(e) => setSelectedNtfyServerUrl(e.target.value)}
            placeholder="e.g. http://ntfy:80 — the internal address, not the public phone-facing hostname"
          />
        </label>
        <br />
        <label>
          <input
            type="checkbox"
            checked={selectedNotificationsEnabled}
            onChange={(e) => setSelectedNotificationsEnabled(e.target.checked)}
          />
          Enable send_push_notification (household kill switch)
        </label>
        <br />
        <button
          onClick={saveNotificationSettings}
          disabled={selectedNtfyServerUrl === ntfyServerUrl && selectedNotificationsEnabled === notificationsEnabled}
        >
          Save
        </button>
        <div className="status">{notificationSettingsStatus}</div>
      </fieldset>

      <fieldset>
        <legend>Chub Import</legend>
        <label>
          PIA proxy URL
          <br />
          <input
            value={selectedPiaProxyUrl}
            onChange={(e) => setSelectedPiaProxyUrl(e.target.value)}
            placeholder="e.g. http://pia-proxy:8080 — the internal address of the stacks/pia-proxy container"
          />
        </label>
        <br />
        <button onClick={savePiaProxyUrl} disabled={!selectedPiaProxyUrl || selectedPiaProxyUrl === piaProxyUrl}>
          Save
        </button>
        <div className="status">{piaProxyUrlStatus}</div>
      </fieldset>

      <fieldset>
        <legend>Persona</legend>
        <label>
          Your name
          <br />
          <input
            value={selectedPersonaName}
            onChange={(e) => setSelectedPersonaName(e.target.value)}
            placeholder="e.g. Jeremy"
          />
        </label>
        <br />
        <label>
          Your description
          <br />
          <textarea
            value={selectedPersonaDescription}
            onChange={(e) => setSelectedPersonaDescription(e.target.value)}
            placeholder="A short description of yourself, injected wherever a prompt stack preset enables the User Persona marker."
            rows={3}
          />
        </label>
        <br />
        <button
          onClick={savePersonaSettings}
          disabled={selectedPersonaName === personaName && selectedPersonaDescription === personaDescription}
        >
          Save
        </button>
        <div className="status">{personaSettingsStatus}</div>
      </fieldset>

      <fieldset>
        <legend>Screen Lock</legend>
        <label>
          Password
          <br />
          <input
            type="text"
            value={selectedScreenLockPassword}
            onChange={(e) => setSelectedScreenLockPassword(e.target.value)}
            placeholder="(no lock — leave blank to disable)"
          />
        </label>
        <p>
          Privacy only, not real security — the app locks itself after the idle timeout below and asks for this
          password again. Leave blank to turn the lock off.
        </p>
        <label>
          Idle timeout (minutes)
          <br />
          <input
            type="text"
            value={selectedScreenLockTimeoutMinutes}
            onChange={(e) => setSelectedScreenLockTimeoutMinutes(e.target.value)}
            placeholder="5"
          />
        </label>
        <br />
        <button
          onClick={saveScreenLockSettings}
          disabled={
            selectedScreenLockPassword === screenLockPassword &&
            Number(selectedScreenLockTimeoutMinutes) === screenLockTimeoutMinutes
          }
        >
          Save
        </button>
        <div className="status">{screenLockStatus}</div>
      </fieldset>

      <fieldset>
        <legend>Chat Memory</legend>
        <label>
          Connection
          <br />
          <select value={selectedChatMemoryProfile} onChange={(e) => setSelectedChatMemoryProfile(e.target.value)}>
            <option value="">(household default{activeProfile ? ` — ${activeProfile}` : ''})</option>
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
        <button onClick={saveChatMemorySettings}>Save</button>
        <div className="status">{chatMemoryStatus}</div>
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
