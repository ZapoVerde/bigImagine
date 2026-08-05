import { useEffect, useState } from 'react';
import { fetchChubAvatarUrl } from '../api/client';

interface ChubAvatarThumbProps {
  avatarUrl: string;
  apiKey: string | null;
  className?: string;
}

// Same authenticated-blob-fetch shape as CharacterAvatarThumb.tsx, for a chub.ai search result's
// avatar_url instead of a stored character's own avatar — a plain <img src> can't carry the
// household-key Authorization header the server-side chub-avatar route requires.
export default function ChubAvatarThumb({ avatarUrl, apiKey, className }: ChubAvatarThumbProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    fetchChubAvatarUrl(avatarUrl, apiKey).then((result) => {
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
  }, [avatarUrl, apiKey]);

  if (!url) {
    return <div className={`chub-avatar-thumb placeholder${className ? ` ${className}` : ''}`} aria-hidden="true" />;
  }
  return <img className={`chub-avatar-thumb${className ? ` ${className}` : ''}`} src={url} alt="" />;
}
