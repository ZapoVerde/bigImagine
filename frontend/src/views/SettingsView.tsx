import { useRef, useState } from 'react';
import {
  ApiError,
  adminGetCharacterSettings,
  adminGetNotificationSettings,
  adminGetPersonaSettings,
  adminGetPiaProxyUrl,
  adminGetPortraitSubjectDescriberSettings,
  adminGetPortraitsEnabled,
  adminGetScreenLockSettings,
  adminGetTimezone,
  adminListCredentials,
  adminSetCharacterSettings,
  adminSetCredential,
  adminSetNotificationSettings,
  adminSetPersonaSettings,
  adminSetPiaProxyUrl,
  adminSetPortraitSubjectDescriberSettings,
  adminSetPortraitsEnabled,
  adminSetScreenLockSettings,
  adminSetTimezone,
} from '../api/client';
import { useAdminUnlock } from '../hooks/useAdminUnlock';
import BgrmSettingsPanel from '../components/settings/BgrmSettingsPanel';
import type { CharacterSettings, CredentialSummary, NotificationSettings, PersonaSettings, PortraitSubjectDescriberSettings, PortraitsEnabled, ScreenLockSettings } from '../api/types';
import './SettingsView.css';

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

// Admin-key unlock (mount-time Access probe, then a stored key, then the manual key form) is
// hooks/useAdminUnlock.ts, shared with views/ConnectionsView.tsx — attemptLoad below is this tab's
// own "prove the key works" fetch, everything around it (adminKey/checking/unlocked/loadError
// state, localStorage persistence) lives in the hook.
//
// The Connection fieldset that used to live here (create/switch/rotate a named LLM connection) has
// moved to its own Connections tab (views/ConnectionsView.tsx, io/llmConnections.ts). The Chat
// Memory fieldset that used to live here (sync timing, prompts, the auto-recall retrieval knobs)
// moved to the RAG tab (views/RagView.tsx), and the Image Generation + Chat Background fieldsets
// moved to the Backgrounds tab (views/BackgroundsView.tsx) — this view is household settings only
// now. The Character-describer fieldset moved IN from the Characters page
// (rp-cast-library-repair.md Part B): it configures the in-chat character describer pass, a
// characters concern stranded on what is now explicitly the cards-only page — the same
// admin-gated, chat-independent LLM/prompt-config shape as its Persona neighbor here.
interface SettingsViewProps {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export default function SettingsView({ theme, onToggleTheme }: SettingsViewProps) {
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [selectedName, setSelectedName] = useState('');
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('');
  const pollRef = useRef<number | null>(null);

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

  // The household's own name/description (docs/plans/prompt-macros.md's Stage 1) — folded into a chat's
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

  // Character-describer settings (rp-cast-infrastructure-plan.md A4 — moved here from the
  // Characters page by rp-cast-library-repair.md Part B): the describer LLM pass that turns a
  // newly-minted in-chat character's blank persona into a real persona blurb. Same shape as the
  // Persona/Screen Lock fieldsets — admin-gated by this tab's single useAdminUnlock, no separate
  // unlock of its own.
  const [characterSettings, setCharacterSettings] = useState<CharacterSettings | null>(null);
  const [selectedDescriberPrompt, setSelectedDescriberPrompt] = useState('');
  const [selectedDescriberHistoryPairs, setSelectedDescriberHistoryPairs] = useState('');
  const [characterSettingsStatus, setCharacterSettingsStatus] = useState('');

  // Portrait Subject describer settings (portrait-studio-standalone-subjects-plan.md Part B):
  // the prompt template for the one synchronous LLM call that turns a bare Studio subject name
  // (+ optional seed) into its standing_instructions. A sibling of the Character-describer
  // fieldset above minus the history-pairs knob — this describer has no transcript to bound.
  // Same admin gate + live no-restart shape.
  const [portraitSubjectDescriberSettings, setPortraitSubjectDescriberSettings] = useState<PortraitSubjectDescriberSettings | null>(null);
  const [selectedPortraitSubjectDescriberPrompt, setSelectedPortraitSubjectDescriberPrompt] = useState('');
  const [portraitSubjectDescriberSettingsStatus, setPortraitSubjectDescriberSettingsStatus] = useState('');

