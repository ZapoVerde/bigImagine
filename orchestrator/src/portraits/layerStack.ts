/**
 * @file orchestrator/src/portraits/layerStack.ts
 * @stamp 2026-08-19
 * @architectural-role IO Wrapper — read/seed/parse the Portrait Studio layer manifest; pure
 *   helpers over an already-loaded manifest (bi_principles.md §8)
 * @description
 * The Portrait Studio's layer manifest (docs/plans/completed/portrait-studio-plan.md §Layer manifest): one
 * global JSON value under `orchestrator_settings.visual_layer_stack` (Principle 13 — runtime
 * config, not env/const; editable without a redeploy). Shape:
 * `{ layers: [{ id, label, promptable, boundary }], template }` — the five default layers
 * (`subject`, `outfit`, `style`, `expression`, `format` — the fifth added for composition/shot-type
 * framing, all `promptable: true`, each `boundary` a short
 * prose description of what belongs there and what explicitly doesn't) plus a default `template`
 * referencing each layer's `_overflow` token (its unplaced slots) and `_details` token (its
 * authored prose, visual_entities.details — docs/plans/portrait-studio-layer-details-plan.md). An
 * operator can add/remove/relabel layers afterward from Portrait Studio's "Manage Layers" panel —
 * this is what makes the system genuinely data-driven rather than hardcoded to four names; every
 * consumer reads the layer list from the manifest, never a literal `['subject','outfit','style',
 * 'expression']` constant.
 *
 * Two disclosed, deliberate exceptions to full genericity (plan §Layer manifest): `subject` is
 * the run's anchor — task-id attribution (`visual-<subjectEntityId>-<attempt>`) and episode
 * logging key off whichever entity fills it, and the manifest must always contain a `subject`
 * layer (the Manage Layers UI never offers to remove it). And `engine_params` is not a layer in
 * this manifest at all — render settings live on `image_connections`, exactly as they do for
 * locations; never prompt-facing, never part of a candidate's chromosome.
 *
 * parseLayerManifest is the pure parse (unset/corrupt → the built-in default, never throws);
 * loadLayerManifest is the IO seam — it reads the setting, seeds the default on first read
 * (logged, §11), and hands back a manifest. `visual_entities.template` (per-entity style-layer
 * template override) is resolved by the orchestrator, not here; every compileTemplate call
 * receives whichever template string applies.
 *
 * @api-declaration
 * LayerDefinition — one manifest layer: id, label, promptable, boundary
 * LayerManifest — { layers: LayerDefinition[], template }
 * DEFAULT_LAYER_MANIFEST — the built-in five-layer default (+ template)
 * parseLayerManifest(raw) -> LayerManifest — pure; unset/''/corrupt JSON → DEFAULT_LAYER_MANIFEST
 * getPromptableLayers(manifest) -> LayerDefinition[] — pure; the layers candidate chromosomes
 *   may (and must) carry slots for
 * formatLayerDefinitions(manifest) -> string — pure; boundary prose for every layer, the form the
 *   mutation prompt consumes
 * loadLayerManifest(deps) -> Promise<LayerManifest> — impure; get + seed-on-first-read + parse
 *
 * @contract
 *   assertions:
 *     purity:          helpers pure; loadLayerManifest impure (orchestrator_settings IO)
 *     state_ownership: []
 *     external_io:     [orchestrator_settings via the injected settings store]
 */

import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import { log } from '../io/logger.js';

export interface LayerDefinition {
  id: string;
  label: string;
  promptable: boolean;
  /** Short prose describing what belongs in this layer and what explicitly doesn't — fed to the
   *  mutation LLM as the layer's boundary (plan §Layer manifest). */
  boundary: string;
}

export interface LayerManifest {
  layers: LayerDefinition[];
  /** The image-prompt template for this manifest: `{{slot_name}}` tokens resolve against
   *  whichever layer owns that slot name; `{{<layerId>_overflow}}` folds a layer's unplaced
   *  slots and `{{<layerId>_details}}` places its authored prose (composer.ts). */
  template: string;
}

