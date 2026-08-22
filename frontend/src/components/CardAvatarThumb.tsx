import { useEffect, useState } from 'react';
import { fetchCardAvatarUrl } from '../api/client';

interface CardAvatarThumbProps {
  cardId: string;
  apiKey: string | null;
  className?: string;
}

// Card-owned imported media, not a runtime Character portrait. Same authenticated fetch
// shape as CharacterAvatarThumb, but hits the Card-scoped /v1/cards/:id/avatar route
// introduced alongside the canonical Cards domain.
export default function CardAvatarThumb({ cardId, apiKey, className }: CardAvatarThumbProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    fetchCardAvatarUrl(cardId, apiKey).then((result) => {
      if (cancelled) {
        if (result) URL.revokeObjectURL(result);
        return;
      }
      objectUrl = result;
      setUrl(result);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [cardId, apiKey]);

  if (!url) {
    return <div className={`character-avatar-thumb placeholder${className ? ` ${className}` : ''}`} aria-hidden="true" />;
  }
  return <img className={`character-avatar-thumb${className ? ` ${className}` : ''}`} src={url} alt="" />;
}
