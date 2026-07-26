import { useState } from 'react';
import { ApiError, callTool } from '../../api/client';
import type { StagedAttachment } from '../../api/types';
import './StagingBar.css';

// A client-only id, never sent to the server — see ChatView's attachFiles(). Keying and per-card
// promotion state by this (rather than array index) keeps both correct when a card in the middle
// of the row is removed or mid-promotion while others are staged.
export interface StagedFile extends StagedAttachment {
  id: string;
}

interface StagingBarProps {
  attachments: StagedFile[];
  apiKey: string | null;
  onRemove: (id: string) => void;
}

type PromoteStatus = 'idle' | 'saving' | 'saved-note' | 'saved-document' | 'error';

// The row of staged-file cards between the chat history and the composer — populated by
// ChatView's file-attach button (uploadAttachment()), cleared once the message carrying them is
// sent. Nothing here is persisted server-side by default; see
// orchestrator/src/util/attachmentContext.ts's own preamble for why an attachment only ever lives
// for the one turn it's sent with. The two promotion buttons below are the opt-in exception —
// they call the same create_note/save_document tools the LLM itself can call, via the same
// generic callTool() the Notes/Documents tabs already use, so a promoted file becomes a first-
// class note or document exactly like one created any other way.
export default function StagingBar({ attachments, apiKey, onRemove }: StagingBarProps) {
  const [statusById, setStatusById] = useState<Record<string, PromoteStatus>>({});
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  if (attachments.length === 0) return null;

  async function saveToNotes(file: StagedFile) {
    setStatusById((prev) => ({ ...prev, [file.id]: 'saving' }));
    try {
      await callTool('create_note', { title: file.filename, content: file.markdown }, apiKey);
      setStatusById((prev) => ({ ...prev, [file.id]: 'saved-note' }));
    } catch (err) {
      setErrorById((prev) => ({ ...prev, [file.id]: err instanceof ApiError ? err.message : 'failed to save note' }));
      setStatusById((prev) => ({ ...prev, [file.id]: 'error' }));
    }
  }

  async function ingestToDocuments(file: StagedFile) {
    setStatusById((prev) => ({ ...prev, [file.id]: 'saving' }));
    try {
      await callTool('save_document', { title: file.filename, content_markdown: file.markdown }, apiKey);
      setStatusById((prev) => ({ ...prev, [file.id]: 'saved-document' }));
    } catch (err) {
      setErrorById((prev) => ({
        ...prev,
        [file.id]: err instanceof ApiError ? err.message : 'failed to ingest document',
      }));
      setStatusById((prev) => ({ ...prev, [file.id]: 'error' }));
    }
  }

  return (
    <div className="staging-bar">
      {attachments.map((file) => {
        const status = statusById[file.id] ?? 'idle';
        const busy = status === 'saving';
        return (
          <div key={file.id} className="staged-card">
            <div className="staged-card-info">
              <span className="staged-card-filename">{file.filename}</span>
              <span className="staged-card-meta">
                {file.meta.totalLines} line{file.meta.totalLines === 1 ? '' : 's'} ·{' '}
                {file.meta.totalChars.toLocaleString()} chars
              </span>
              {file.truncated && (
                <span className="staged-card-truncated">Truncated — only the first part of this file will be sent.</span>
              )}
              <div className="staged-card-actions">
                <button type="button" disabled={busy} onClick={() => saveToNotes(file)}>
                  {status === 'saved-note' ? 'Saved to Notes' : 'Save to Notes'}
                </button>
                <button type="button" disabled={busy} onClick={() => ingestToDocuments(file)}>
                  {status === 'saved-document' ? 'Ingested' : 'Ingest to Documents'}
                </button>
              </div>
              {status === 'error' && <span className="staged-card-error">{errorById[file.id]}</span>}
            </div>
            <button
              type="button"
              className="staged-card-remove"
              title={`Remove ${file.filename}`}
              onClick={() => onRemove(file.id)}
            >
              &times;
            </button>
          </div>
        );
      })}
    </div>
  );
}
