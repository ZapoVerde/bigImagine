import { useEffect, useState } from 'react';
import { ApiError, adminGetBgrmSettings, adminSetBgrmSettings } from '../../api/client';
import type { BgrmSettings } from '../../api/types';

interface BgrmSettingsPanelProps {
  adminKey: string | null;
}

export default function BgrmSettingsPanel({ adminKey }: BgrmSettingsPanelProps) {
  const [settings, setSettings] = useState<BgrmSettings | null>(null);
  const [draft, setDraft] = useState<BgrmSettings>({ portraitStudioEnabled: false, characterAutofireEnabled: false });
  const [status, setStatus] = useState('');

  useEffect(() => {
    let active = true;
    setStatus('');
    adminGetBgrmSettings(adminKey)
      .then((loaded) => {
        if (!active) return;
        setSettings(loaded);
        setDraft(loaded);
      })
      .catch((error: unknown) => {
        if (active) setStatus(error instanceof ApiError ? `error: ${error.message}` : 'Failed to load BGRM settings.');
      });
    return () => {
      active = false;
    };
  }, [adminKey]);

  async function save(patch: Partial<BgrmSettings>) {
    setStatus('Saving...');
    try {
      const updated = await adminSetBgrmSettings(patch, adminKey);
      setSettings(updated);
      setDraft(updated);
      setStatus('Saved.');
    } catch (error: unknown) {
      setStatus(error instanceof ApiError ? `error: ${error.message}` : 'Failed to save BGRM settings.');
    }
  }

  const loaded = settings !== null;
  return (
    <fieldset>
      <legend>Character-image background removal</legend>
      {!loaded ? (
        <div className="status">{status || 'Loading...'}</div>
      ) : (
        <>
          <label>
            <input
              type="checkbox"
              checked={draft.portraitStudioEnabled}
              onChange={(event) => setDraft((current) => ({ ...current, portraitStudioEnabled: event.target.checked }))}
            />{' '}
            Portrait Studio images
          </label>
          <br />
          <button
            onClick={() => save({ portraitStudioEnabled: draft.portraitStudioEnabled })}
            disabled={draft.portraitStudioEnabled === settings.portraitStudioEnabled}
          >
            Save Portrait Studio
          </button>
          <br />
          <label>
            <input
              type="checkbox"
              checked={draft.characterAutofireEnabled}
              onChange={(event) => setDraft((current) => ({ ...current, characterAutofireEnabled: event.target.checked }))}
            />{' '}
            RP character portraits / autofire
          </label>
          <br />
          <button
            onClick={() => save({ characterAutofireEnabled: draft.characterAutofireEnabled })}
            disabled={draft.characterAutofireEnabled === settings.characterAutofireEnabled}
          >
            Save RP character portraits
          </button>
          <div className="status">
            These are independent opt-in gates. Configure the active Background Removal engine in Connections.
          </div>
          <div className="status">{status}</div>
        </>
      )}
    </fieldset>
  );
}
