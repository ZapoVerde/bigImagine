import { useEffect, useRef, useState } from 'react';
import { getScreenLockSettings } from '../api/client';
import './ScreenLockOverlay.css';

interface ScreenLockOverlayProps {
  apiKey: string | null;
}

const CHECK_INTERVAL_MS = 15000;
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'] as const;

/** Privacy-only idle-timeout re-lock, ported from SillyTavern-Playground's driver/ui/
 *  lockScreen.js. Sits on top of the app's real auth (App.tsx's UnlockGate/SSO, which already
 *  gates the API) — this only gates what's visible in the tab, so someone glancing at an
 *  unattended phone doesn't see the story. Disabled entirely whenever Settings' screen-lock
 *  password is blank (the default).
 *
 *  Settings are fetched once on mount, same as lockScreen.js's own init() — a password
 *  flipped on/off from the Settings tab takes effect on the next reload, not live, since there's
 *  nothing to react to mid-session for an already-open, already-unlocked tab. Every mount shows
 *  the lock immediately whenever a password is configured (gatekeeper semantics, same as
 *  lockScreen.js's 2026-07-31 change) — idle tracking only decides when to re-show it, never
 *  whether the initial show happens. Checked on an interval rather than a single timeout so a
 *  laptop put to sleep mid-timer still locks correctly on wake. */
export default function ScreenLockOverlay({ apiKey }: ScreenLockOverlayProps) {
  const [password, setPassword] = useState<string | null>(null);
  const [timeoutMinutes, setTimeoutMinutes] = useState(5);
  const [locked, setLocked] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const lastActivityRef = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    getScreenLockSettings(apiKey)
      .then((settings) => {
        if (cancelled || !settings.password) return; // feature disabled
        setPassword(settings.password);
        setTimeoutMinutes(settings.timeoutMinutes);
        setLocked(true);
      })
      .catch(() => {}); // best-effort — a failed fetch just leaves the lock disabled for this session
    return () => {
      cancelled = true;
    };
    // Deliberately fetched once per mount, not re-polled — see the module doc above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!password) return;

    const recordActivity = () => {
      if (!locked) lastActivityRef.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((evt) => document.addEventListener(evt, recordActivity, { passive: true }));

    const interval = setInterval(() => {
      if (locked) return;
      if (Date.now() - lastActivityRef.current > timeoutMinutes * 60 * 1000) setLocked(true);
    }, CHECK_INTERVAL_MS);

    return () => {
      ACTIVITY_EVENTS.forEach((evt) => document.removeEventListener(evt, recordActivity));
      clearInterval(interval);
    };
  }, [password, locked, timeoutMinutes]);

  if (!password || !locked) return null;

  const tryUnlock = () => {
    if (input === password) {
      setLocked(false);
      setInput('');
      setError('');
      lastActivityRef.current = Date.now();
    } else {
      setError('Incorrect password.');
      setInput('');
    }
  };

  return (
    <div className="screen-lock-overlay">
      <div className="screen-lock-box">
        <h2>Locked</h2>
        <p className="hint">Enter the password to continue.</p>
        <input
          type="password"
          placeholder="Password"
          autoComplete="off"
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') tryUnlock();
          }}
        />
        {error && <p className="screen-lock-error">{error}</p>}
        <button onClick={tryUnlock}>Unlock</button>
      </div>
    </div>
  );
}
