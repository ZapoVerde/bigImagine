/**
 * @file frontend/src/hooks/useAdminUnlock.ts
 * @stamp 2026-08-06
 * @architectural-role React Hook — shared admin-key unlock gate
 * @description
 * Extracted from SettingsView.tsx's original mount-time probe so views/ConnectionsView.tsx can
 * share the exact same gate rather than duplicating it. Under Cloudflare Access,
 * httpServer.ts's isAdminAuthorized trusts the Access identity directly — a second manually-typed
 * secret on top of Access would be redundant friction, not real defense in depth, for a household
 * app. So on mount this probes with no key at all; if Access already covers it, the caller unlocks
 * immediately and the key form never appears. Only a deployment with no Access configured (or a
 * non-browser caller) ever needs to type the static admin key. Persisted to localStorage
 * (ADMIN_API_KEY_STORAGE_KEY) like the household key: single-user deployment, no household member
 * whose access this key needs to withhold, so re-typing it every page load would be pure friction.
 *
 * The caller owns what "loaded" means — attemptLoad is whatever per-view fetch(es) prove the key
 * works (SettingsView.tsx's dozen admin GETs, ConnectionsView.tsx's one list call) — this hook only
 * owns the key/checking/unlocked/loadError state machine around calling it.
 *
 * @api-declaration
 * useAdminUnlock(attemptLoad: (key: string | null) => Promise<{ ok: true } | { ok: false; error: unknown }>)
 *   -> { adminKey, setAdminKey, checking, unlocked, loadError, load }
 *   load() re-runs attemptLoad with the current adminKey (the manual "Load" button's handler),
 *   persisting the key to localStorage on success.
 *
 * @contract
 *   assertions:
 *     purity:          impure (localStorage, calls the given attemptLoad)
 *     state_ownership: [adminKey/checking/unlocked/loadError React state]
 *     external_io:     [localStorage]
 */

import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { ADMIN_API_KEY_STORAGE_KEY } from '../api/authStorage';

type AttemptResult = { ok: true } | { ok: false; error: unknown };

export function useAdminUnlock(attemptLoad: (key: string | null) => Promise<AttemptResult>) {
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY) ?? '');
  const [checking, setChecking] = useState(true);
  const [unlocked, setUnlocked] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if ((await attemptLoad(null)).ok) {
        setUnlocked(true);
        setChecking(false);
        return;
      }
      // Not covered by Access (or Access isn't configured here) — try a previously-saved admin
      // key before falling back to the manual key form.
      const stored = localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY);
      if (stored) {
        setAdminKey(stored);
        if ((await attemptLoad(stored)).ok) {
          setUnlocked(true);
          setChecking(false);
          return;
        }
        localStorage.removeItem(ADMIN_API_KEY_STORAGE_KEY);
      }
      setChecking(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoadError(null);
    const result = await attemptLoad(adminKey);
    if (result.ok) {
      localStorage.setItem(ADMIN_API_KEY_STORAGE_KEY, adminKey);
      setUnlocked(true);
      return;
    }
    const err = result.error;
    setLoadError(err instanceof ApiError && err.status === 401 ? 'invalid admin key' : 'error loading data');
  }

  return { adminKey, setAdminKey, checking, unlocked, loadError, load };
}
