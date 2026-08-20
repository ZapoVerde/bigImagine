import type { ChatMemorySyncStatusRow } from '../api/types';
import './ChatMemorySyncErrorModal.css';

interface ChatMemorySyncErrorModalProps {
  row: ChatMemorySyncStatusRow;
  onClose: () => void;
}

/** The review panel's error-detail popup (bi_principles.md §11): last_error alone names what broke,
 *  but not what the model actually said — for a malformed-output failure (bridge/distill/curator/
 *  chunk-summary parse throw), lastErrorPromptName names the Settings-tab prompt worth tuning and
 *  lastErrorLlmReply is the model's raw completion text, untouched. Both are null for a non-parse
 *  failure (an HTTP/transport error has no "reply" to show) — the modal still surfaces the step and
 *  message in that case, just without the extra sections. */
export default function ChatMemorySyncErrorModal({ row, onClose }: ChatMemorySyncErrorModalProps) {
  return (
    <div className="sync-error-modal-overlay" onClick={onClose}>
      <div className="sync-error-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sync-error-modal-header">
          <h2>{row.chatTitle}</h2>
          <button className="sync-error-modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <dl className="sync-error-modal-meta">
          <dt>Step</dt>
          <dd>{row.lastStep ?? 'unknown'}</dd>
          {row.lastErrorPromptName && (
            <>
              <dt>Prompt</dt>
              <dd>
                <code>{row.lastErrorPromptName}</code>
              </dd>
            </>
          )}
          <dt>Last attempt</dt>
          <dd>{new Date(row.lastAttemptAt).toLocaleString()}</dd>
          <dt>Consecutive errors</dt>
          <dd>{row.consecutiveErrors}</dd>
        </dl>
        <div className="sync-error-modal-message">{row.lastError ?? '(no error message recorded)'}</div>
        {row.lastErrorLlmReply && (
          <>
            <h3>Raw model reply</h3>
            <pre className="sync-error-modal-reply">{row.lastErrorLlmReply}</pre>
          </>
        )}
      </div>
    </div>
  );
}
