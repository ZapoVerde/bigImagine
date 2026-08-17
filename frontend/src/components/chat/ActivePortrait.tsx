/**
 * @file frontend/src/components/chat/ActivePortrait.tsx
 * @stamp 2026-08-16
 * @architectural-role Stateful Owner (bi_principles.md §8) — owns this box's own scene lookup +
 *   avatar fetch; renders a pure read-only display
 * @description
 * The small box above the RP chat showing whoever the current scene's `Present:` line named
 * first: the character whose avatar exists and is currently the scene's most narratively central
 * present character. Portrait Studio no longer writes a character's avatar at all
 * (portrait-studio-standalone-subjects-plan.md retired the old winner-promotion/set-as-avatar
 * write-back — Studio is a standalone training sandbox with no link back to `characters`), so
 * today an avatar here only ever comes from card import (`insertCharacterFromCard.ts`) or a
 * manual set; a future chat-side "regenerate this character's portrait" action is deferred (see
 * that plan's Out of Scope) and would be this box's next real data source.
 *
 * Read-only display, deliberately the simplest possible selection rule — first-listed, nothing
 * weighted or scored, a structure to prove the plumbing and refine later. It calls the same
 * chat-scoped get_scenes tool CastSection does, reads the matching scene's — now reliably
 * ordered, via presence_order (migration 0107) — characterIds, and takes the first entry; that
 * character's avatar resolves through the same fetchCharacterAvatarUrl path CharacterAvatarThumb
 * uses, with the same object-URL lifecycle.
 *
 * Renders nothing — never an error, a placeholder, or a broken-image state — when sceneId is
 * null (no header has landed yet), the scene's characterIds is empty (nobody currently present),
 * or the first-listed character has no avatar yet (the common case for an RP-born character,
 * since nothing currently sets one for them).
 *
 * @api-declaration
 * ActivePortrait({ apiKey, chatId, sceneId }) — sceneId: string | null; same props shape
 *   CastSection takes; mounted in App.tsx for the 'rp' tab only
 *
 * @contract
 *   assertions:
 *     purity:          impure (fetches, local state, object-URL lifecycle)
 *     state_ownership: [url]
 *     external_io:     [callTool: get_scenes, fetchCharacterAvatarUrl]
 */

import { useEffect, useState } from 'react';
import { callTool, fetchCharacterAvatarUrl } from '../../api/client';
import './ActivePortrait.css';

interface ActivePortraitProps {
  apiKey: string | null;
  /** The active RP chat — get_scenes is chat-scoped to it (rp-cast-infrastructure-plan.md
   *  Part B), exactly as CastSection calls it. */
  chatId: string;
  /** The active chat's scene_id cache pointer, up-reported by ChatView through App. Null = no
   *  header has landed yet. */
  sceneId: string | null;
}

interface SceneSummary {
  sceneId: string;
  name: string;
  activeLocationId: string | null;
  characterIds: string[];
}

export default function ActivePortrait({ apiKey, chatId, sceneId }: ActivePortraitProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    if (!sceneId) {
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      try {
        const rows = await callTool<SceneSummary[]>('get_scenes', {}, apiKey, chatId);
        if (cancelled) return;
        const firstId = rows.find((s) => s.sceneId === sceneId)?.characterIds?.[0];
        if (!firstId) return;
        const result = await fetchCharacterAvatarUrl(firstId, apiKey);
        if (cancelled) {
          if (result) URL.revokeObjectURL(result);
          return;
        }
        objectUrl = result;
        setUrl(result);
      } catch {
        // Read-only display — a fetch failure renders nothing, never an error state.
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [apiKey, chatId, sceneId]);

  if (!url) return null;
  return (
    <div className="active-portrait" title="Whoever the current scene's Present: line named first">
      <img className="active-portrait-img" src={url} alt="" />
    </div>
  );
}
