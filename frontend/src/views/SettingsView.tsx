import { useRef, useState } from 'react';
import {
  ApiError,
  adminGetChatBackgroundSettings,
  adminGetImageSettings,
  adminGetNotificationSettings,
  adminGetPersonaSettings,
  adminGetPiaProxyUrl,
  adminGetScreenLockSettings,
  adminGetTimezone,
  adminListCredentials,
  adminSetCredential,
  adminSetChatBackgroundSettings,
  adminSetImageSettings,
  adminSetNotificationSettings,
  adminSetPersonaSettings,
  adminSetPiaProxyUrl,
  adminSetScreenLockSettings,
  adminSetTimezone,
} from '../api/client';
import { useAdminUnlock } from '../hooks/useAdminUnlock';
import type { ChatBackgroundSettings, CredentialSummary, ImageSettings, NotificationSettings, PersonaSettings, ScreenLockSettings } from '../api/types';
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
// moved to the RAG tab (views/RagView.tsx) — this view is household settings only now.
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

  // Vistalyze image generation (docs/vistalyze_integration/endpoint.md §2.2, bi_principles.md §18).
  const [imageSettings, setImageSettingsState] = useState<ImageSettings | null>(null);
  const [selectedImageTemplate, setSelectedImageTemplate] = useState('');
  const [selectedDescriberPrompt, setSelectedDescriberPrompt] = useState('');
  const [selectedDescriberHistoryPairs, setSelectedDescriberHistoryPairs] = useState('');
  const [imageStatus, setImageStatus] = useState('');

  // Chat background (parallax_fade_teststep.md §2.2 + migration 0073) — the parallax pan
  // toggle, the dimming veil ("overlay") over the location background, and the bubble fill.
  // Saved values + in-progress selections, mirroring the other fieldsets.
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

  // Whatever proves the key works — every admin GET this tab needs on first load. Shared unlock
  // state (adminKey/checking/unlocked/loadError, the mount-time no-key-then-stored-key probe, the
  // manual Load button's handler) lives in useAdminUnlock, not duplicated here.
  async function attemptLoad(key: string | null): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const [creds, tz, notificationSettings, piaProxyUrlResult, personaSettings, screenLockSettings, imageSettingsResult, chatBackgroundSettingsResult] =
        await Promise.all([
          adminListCredentials(key),
          adminGetTimezone(key),
          adminGetNotificationSettings(key),
          adminGetPiaProxyUrl(key),
          adminGetPersonaSettings(key),
          adminGetScreenLockSettings(key),
          adminGetImageSettings(key),
          adminGetChatBackgroundSettings(key),
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
      applyImageSettings(imageSettingsResult);
      applyChatBackgroundSettings(chatBackgroundSettingsResult);
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
          Vistalyze's prompt synthesis template (endpoint.md §4.2): macros expanded per render are{' '}
          <code>{'{{visual_description}}'}</code>, <code>{'{{time_of_day}}'}</code>, <code>{'{{weather}}'}</code>,{' '}
          <code>{'{{mood}}'}</code>, <code>{'{{lighting}}'}</code> and <code>{'{{style_prefix}}'}</code>. Empty means
          the built-in default (bi_principles.md §18) — there is no separate reset action; clearing
          the field is how you ask for the default back.
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
          description (describer.md — VLZ's Step 3). Macros expanded per call are{' '}
          <code>{'{{location_name}}'}</code> and <code>{'{{context}}'}</code>. The reply's{' '}
          <code>Visuals:</code> half fills <code>visual_description</code> (which flows into the
          template above); <code>Definition:</code> fills the location's definition. Empty means the
          built-in default.
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
          <input
            type="checkbox"
            checked={selectedParallax}
            onChange={(e) => setSelectedParallax(e.target.checked)}
          />{' '}
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
          <input
            type="color"
            value={selectedOverlayShade}
            onChange={(e) => setSelectedOverlayShade(e.target.value)}
          />
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
          <input
            type="color"
            value={selectedBubbleUserShade}
            onChange={(e) => setSelectedBubbleUserShade(e.target.value)}
          />
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