  // Portrait Studio's household kill switch (portrait-chain-hardening-plan.md) — one boolean,
  // default-on (the feature predates the switch, an opt-out safety valve, not an opt-in gate).
  const [portraitsEnabled, setPortraitsEnabled] = useState(true);
  const [selectedPortraitsEnabled, setSelectedPortraitsEnabled] = useState(true);
  const [portraitsEnabledStatus, setPortraitsEnabledStatus] = useState('');

  function applyPortraitsEnabled(settings: PortraitsEnabled) {
    setPortraitsEnabled(settings.enabled);
    setSelectedPortraitsEnabled(settings.enabled);
  }

  function applyCharacterSettings(settings: CharacterSettings) {
    setCharacterSettings(settings);
    setSelectedDescriberPrompt(settings.describerPrompt);
    setSelectedDescriberHistoryPairs(settings.describerHistoryPairs);
  }

  function applyPortraitSubjectDescriberSettings(settings: PortraitSubjectDescriberSettings) {
    setPortraitSubjectDescriberSettings(settings);
    setSelectedPortraitSubjectDescriberPrompt(settings.describerPrompt);
  }

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

  // Whatever proves the key works — every admin GET this tab needs on first load. Shared unlock
  // state (adminKey/checking/unlocked/loadError, the mount-time no-key-then-stored-key probe, the
  // manual Load button's handler) lives in useAdminUnlock, not duplicated here.
  async function attemptLoad(key: string | null): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const [creds, tz, notificationSettings, piaProxyUrlResult, personaSettings, screenLockSettings, characterSettingsResult, portraitSubjectDescriberSettingsResult, portraitsEnabledResult] = await Promise.all([
        adminListCredentials(key),
        adminGetTimezone(key),
        adminGetNotificationSettings(key),
        adminGetPiaProxyUrl(key),
        adminGetPersonaSettings(key),
        adminGetScreenLockSettings(key),
        adminGetCharacterSettings(key),
        adminGetPortraitSubjectDescriberSettings(key),
        adminGetPortraitsEnabled(key),
      ]);
      setCredentials(creds);
      setSelectedName(creds[0]?.name ?? '');
      setTimezone(tz);
      setSelectedTimezone(tz);
      applyNotificationSettings(notificationSettings);
      setPiaProxyUrl(piaProxyUrlResult ?? '');
      setSelectedPiaProxyUrl(piaProxyUrlResult ?? '');
      applyPersonaSettings(personaSettings);
      applyScreenLockSettings(screenLockSettings);
      applyCharacterSettings(characterSettingsResult);
      applyPortraitSubjectDescriberSettings(portraitSubjectDescriberSettingsResult);
      applyPortraitsEnabled(portraitsEnabledResult);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  const { adminKey, setAdminKey, checking, unlocked, loadError, load } = useAdminUnlock(attemptLoad);

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

  async function saveCharacterSettings() {
    if (!characterSettings) return;
    const patch: {
      describer_prompt?: string;
      describer_history_pairs?: string;
    } = {};
    if (selectedDescriberPrompt !== characterSettings.describerPrompt) patch.describer_prompt = selectedDescriberPrompt;
    if (selectedDescriberHistoryPairs !== characterSettings.describerHistoryPairs) {
      patch.describer_history_pairs = selectedDescriberHistoryPairs;
    }
    if (Object.keys(patch).length === 0) return;
    setCharacterSettingsStatus('Saving…');
    try {
      applyCharacterSettings(await adminSetCharacterSettings(patch, adminKey));
      setCharacterSettingsStatus('Saved.');
    } catch (err) {
      setCharacterSettingsStatus(err instanceof ApiError ? err.message : 'Failed to save.');
    }
  }

  async function savePortraitSubjectDescriberSettings() {
    if (!portraitSubjectDescriberSettings) return;
    const patch: { describer_prompt?: string } = {};
    if (selectedPortraitSubjectDescriberPrompt !== portraitSubjectDescriberSettings.describerPrompt) {
      patch.describer_prompt = selectedPortraitSubjectDescriberPrompt;
    }
    if (Object.keys(patch).length === 0) return;
    setPortraitSubjectDescriberSettingsStatus('Saving…');
    try {
      applyPortraitSubjectDescriberSettings(await adminSetPortraitSubjectDescriberSettings(patch, adminKey));
      setPortraitSubjectDescriberSettingsStatus('Saved.');
    } catch (err) {
      setPortraitSubjectDescriberSettingsStatus(err instanceof ApiError ? err.message : 'Failed to save.');
    }
  }

