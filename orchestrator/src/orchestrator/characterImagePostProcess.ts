/**
 * @file orchestrator/src/orchestrator/characterImagePostProcess.ts
 * @stamp 2026-08-21
 * @architectural-role Orchestrator — shared optional BGRM post-processing for character images
 * @description
 * Applies the active BGRM engine to an already-generated character image reference. The helper
 * owns sequencing and fail-open selection only; provider request construction remains in the
 * standalone removeBackground IO adapter, and surface settings remain with their callers.
 *
 * @api-declaration
 * postProcessCharacterImage(generated, bgrmProfile?) -> Promise<CharacterImagePostProcessResult>
 *
 * @contract
 *   assertions:
 *     purity:          impure (Runware BGRM IO and diagnostic logging)
 *     state_ownership: []
 *     external_io:     [Runware via io/imageGen/removeBackground.ts]
 */

import type { ImageConnectionProfile } from '../io/imageConnections.js';
import { log } from '../io/logger.js';
import { removeBackground } from '../io/imageGen/removeBackground.js';
import type { GeneratedImage } from '../io/imageGen/types.js';

export interface CharacterImagePostProcessResult {
  imageUrl: string;
  bgrmApplied: boolean;
}

export async function postProcessCharacterImage(
  generated: GeneratedImage,
  bgrmProfile?: ImageConnectionProfile,
): Promise<CharacterImagePostProcessResult> {
  if (!bgrmProfile?.apiKey?.trim() || !bgrmProfile.model.trim() || bgrmProfile.kind !== 'runware') {
    log.warn('character image BGRM unavailable; using generated image', {
      reason: !bgrmProfile ? 'no_active_profile' : 'incomplete_or_unsupported_profile',
    });
    return { imageUrl: generated.imageUrl, bgrmApplied: false };
  }

  const source = generated.providerImageRef?.trim() || generated.imageUrl;
  try {
    const result = await removeBackground({ image: source, model: bgrmProfile.model, apiKey: bgrmProfile.apiKey });
    return { imageUrl: result.imageUrl, bgrmApplied: true };
  } catch (error) {
    log.error('character image BGRM failed; using generated image', error);
    return { imageUrl: generated.imageUrl, bgrmApplied: false };
  }
}
