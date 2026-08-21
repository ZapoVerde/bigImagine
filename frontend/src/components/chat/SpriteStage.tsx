import { useEffect, useRef, useState } from 'react';
import { getChatCharacterSprites } from '../../api/client';
import type { CharacterSpriteState } from '../../api/types';
import './SpriteStage.css';

export interface SpriteStageProps {
  apiKey: string | null;
  chatId: string;
  /** Bump to trigger refetch (e.g., after turn completion or swipe) */
  refreshToken?: number | string;
  /** When false, component is inactive (hidden tab) — skip fetching/polling */
  active?: boolean;
  selectedSwipeId?: string | null;
  selectedMessageId?: string | null;
}

const POLL_INTERVAL_MS = 3000;
const MAX_RETRIES = 10;

export function SpriteStage({ apiKey, chatId, refreshToken, active = true, selectedSwipeId, selectedMessageId }: SpriteStageProps) {
  const [sprites, setSprites] = useState<CharacterSpriteState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const retryCountRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    if (!chatId) return;
    let cancelled = false;

    function clearTimer() {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    async function fetchSprites() {
      try {
        const data = await getChatCharacterSprites(chatId, apiKey, {
          selectedSwipeId: selectedSwipeId ?? undefined,
          selectedMessageId: selectedMessageId ?? undefined,
        });
        if (cancelled) return;
        setSprites(data);
        setError(null);

        const hasPending = data.some((s) => s.imageUrl === null);
        if (hasPending && retryCountRef.current < MAX_RETRIES && active) {
          retryCountRef.current += 1;
          clearTimer();
          timerRef.current = window.setTimeout(() => {
            if (!cancelled && active) fetchSprites();
          }, POLL_INTERVAL_MS);
        } else {
          // Resolved or max retries — stop
          clearTimer();
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        if (retryCountRef.current < MAX_RETRIES && active) {
          retryCountRef.current += 1;
          clearTimer();
          timerRef.current = window.setTimeout(() => {
            if (!cancelled && active) fetchSprites();
          }, POLL_INTERVAL_MS);
        }
      }
    }

    // Reset retry on explicit refresh or chat change
    retryCountRef.current = 0;
    clearTimer();
    fetchSprites();

    return () => {
      cancelled = true;
      clearTimer();
    };
  }, [apiKey, chatId, refreshToken, active, selectedSwipeId, selectedMessageId]);

  // Filter to available imagery, but keep order; limit to 3 visible
  const visible = sprites.filter((s) => !!s.imageUrl).slice(0, 3);
  const count = visible.length;

  if (!active) return null;
  if (error) {
    // Fail soft — stage remains transparent, no fatal render
    return <div className="sprite-stage sprite-stage--error" aria-hidden="true" />;
  }
  if (count === 0) {
    return <div className="sprite-stage sprite-stage--empty" aria-hidden="true" />;
  }

  const layoutClass =
    count === 1 ? 'sprite-stage--one' : count === 2 ? 'sprite-stage--two' : 'sprite-stage--three';

  return (
    <div className={`sprite-stage ${layoutClass}`} aria-hidden="true">
      <div className="sprite-stage__slots">
        {visible.map((s) => (
          <div key={s.characterId} className="sprite-stage__slot">
            <img
              src={s.imageUrl!}
              alt={s.name}
              className="sprite-stage__img"
              loading="lazy"
              draggable={false}
            />
            <span className="sprite-stage__name">{s.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default SpriteStage;
