/**
 * @file frontend/src/views/PortraitSettingsView.tsx
 * @stamp 2026-08-22
 * @architectural-role React view — owns the portrait configuration surface
 * @description Admin-gated UI for existing portrait settings and BGRM opt-ins.
 * @api-declaration PortraitSettingsView() -> JSX
 * @contract Reads and writes only through existing admin API wrappers; never changes generation,
 * persistence contracts, or BGRM architecture.
 */

import { useState } from 'react';
import { ApiError, adminGetPortraitSubjectDescriberSettings, adminGetPortraitsEnabled, adminSetPortraitSubjectDescriberSettings, adminSetPortraitsEnabled } from '../api/client';
import BgrmSettingsPanel from '../components/settings/BgrmSettingsPanel';
import { useAdminUnlock } from '../hooks/useAdminUnlock';
import type { PortraitSubjectDescriberSettings, PortraitsEnabled } from '../api/types';
import './SettingsView.css';

export default function PortraitSettingsView() {
  const [portraitSubjectDescriberSettings, setPortraitSubjectDescriberSettings] = useState<PortraitSubjectDescriberSettings | null>(null);
  const [selectedPortraitSubjectDescriberPrompt, setSelectedPortraitSubjectDescriberPrompt] = useState('');
  const [portraitSubjectDescriberSettingsStatus, setPortraitSubjectDescriberSettingsStatus] = useState('');
  const [portraitsEnabled, setPortraitsEnabled] = useState(true);
  const [selectedPortraitsEnabled, setSelectedPortraitsEnabled] = useState(true);
  const [portraitsEnabledStatus, setPortraitsEnabledStatus] = useState('');

  function applyPortraitSubjectDescriberSettings(settings: PortraitSubjectDescriberSettings) {
    setPortraitSubjectDescriberSettings(settings);
    setSelectedPortraitSubjectDescriberPrompt(settings.describerPrompt);
  }

  function applyPortraitsEnabled(settings: PortraitsEnabled) {
    setPortraitsEnabled(settings.enabled);
    setSelectedPortraitsEnabled(settings.enabled);
  }

  async function attemptLoad(key: string | null): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const [subjectDescriberSettings, enabledSettings] = await Promise.all([
        adminGetPortraitSubjectDescriberSettings(key),
        adminGetPortraitsEnabled(key),
      ]);
      applyPortraitSubjectDescriberSettings(subjectDescriberSettings);
      applyPortraitsEnabled(enabledSettings);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  const { adminKey, setAdminKey, checking, unlocked, loadError, load } = useAdminUnlock(attemptLoad);

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
      setPortraitsEnabledStatus(selectedPortraitsEnabled ? 'Enabled — Studio is available on the next page load.' : 'Disabled — Studio and its active-portrait box are off.');
    } catch (err) {
      setPortraitsEnabledStatus(err instanceof ApiError ? `error: ${err.message}` : 'failed to save');
    }
  }

  if (checking) return <div className="settings-view" />;

  if (!unlocked) {
    return (
      <div className="settings-view">
        <h1>Portraits</h1>
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
      <h1>Portraits</h1>
      <fieldset>
        <legend>Studio</legend>
        <label>
          <input type="checkbox" checked={selectedPortraitsEnabled} onChange={(e) => setSelectedPortraitsEnabled(e.target.checked)} />{' '}
          Enable Studio (household kill switch)
        </label>
        <div className="status">
          The whole Studio chain — every <code>/v1/portraits/*</code> route except the layer-manifest
          pair and the active-portrait box above RP chat. Unset behaves as enabled: the feature
          predates the switch, so this is an opt-out safety valve. Takes effect on the next page
          load and on the very next route call — no restart needed.
        </div>
        <br />
        <button onClick={savePortraitsEnabled} disabled={selectedPortraitsEnabled === portraitsEnabled}>Save</button>
        <div className="status">{portraitsEnabledStatus}</div>
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
            The one synchronous LLM call that turns a bare Studio subject name (+ optional seed)
            into its <code>standing_instructions</code>, used only when an operator creates a
            subject without typing instructions by hand — a subject created with instructions
            already filled in never calls this. Macros expanded per call are <code>{'{{name}}'}</code>{' '}
            and <code>{'{{seed}}'}</code>. The reply&apos;s <code>Appearance:</code> marker fills the
            entity&apos;s standing_instructions. Empty means the built-in default.
          </div>
          <button
            onClick={savePortraitSubjectDescriberSettings}
            disabled={!portraitSubjectDescriberSettings || selectedPortraitSubjectDescriberPrompt === portraitSubjectDescriberSettings.describerPrompt}
          >
            Save
          </button>
          <div className="status">{portraitSubjectDescriberSettingsStatus}</div>
        </div>
      </fieldset>

      <BgrmSettingsPanel adminKey={adminKey} />
    </div>
  );
}
