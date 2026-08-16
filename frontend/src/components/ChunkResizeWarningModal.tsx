import './ChunkResizeWarningModal.css';

interface ChunkResizeWarningModalProps {
  onCancel: () => void;
  onChangeOnly: () => void;
  onChangeAndRechunk: () => void;
}

/** docs/plans/completed/chunk-size-resize-plan.md — shown when the Chat Memory fieldset's chunk-size input
 *  is saved with a new value. The size only affects NEW chunks the sync tick / eager path write
 *  from now on; existing archives keep their old size until the one-time re-chunk backfill
 *  (orchestrator/chatChunkResize.ts) rewrites them. That pass re-summarizes + re-embeds every
 *  chunk, so it's LLM-bound and can take a while — it runs in the background and progress is
 *  polled on the RAG page. The three choices: Cancel aborts the save entirely; "Change setting
 *  only" saves the new size and leaves existing archives as they are; "Change and re-chunk now"
 *  saves and fires the backfill immediately. */
export default function ChunkResizeWarningModal({ onCancel, onChangeOnly, onChangeAndRechunk }: ChunkResizeWarningModalProps) {
  return (
    <div className="chunk-resize-warning-overlay">
      <div className="chunk-resize-warning-modal">
        <h2>Chunk size change</h2>
        <p>
          The new size only affects <strong>new</strong> chunks the sync writes from now on. Existing archives keep their
          old size until a one-time re-chunk pass rewrites them — re-summarizing and re-embedding every chunk, which runs
          in the background and can take a while.
        </p>
        <div className="chunk-resize-warning-actions">
          <button onClick={onCancel}>Cancel</button>
          <button onClick={onChangeOnly}>Change setting only</button>
          <button onClick={onChangeAndRechunk}>Change and re-chunk now</button>
        </div>
      </div>
    </div>
  );
}
