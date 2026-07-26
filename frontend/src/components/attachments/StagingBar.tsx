import type { StagedAttachment } from '../../api/types';
import './StagingBar.css';

interface StagingBarProps {
  attachments: StagedAttachment[];
  onRemove: (index: number) => void;
}

// The row of staged-file cards between the chat history and the composer — populated by
// ChatView's file-attach button (uploadAttachment()), cleared once the message carrying them is
// sent. Nothing here is persisted; see orchestrator/src/util/attachmentContext.ts's own preamble
// for why an attachment only ever lives for the one turn it's sent with.
export default function StagingBar({ attachments, onRemove }: StagingBarProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="staging-bar">
      {attachments.map((a, i) => (
        <div key={`${a.filename}-${i}`} className="staged-card">
          <div className="staged-card-info">
            <span className="staged-card-filename">{a.filename}</span>
            <span className="staged-card-meta">
              {a.meta.totalLines} line{a.meta.totalLines === 1 ? '' : 's'} · {a.meta.totalChars.toLocaleString()} chars
            </span>
            {a.truncated && (
              <span className="staged-card-truncated">Truncated — only the first part of this file will be sent.</span>
            )}
          </div>
          <button
            type="button"
            className="staged-card-remove"
            title={`Remove ${a.filename}`}
            onClick={() => onRemove(i)}
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
