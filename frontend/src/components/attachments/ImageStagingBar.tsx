import type { StagedImage } from '../../api/types';
import './ImageStagingBar.css';

// A client-only id, never sent to the server — same shape as StagingBar.tsx's StagedFile, for the
// same reason (keying/removal stays correct when a card in the middle of the row is removed).
export interface StagedImageFile extends StagedImage {
  id: string;
}

interface ImageStagingBarProps {
  images: StagedImageFile[];
  onRemove: (id: string) => void;
}

// A thumbnail row, separate from StagingBar.tsx: an image has no extracted Markdown, so there's
// nothing to promote to Notes/Documents (see orchestrator/src/io/attachments/dispatchExtraction.ts's
// own preamble on why images never go through extraction at all) — just a preview and a remove
// button. Rendered alongside StagingBar between the chat history and the composer.
export default function ImageStagingBar({ images, onRemove }: ImageStagingBarProps) {
  if (images.length === 0) return null;

  return (
    <div className="image-staging-bar">
      {images.map((image) => (
        <div key={image.id} className="staged-image-card">
          <img src={image.previewUrl} alt={image.filename} className="staged-image-thumb" />
          <button
            type="button"
            className="staged-image-remove"
            title={`Remove ${image.filename}`}
            onClick={() => onRemove(image.id)}
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