export const DEFAULT_LAYER_MANIFEST: LayerManifest = {
  layers: [
    {
      id: 'subject',
      label: 'Subject',
      promptable: true,
      boundary:
        'Permanent physical identity — body, face, hair, skin, distinguishing features. ' +
        'What the character IS. Never clothing, never lighting/rendering.',
    },
    {
      id: 'outfit',
      label: 'Outfit',
      promptable: true,
      boundary:
        'Current worn items — clothing, accessories, materials. What covers the subject right ' +
        'now; can change scene to scene. Never physical identity, never lighting/rendering.',
    },
    {
      id: 'style',
      label: 'Style',
      promptable: true,
      boundary:
        'Rendering treatment — medium, lighting, camera. How the image is DEPICTED, not who or ' +
        'what is in it.',
    },
    {
      id: 'expression',
      label: 'Expression',
      promptable: true,
      boundary:
        'The subject\'s facial expression and emotional state in this portrait: what the face ' +
        'conveys. Not identity features, not art style.',
    },
    {
      id: 'format',
      label: 'Format',
      promptable: true,
      boundary:
        'The composition and shot type of the render: framing, crop, camera angle, how much of ' +
        'the subject is shown (bust, waist-up, full-body), any transparency/background-intent ' +
        '(e.g. a VN/game sprite). Not the subject\'s appearance, not what they wear, not the art ' +
        'style — those belong to their own layers.',
    },
  ],
  template:
    'A portrait of {{subject_details}}, {{subject_overflow}},\n' +
    'wearing {{outfit_details}}, {{outfit_overflow}},\n' +
    'rendered in {{style_details}}, {{style_overflow}},\n' +
    'with {{expression_details}}, {{expression_overflow}}.\n' +
    'Format: {{format_details}}, {{format_overflow}}.',
};

/** Pure: unset/empty/corrupt input falls back to the built-in default — a seeded manifest is
 *  never an error (plan §Edge Cases). Also enforces the `subject` anchor: a parsed manifest
 *  without a `subject` layer is treated as corrupt (the Manage Layers UI never offers to remove
 *  it, so its absence means the value was hand-edited into an unsupported shape). */
export function parseLayerManifest(raw: unknown): LayerManifest {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_LAYER_MANIFEST;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_LAYER_MANIFEST;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_LAYER_MANIFEST;
  const candidate = parsed as { layers?: unknown; template?: unknown };
  if (!Array.isArray(candidate.layers) || typeof candidate.template !== 'string') return DEFAULT_LAYER_MANIFEST;
  const layers: LayerDefinition[] = [];
  for (const entry of candidate.layers) {
    if (typeof entry !== 'object' || entry === null) return DEFAULT_LAYER_MANIFEST;
    const layer = entry as Record<string, unknown>;
    if (typeof layer.id !== 'string' || !layer.id || typeof layer.label !== 'string' || !layer.label) {
      return DEFAULT_LAYER_MANIFEST;
    }
    if (typeof layer.promptable !== 'boolean' || typeof layer.boundary !== 'string') return DEFAULT_LAYER_MANIFEST;
    layers.push({ id: layer.id, label: layer.label, promptable: layer.promptable, boundary: layer.boundary });
  }
  if (layers.length === 0 || !layers.some((l) => l.id === 'subject')) return DEFAULT_LAYER_MANIFEST;
  return { layers, template: candidate.template };
}

/** Pure: the layers candidate chromosomes may (and must) carry slots for — every promptable
 *  layer, in manifest order. Non-promptable layers exist for the UI but never reach the prompt. */
export function getPromptableLayers(manifest: LayerManifest): LayerDefinition[] {
  return manifest.layers.filter((l) => l.promptable);
}

/** Pure: the mutation prompt's layer-boundary prose — one line per layer, the id the model must
 *  key chromosomes by and the human label + boundary prose. Deterministic, manifest order. */
export function formatLayerDefinitions(manifest: LayerManifest): string {
  return getPromptableLayers(manifest)
    .map((l) => `- ${l.id} ("${l.label}"): ${l.boundary}`)
    .join('\n');
}

export interface LayerStackDeps {
  settings: Pick<OrchestratorSettingsStore, 'get' | 'set'>;
}

/** Impure IO seam: read the manifest, seed the built-in default on first read (or on a corrupt
 *  stored value — logged, §11 — so a hand-edited setting can never wedge the subsystem into an
 *  error instead of the known-good default). */
export async function loadLayerManifest(deps: LayerStackDeps): Promise<LayerManifest> {
  const raw = await deps.settings.get('visual_layer_stack');
  if (!raw) {
    log.info('portraits: visual_layer_stack unset — seeding the default layer manifest');
    await deps.settings.set('visual_layer_stack', JSON.stringify(DEFAULT_LAYER_MANIFEST, null, 2));
    return DEFAULT_LAYER_MANIFEST;
  }
  const manifest = parseLayerManifest(raw);
  if (manifest === DEFAULT_LAYER_MANIFEST && raw.trim() !== '') {
    log.warn('portraits: stored visual_layer_stack is corrupt or missing the subject layer — using the built-in default');
  }
  return manifest;
}
