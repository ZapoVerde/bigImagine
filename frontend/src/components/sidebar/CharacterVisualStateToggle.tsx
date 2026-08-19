/**
 * @file frontend/src/components/sidebar/CharacterVisualStateToggle.tsx
 * @stamp 2026-08-19
 * @architectural-role Stateful Owner (bi_principles.md §8) — owns its own fetch + optimistic save
 *   of the single character_visual_state_enabled switch
 * @description
 * The character visual-state feature's kill switch (docs/plans/character-visual-state-plan.md),
 * surfaced directly in the RP chat's sidebar (Sidebar.tsx's 'rp' tab) rather than buried in
 * Settings — the point is a quick, always-visible switch the operator can flip off before the
 * feature (footer parsing, snapshot persistence, autofire renders) does anything it isn't ready
 * for yet, without leaving the chat they're in. Default OFF: nothing in the pipeline runs until
 * this is explicitly turned on.
 *
 * Same transparent-admin-key posture as PortraitConnectionPanel/LegibilityMenu: reads the key
 * already stored by a prior Connections/Settings unlock (ADMIN_API_KEY_STORAGE_KEY) rather than
 * prompting for its own. A save fails quietly with an inline status line (most likely cause: no
 * admin key stored yet).
 *
 * @api-declaration
 * CharacterVisualStateToggle() — no props; entirely self-fetching
 *
 * @contract
 *   assertions:
 *     purity:          impure (fetches, local state, one field's optimistic save)
 *     state_ownership: [enabled, loading, status]
 *     external_io:     [adminGetCharacterVisualStateEnabled, adminSetCharacterVisualStateEnabled]
 */

import { useEffect, useRef, useState } from 'react';
import { ADMIN_API_KEY_STORAGE_KEY } from '../../api/authStorage';
import { adminGetCharacterVisualStateEnabled, adminSetCharacterVisualStateEnabled, ApiError } from '../../api/client';
import './CharacterVisualStateToggle.css';

export default function CharacterVisualStateToggle() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  // Only the newest save may land — same guard shape as PortraitConnectionPanel/LegibilityMenu.
  const seqRef = useRef(0);

  useEffect(() => {
    const adminKey = localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY);
    adminGetCharacterVisualStateEnabled(adminKey)
      .then((setting) => setEnabled(setting.enabled))
      .catch((err) => setStatus(err instanceof ApiError ? err.message : 'failed to load'))
      .finally(() => setLoading(false));
  }, []);

  function onChange(next: boolean) {
    const before = enabled;
    const seq = ++seqRef.current;
    setEnabled(next); // optimistic
    setStatus('');
    const adminKey = localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY);
    adminSetCharacterVisualStateEnabled(next, adminKey)
      .then((saved) => {
        if (seq === seqRef.current) setEnabled(saved.enabled);
      })
      .catch((err) => {
        if (seq !== seqRef.current) return;
        setEnabled(before);
        setStatus(err instanceof ApiError ? err.message : 'Couldn’t save — check the admin key (Connections tab).');
      });
  }

  return (
    <div className="character-visual-state-toggle">
      <label>
        <input type="checkbox" checked={enabled} disabled={loading} onChange={(e) => onChange(e.target.checked)} />
        Character portraits (expression/outfit autofire)
      </label>
      <p className="character-visual-state-toggle-note">
        {enabled
          ? 'Cleaner tracks each character’s current expression/outfit and renders a portrait when either changes.'
          : 'Off — no visual-state tracking or autofire renders happen for any chat.'}
      </p>
      {status && <div className="error-banner">{status}</div>}
    </div>
  );
}
