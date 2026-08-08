import { useRef, useState } from 'react';
import {
  adminSetChatLegibilitySettings,
} from '../../api/client';
import type { ChatLegibilitySettings, ChatLegibilitySettingsPatch } from '../../api/types';
import { ADMIN_API_KEY_STORAGE_KEY } from '../../api/authStorage';
import './LegibilityMenu.css';

/**
 * The ChatView "Text legibility" menu (migrations 0074 + 0075) — a collapsible section at the
 * top of the chat settings rail with the five opt-in text-rendering tricks for prose on
 * translucent bubbles over the location background, plus the halo-strength slider (0075) under
 * the Letter halo toggle. Each control POSTs its partial patch to the admin-gated
 * POST /v1/admin/chat-legibility-settings immediately (no Save button); the change is applied
 * optimistically to the view and reverted if the write fails (e.g. no stored admin key).
 * Household-wide, so one set applies to every chat — ChatView re-reads it at every chat load.
 *
 * Rapid toggles are serialized through a promise chain so the server applies writes in click
 * order (a double-flip of one checkbox always lands as "off"), and only the newest request's
 * response — the full authoritative set — is applied to the view; stale/older responses are
 * ignored, so out-of-order arrivals can never leave the UI diverged from the store.
 */
interface LegibilityMenuProps {
  /** Current settings; null while the initial GET is in flight (toggles disabled). */
  settings: ChatLegibilitySettings | null;
  /** Applied immediately on any change — ChatView owns the data-legibility attribute. */
  onChange: (next: ChatLegibilitySettings) => void;
}

/** The five toggle fields — haloStrength (a 0..1 number) is the slider, not a checkbox. */
type ToggleField = 'halo' | 'outline' | 'solidCode' | 'weightBump' | 'hoverFocus';

const TOGGLES: Array<{ field: ToggleField; label: string; desc: string }> = [
  {
    field: 'halo',
    label: 'Letter halo',
    desc: 'Soft dark/light ring around each glyph so text stays readable over any background image behind the bubble.',
  },
  {
    field: 'outline',
    label: 'Crisp outline',
    desc: '0.5px stroke on quoted dialogue, headings and spoiler summaries for extra definition.',
  },
  {
    field: 'solidCode',
    label: 'Solid code blocks',
    desc: 'Code chips and blocks get a solid dark fill instead of translucent grey-on-grey, so all code token colors stay legible.',
  },
  {
    field: 'weightBump',
    label: 'Bolder weak text',
    desc: 'Medium weight for italicized emphasis, blockquotes and pending bubbles — the grey text that reads worst over a busy background.',
  },
  {
    field: 'hoverFocus',
    label: 'Hover to focus',
    desc: 'Hovering (or tapping) a message temporarily solidifies just that bubble for reading long replies.',
  },
];

export default function LegibilityMenu({ settings, onChange }: LegibilityMenuProps) {
  const [status, setStatus] = useState('');
  // The last-settled write's "keep the chain alive regardless of failure" continuation. Each new
  // toggle chains onto it, so writes reach the server in click order.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  // Monotonic click counter: only the newest request may apply its response (success or revert).
  const seqRef = useRef(0);

  /** Applies a partial patch optimistically, then POSTs it; the newest write's full-set response
   *  is the only one that touches the view, and a failed newest write reverts to `before`. */
  function commit(patch: ChatLegibilitySettingsPatch, before: ChatLegibilitySettings) {
    const seq = ++seqRef.current;
    setStatus('');
    onChange({ ...before, ...patch }); // optimistic — the view flips immediately
    const adminKey = localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY);
    const write = chainRef.current.then(() => adminSetChatLegibilitySettings(patch, adminKey));
    // Whatever the write's outcome, the chain must stay resolvable so later toggles still run.
    chainRef.current = write.catch(() => undefined);
    write
      .then((saved) => {
        if (seq === seqRef.current) onChange(saved); // authoritative full set; the newest write wins
      })
      .catch(() => {
        if (seq === seqRef.current) {
          onChange(before); // revert only the newest click; older failures are superseded anyway
          setStatus('Couldn\u2019t save \u2014 check the admin key (Settings tab).');
        }
      });
  }

  function toggle(field: ToggleField) {
    if (!settings) return;
    commit({ [field]: !settings[field] }, settings);
  }

  return (
    <details className="legibility-menu">
      <summary className="legibility-menu-summary">Text legibility</summary>
      <div className="legibility-menu-body">
        {TOGGLES.map(({ field, label, desc }) => (
          <div key={field}>
            <label className={`legibility-toggle${settings ? '' : ' disabled'}`}>
              <input
                type="checkbox"
                checked={settings?.[field] ?? false}
                disabled={!settings}
                onChange={() => void toggle(field)}
              />
              <span className="legibility-toggle-text">
                <span className="legibility-toggle-label">{label}</span>
                <span className="legibility-toggle-desc">{desc}</span>
              </span>
            </label>
            {field === 'halo' && (
              <div className={`legibility-slider${settings?.halo ? '' : ' disabled'}`}>
                <span className="legibility-slider-label">Strength</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={settings ? Math.round(settings.haloStrength * 100) : 0}
                  disabled={!settings || !settings.halo}
                  onChange={(e) => settings && commit({ haloStrength: Number(e.target.value) / 100 }, settings)}
                />
                <span className="legibility-slider-value">
                  {settings ? `${Math.round(settings.haloStrength * 100)}%` : ''}
                </span>
              </div>
            )}
          </div>
        ))}
        {status && <div className="legibility-menu-status">{status}</div>}
      </div>
    </details>
  );
}
