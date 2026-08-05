import { useEffect, useState } from 'react';
import { fetchCharacterAvatarUrl } from '../api/client';

interface CharacterAvatarThumbProps {
  characterId: string;
  apiKey: string | null;
  className?: string;
}

// A character's avatar needs an authenticated fetch, not a plain <img src> (see
// fetchCharacterAvatarUrl's own note — a 'key'-mode session's Authorization header can't travel on
// an <img> tag). This owns the resulting object URL's lifecycle: fetch on mount/id change, revoke
// on unmount or before fetching the next one, so CharactersView's list rows don't each have to
// manage that bookkeeping themselves.
export default function CharacterAvatarThumb({ characterId, apiKey, className }: CharacterAvatarThumbProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    fetchCharacterAvatarUrl(characterId, apiKey).then((result) => {
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
  }, [characterId, apiKey]);

  if (!url) {
    return <div className={`character-avatar-thumb placeholder${className ? ` ${className}` : ''}`} aria-hidden="true" />;
  }
  return <img className={`character-avatar-thumb${className ? ` ${className}` : ''}`} src={url} alt="" />;
}
