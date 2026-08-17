/**
 * @file frontend/src/components/sidebar/PortraitConnectionPanel.tsx
 * @stamp 2026-08-17
 * @architectural-role Stateful Owner (bi_principles.md §8) — owns its own connection-list +
 *   current-setting fetch and the optimistic save of a single field
 * @description
 * docs/plans/portrait-studio-connection-picker-plan.md — Portrait Studio's own sidebar panel
 * (the 'portraits' tab's previously-empty drawer, Sidebar.tsx). Lets an operator subscribe every
 * LLM call inside Portrait Studio (the subject describer, generation round, and
 * feedback/reflection — server/portraitRoutes.ts's resolvePortraitLlm) to one specific saved
 * connection, independent of whichever connection the Connections tab has marked active. This is
 * deliberately NOT another "default" pushed from the Connections tab — Portrait Studio holds its
 * own named reference (orchestrator_settings.portrait_llm_connection) and keeps using exactly
 * that connection even if the household default later changes.
 *
 * Same transparent-admin-key posture as ChatSettings' own Connection dropdown and
 * LegibilityMenu: reads the key already stored by a prior Connections/Settings unlock
 * (ADMIN_API_KEY_STORAGE_KEY) rather than prompting for its own. A save fails quietly with an
 * inline status line (most likely cause: no admin key stored yet) — this panel never blocks
 * Portrait Studio's own entity/generation panels, which unlock separately.
 *
 * @api-declaration
 * PortraitConnectionPanel() — no props; entirely self-fetching
 *
 * @contract
 *   assertions:
 *     purity:          impure (fetches, local state, one field's optimistic save)
 *     state_ownership: [connections, connectionName, loading, status]
 *     external_io:     [adminListConnections, adminGetPortraitLlmConnection,
 *                       adminSetPortraitLlmConnection]
 */

import { useEffect, useRef, useState } from 'react';
import { ADMIN_API_KEY_STORAGE_KEY } from '../../api/authStorage';
import { adminGetPortraitLlmConnection, adminListConnections, adminSetPortraitLlmConnection, ApiError } from '../../api/client';
import type { LlmConnectionSummary } from '../../api/types';
import './PortraitConnectionPanel.css';

export default function PortraitConnectionPanel() {
  const [connections, setConnections] = useState<LlmConnectionSummary[]>([]);
  const [connectionName, setConnectionName] = useState('');
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  // Only the newest save may land — an earlier, slower request settling after a later one would
  // otherwise flip the select back to a stale value (same guard shape as LegibilityMenu's seqRef).
  const seqRef = useRef(0);

  useEffect(() => {
    const adminKey = localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY);
    Promise.all([adminListConnections(adminKey), adminGetPortraitLlmConnection(adminKey)])
      .then(([conns, setting]) => {
        setConnections(conns);
        setConnectionName(setting.connectionName);
      })
      .catch((err) => setStatus(err instanceof ApiError ? err.message : 'failed to load connections'))
      .finally(() => setLoading(false));
  }, []);

  function onChange(next: string) {
    const before = connectionName;
    const seq = ++seqRef.current;
    setConnectionName(next); // optimistic
    setStatus('');
    const adminKey = localStorage.getItem(ADMIN_API_KEY_STORAGE_KEY);
    adminSetPortraitLlmConnection(next, adminKey)
      .then((saved) => {
        if (seq === seqRef.current) setConnectionName(saved.connectionName);
      })
      .catch((err) => {
        if (seq !== seqRef.current) return;
        setConnectionName(before);
        setStatus(err instanceof ApiError ? err.message : 'Couldn’t save — check the admin key (Connections tab).');
      });
  }

  const activeConnection = connections.find((c) => c.isActive);
  const subscribed = connections.find((c) => c.name === connectionName);

  return (
    <div className="portrait-connection-panel">
      {loading ? (
        <div className="empty-state small">Loading…</div>
      ) : (
        <>
          <select aria-label="Portrait Studio connection" value={connectionName} onChange={(e) => onChange(e.target.value)}>
            <option value="">(household default{activeConnection ? ` — ${activeConnection.name}` : ''})</option>
            {connections.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="model-connection-note">
            {subscribed
              ? `Every Portrait Studio LLM call (describer, generation, feedback) runs on ${subscribed.model} until you change this.`
              : 'Following the household default — change it in the Connections tab, or subscribe this Studio to one connection here.'}
          </p>
          {status && <div className="error-banner">{status}</div>}
        </>
      )}
    </div>
  );
}
