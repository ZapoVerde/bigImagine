/**
 * @file orchestrator/src/util/synthesizeImagePrompt.ts
 * @stamp 2026-08-13
 * @architectural-role Pure Function — image prompt synthesis (endpoint.md §4)
 * @description
 * The prompt-synthesis engine for the Vistalyze image-generation subsystem
 * (docs/vistalyze_integration/endpoint.md §4): a pure macro-expansion module that combines a
 * location's visual description, its environment object (time of day, weather, mood, lighting),
 * the active connection's master positive style prefix, and the admin's Master Image Prompt
 * Template (the `image_prompt_template` orchestrator setting, bi_principles.md §18 — empty means
 * this module's built-in default) into the single positive prompt string sent to the image
 * provider. Pure by construction (bi_principles.md §8): identical inputs always produce identical
 * output, no IO, no randomness — the same load-bearing property the prompt-stack assembler has
 * (bi_principles.md §17), so a cache-first generation pass can rely on the synthesized prompt
 * being byte-identical for identical location state.
 *
 * The Master Image Prompt Template is expanded with simple `{{macro}}` interpolation, same
 * convention as the rest of the platform (util/interpolateMacros.ts): the five inputs the spec's
 * §4.2 lists — visual description, time of day, weather, mood/lighting atmosphere, and the
 * connection's master positive style prefix. Unknown macros are left untouched (visible in the
 * output, so a typo is diagnosable rather than silently dropped). The negative prompt is the
 * connection's master negative prompt passed straight through — the spec has no template for it.
 *
 * @api-declaration
 * DEFAULT_IMAGE_PROMPT_TEMPLATE — the built-in template used when no override is set
 * ImagePromptInput — the five expansion inputs
 * synthesizeImagePrompt(input) -> { positive, negative } — pure; expands the template
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO, no state, no randomness — deterministic given inputs)
 *     state_ownership: []
 *     external_io:     []
 */

export const DEFAULT_IMAGE_PROMPT_TEMPLATE = `{{style_prefix}} Concept Art for Video Games, {{visual_description}}, a wide angled background, cinematic lighting, high detail, uncluttered in the centre.

Style: Concept Art for Video Games, in the style of Frank Cho, comic book style.`;

/** The one seed used for every image-gen call (bg renders + the Connections test button). A
 *  fixed seed makes the same prompt deterministically produce the same image — the room's bg is
 *  canonical, never re-varied by chance, and a re-render (e.g. after row churn) is pixel-identical
 *  to the cached one. Text LLM calls stay seed-less (provider-random) so reruns/swipes vary. */
export const IMAGE_GEN_SEED = 12345;

/** A location's environment jsonb (db/migrations/0045_locations.sql) — time of day, weather, mood
 *  and lighting are the four environmental parameters endpoint.md §2.3/§4.2 names. Each may be
 *  absent; the template then expands the macro to empty rather than crashing. */
export interface ImageEnvironment {
  time_of_day?: unknown;
  weather?: unknown;
  mood?: unknown;
  lighting?: unknown;
}

export interface ImagePromptInput {
  /** The Master Image Prompt Template (orchestrator_settings.image_prompt_template); empty means
   *  use DEFAULT_IMAGE_PROMPT_TEMPLATE. */
  template: string;
  visualDescription: string;
  environment: ImageEnvironment;
  /** The active connection's master positive style prefix (endpoint.md §2.1), or ''. */
  stylePrefix: string;
  /** The active connection's master negative prompt (endpoint.md §2.1), or ''. */
  negativePrompt: string;
}

export interface SynthesizedImagePrompt {
  positive: string;
  negative: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

/** Pure macro expansion of the Master Image Prompt Template (§4.2): the five macros are
 *  {{visual_description}}, {{time_of_day}}, {{weather}}, {{mood}}, {{lighting}} and
 *  {{style_prefix}}. Unknown macros are left verbatim. Deterministic — no IO, no randomness. */
export function synthesizeImagePrompt(input: ImagePromptInput): SynthesizedImagePrompt {
  const template = input.template.trim() || DEFAULT_IMAGE_PROMPT_TEMPLATE;
  const macros: Record<string, string> = {
    visual_description: input.visualDescription,
    time_of_day: str(input.environment.time_of_day),
    weather: str(input.environment.weather),
    mood: str(input.environment.mood),
    lighting: str(input.environment.lighting),
    style_prefix: input.stylePrefix,
  };
  const positive = template.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (match, name: string) =>
    name in macros ? macros[name] : match,
  );
  return { positive, negative: input.negativePrompt };
}
