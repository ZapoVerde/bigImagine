import { useCallback, useEffect, useState } from 'react';
import { callTool } from '../api/client';
import './CanonQueueView.css';

interface CanonProposal {
  factId: string;
  category: string;
  arcTag: string | null;
  summary: string;
  detail: string;
  linkedCharacterIds: string[];
  linkedLocationId: string | null;
  sceneId: string | null;
  proposedAt: string;
}

interface CanonQueueViewProps {
  apiKey: string | null;
}

// The canon-fact approval queue (canonize-plan.md §9, bi_principles.md §15) — a deliberately narrow
// view whose only job is making the human-in-the-loop approval gate usable: list proposed facts,
// approve or reject each. This is not the Inspector Canvas (spec.md §6) — the full split-screen
// character/location/rules panel is real future work once those pieces exist too. Backed entirely
// by the canonize plugin's tools via the generic callTool API (the projects/notes dual-surface
// precedent), so anything done here is equally reachable by asking the LLM in chat.
export default function CanonQueueView({ apiKey }: CanonQueueViewProps) {
  const [proposals, setProposals] = useState<CanonProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyFactId, setBusyFactId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await callTool<CanonProposal[]>('get_canon_fact_proposals', {}, apiKey);
      setProposals(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function decide(factId: string, approve: boolean) {
    setBusyFactId(factId);
    try {
      await callTool<{ factId: string; status: string }>(
        approve ? 'approve_canon_fact' : 'reject_canon_fact',
        { fact_id: factId },
        apiKey,
      );
      setProposals((prev) => (prev ? prev.filter((p) => p.factId !== factId) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyFactId(null);
    }
  }

  if (error) {
    return (
      <div className="canon-queue-view">
        <div className="error-banner">{error}</div>
        <button className="canon-refresh" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }

  if (proposals === null) {
    return <div className="canon-queue-view loading">Loading proposals&hellip;</div>;
  }

  if (proposals.length === 0) {
    return (
      <div className="canon-queue-view">
        <div className="empty-state">No canon facts awaiting approval.</div>
      </div>
    );
  }

  return (
    <div className="canon-queue-view">
      <div className="canon-queue-header">
        <span>Canon review</span>
        <button className="canon-refresh" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      <ul className="canon-proposals">
        {proposals.map((p) => (
          <li key={p.factId} className="canon-proposal">
            <div className="canon-proposal-main">
              <div className="canon-proposal-meta">
                <span className="canon-category">{p.category}</span>
                {p.arcTag ? <span className="canon-arc">arc: {p.arcTag}</span> : null}
                <span className="canon-time">{new Date(p.proposedAt).toLocaleString()}</span>
              </div>
              <div className="canon-summary">{p.summary}</div>
              {p.detail ? <div className="canon-detail">{p.detail}</div> : null}
            </div>
            <div className="canon-actions">
              <button
                className="canon-approve"
                disabled={busyFactId === p.factId}
                onClick={() => void decide(p.factId, true)}
              >
                Approve
              </button>
              <button
                className="canon-reject"
                disabled={busyFactId === p.factId}
                onClick={() => void decide(p.factId, false)}
              >
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}