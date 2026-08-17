import { useState } from 'react';
import type { PortraitCandidate } from '../../api/types';
import './PortraitCandidateGrid.css';

// The Portrait Studio round's candidate grid (docs/plans/completed/portrait-studio-plan.md §Frontend): one
// card per rendered candidate with a winner-pick action and a per-candidate 1-5 star + note field
// (collapsible note, matching SettingsView's fieldset/textarea convention). The grid owns the
// ratings/notes draft state and hands them up with the pick; the parent owns the feedback call.
// A candidate whose render failed gets a placeholder card (the error + a Retry button) instead of
// an image — rating/note/pick are meaningless with nothing to look at, so those are withheld until
// a retry succeeds (plan §Edge Cases: the row is still written, the failure is never silent).
interface PortraitCandidateGridProps {
  candidates: PortraitCandidate[];
  /** The round's goal — shown with the grid so the evaluation context survives. */
  goal: string;
  /** True once feedback has been submitted — further picks are disabled. */
  submitted: boolean;
  /** The human picked a winner: candidateId + the collected per-candidate ratings/notes. */
  onPickWinner: (candidateId: string, ratings: Record<string, number>, notes: Record<string, string>) => void;
  /** Re-render one failed candidate's stored chromosome — no new mutation call. */
  onRetry: (candidateId: string) => void;
  /** The candidateId currently mid-retry, if any — that card alone shows "Retrying…". */
  retryingId: string | null;
}

const STARS = [1, 2, 3, 4, 5];

export default function PortraitCandidateGrid({ candidates, goal, submitted, onPickWinner, onRetry, retryingId }: PortraitCandidateGridProps) {
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  return (
    <section className="portrait-grid-section">
      <header className="portrait-grid-header">
        <h3>Candidates</h3>
        <span className="portrait-grid-goal" title={goal}>
          {goal}
        </span>
      </header>
      <div className="portrait-grid">
        {candidates.map((candidate) => {
          const rating = ratings[candidate.candidateId] ?? 0;
          if (!candidate.imageUrl) {
            const retrying = retryingId === candidate.candidateId;
            return (
              <article key={candidate.candidateId} className="portrait-card portrait-card-failed">
                <div className="portrait-card-placeholder">
                  <span className="portrait-card-failed-label">Render failed</span>
                  {candidate.failed && <span className="portrait-card-failed-reason">{candidate.failed}</span>}
                </div>
                <details className="portrait-card-prompt">
                  <summary>Prompt</summary>
                  <pre>{candidate.composedPrompt}</pre>
                </details>
                <button type="button" className="portrait-card-retry" onClick={() => onRetry(candidate.candidateId)} disabled={retrying}>
                  {retrying ? 'Retrying…' : 'Retry'}
                </button>
              </article>
            );
          }
          return (
            <article key={candidate.candidateId} className="portrait-card">
              <img className="portrait-card-img" src={candidate.imageUrl} alt="Portrait candidate" />
              <details className="portrait-card-prompt">
                <summary>Prompt</summary>
                <pre>{candidate.composedPrompt}</pre>
              </details>
              <div className="portrait-card-rating" role="radiogroup" aria-label={`Rating for this candidate`}>
                {STARS.map((star) => (
                  <button
                    key={star}
                    type="button"
                    className={`portrait-star${rating >= star ? ' active' : ''}`}
                    onClick={() => setRatings((r) => ({ ...r, [candidate.candidateId]: star }))}
                    disabled={submitted}
                    aria-label={`${star} star${star === 1 ? '' : 's'}`}
                  >
                    ★
                  </button>
                ))}
                {rating > 0 && <span className="portrait-rating-value">{rating}/5</span>}
              </div>
              <details className="portrait-card-note">
                <summary>Note</summary>
                <textarea
                  rows={2}
                  value={notes[candidate.candidateId] ?? ''}
                  onChange={(e) => setNotes((n) => ({ ...n, [candidate.candidateId]: e.target.value }))}
                  disabled={submitted}
                  placeholder="Optional note for this candidate"
                />
              </details>
              <button
                type="button"
                className="portrait-card-pick"
                onClick={() => onPickWinner(candidate.candidateId, ratings, notes)}
                disabled={submitted}
              >
                {submitted ? 'Round recorded' : 'Pick as winner'}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
