import { useState } from 'react';

interface UnlockGateProps {
  onUnlock: (key: string) => void;
}

/** Blocks the whole app until a household API key (BIGBRAIN_API_KEYS) is entered. Persisted to
 *  localStorage by the caller (App.tsx) — this is a per-device household key, not the higher-
 *  blast-radius admin key, so persisting it is an acceptable convenience. */
export default function UnlockGate({ onUnlock }: UnlockGateProps) {
  const [key, setKey] = useState('');

  return (
    <div className="unlock-gate">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) onUnlock(key.trim());
        }}
      >
        <h1>bigBrain</h1>
        <label>
          API key
          <br />
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoFocus
          />
        </label>
        <br />
        <button type="submit">Unlock</button>
      </form>
    </div>
  );
}