  async function savePortraitsEnabled() {
    if (selectedPortraitsEnabled === portraitsEnabled) return;
    setPortraitsEnabledStatus('');
    try {
      applyPortraitsEnabled(await adminSetPortraitsEnabled({ enabled: selectedPortraitsEnabled }, adminKey));
      setPortraitsEnabledStatus(selectedPortraitsEnabled ? 'Enabled — the Portraits tab is back on the next page load.' : 'Disabled — every portrait route, the Portraits tab, and the active-portrait box are off.');
    } catch (err) {
      setPortraitsEnabledStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
    }
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
        <legend>Character-describer</legend>
        <div className="settings-describer-fields">
          <label>
            Prompt {characterSettings?.describerPromptIsDefault && <em>(default)</em>}
            <br />
            <textarea
              value={selectedDescriberPrompt}
              onChange={(e) => setSelectedDescriberPrompt(e.target.value)}
              rows={10}
              placeholder="[SYSTEM: TASK — CHARACTER ARCHIVIST]… (the built-in default)"
            />
          </label>
          <div className="status">
            The describer LLM call that turns a newly-minted character's blank persona into a real
            persona blurb (rp-cast-infrastructure-plan.md). Macros expanded per call are{' '}
            <code>{'{{character_name}}'}</code> and <code>{'{{context}}'}</code>. The reply's{' '}
            <code>Persona:</code> marker fills <code>characters.persona</code>. Empty means the
            built-in default.
          </div>
          <label>
            Context (turn-pairs)
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
            How many trailing turn-pairs the describer reads as narrative context (default 1).
            Leave empty for the default.
          </div>
          <button
            onClick={saveCharacterSettings}
            disabled={
              !characterSettings ||
              (selectedDescriberPrompt === characterSettings.describerPrompt &&
                selectedDescriberHistoryPairs === characterSettings.describerHistoryPairs)
            }
          >
            Save
          </button>
          <div className="status">{characterSettingsStatus}</div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Portrait Subject-describer</legend>
        <div className="settings-describer-fields">
          <label>
            Prompt {portraitSubjectDescriberSettings?.describerPromptIsDefault && <em>(default)</em>}
            <br />
            <textarea
              value={selectedPortraitSubjectDescriberPrompt}
              onChange={(e) => setSelectedPortraitSubjectDescriberPrompt(e.target.value)}
              rows={10}
              placeholder="[SYSTEM: TASK — PORTRAIT SUBJECT ARCHIVIST]… (the built-in default)"
            />
          </label>
          <div className="status">
            The one synchronous LLM call that turns a bare Portrait Studio subject name (+
            optional seed) into its <code>standing_instructions</code>, used only when an operator
            creates a subject without typing instructions by hand — a subject created with
            instructions already filled in never calls this. Macros expanded per call are{' '}
            <code>{'{{name}}'}</code> and <code>{'{{seed}}'}</code>. The reply's{' '}
            <code>Appearance:</code> marker fills the entity's standing_instructions. Empty means
            the built-in default.
          </div>
          <button
            onClick={savePortraitSubjectDescriberSettings}
            disabled={
              !portraitSubjectDescriberSettings ||
              selectedPortraitSubjectDescriberPrompt === portraitSubjectDescriberSettings.describerPrompt
            }
          >
            Save
          </button>
          <div className="status">{portraitSubjectDescriberSettingsStatus}</div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Portrait Studio</legend>
        <label>
          <input
            type="checkbox"
            checked={selectedPortraitsEnabled}
            onChange={(e) => setSelectedPortraitsEnabled(e.target.checked)}
          />
          Enable Portrait Studio (household kill switch)
        </label>
        <div className="status">
          The whole Studio chain — every <code>/v1/portraits/*</code> route except the layer-manifest
          pair, the Portraits tab, and the active-portrait box above the RP chat
          (portrait-chain-hardening-plan.md). Unset behaves as enabled: the feature predates the
          switch, so this is an opt-out safety valve. Takes effect on the next page load and on the
          very next route call — no restart needed.
        </div>
        <br />
        <button onClick={savePortraitsEnabled} disabled={selectedPortraitsEnabled === portraitsEnabled}>
          Save
        </button>
        <div className="status">{portraitsEnabledStatus}</div>
      </fieldset>

      <BgrmSettingsPanel adminKey={adminKey} />

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
