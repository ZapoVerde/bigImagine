/**
 * @file orchestrator/src/server/admin/displaySettings.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (request parsing) + IO Wrapper (settings-store IO) — the same
 * dual-role split the original adminServer.ts chat-presentation blocks used; moved here verbatim
 * as part of the adminServer domain split
 * @description
 * The Chat UI presentation settings of the Settings tab — the location-background controls
 * (parallax pan toggle, dimming veil, bubble fills) and the Text-legibility toggles (halo, outline,
 * solid code, weight bump, hover focus). Presentation configuration only: this module deliberately
 * owns none of the image-generation, location-tracking, or portrait settings — those live in their
 * own admin/ modules. Behaviour, wire keys, defaults, and public names are preserved exactly from
 * the pre-split adminServer.ts.
 *
 * @api-declaration
 * getChatBackgroundSettings(store) — the ChatView location-background controls
 *   (parallax_fade_teststep.md §2.2 + migration 0073): { parallaxEnabled, overlayOpacity,
 *   overlayShade, bubbleOpacity, bubbleUserShade, bubbleAssistantShade }, each defaulting when
 *   unset (parallax false, veil 0.5 '#000000', bubbles 0.7 '#4f46e5'/'#26272c')
 * parseSetChatBackgroundSettingsBody(raw) — validates a partial patch of those six fields;
 *   undefined on any malformed shape (non-boolean parallax, out-of-range/NaN opacity,
 *   non-#rrggbb shade, or an empty body)
 * setChatBackgroundSettings(store, patch) — upserts whichever fields the patch names
 * getChatLegibilitySettings(store) — { halo, haloStrength, outline, solidCode, weightBump,
 *   hoverFocus }, each boolean defaulting false when unset, haloStrength defaulting 0.6
 * parseSetChatLegibilitySettingsBody(raw) — validates a partial patch of those six fields;
 *   undefined on any malformed shape or an empty body
 * setChatLegibilitySettings(store, patch) — upserts whichever fields the patch names
 *
 * @contract
 *   assertions:
 *     purity:          parseSetChatBackgroundSettingsBody/parseSetChatLegibilitySettingsBody are
 *                      pure; the rest are impure (Postgres IO via the injected settings store)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected OrchestratorSettingsStore)]
 */

import type { OrchestratorSettingsStore, SettingName } from '../../io/orchestratorSettings.js';

// parallax_fade_teststep.md §2.2 + migration 0073: the ChatView location-background controls —
// the parallax pan toggle, the dimming veil ("overlay") over the location image, and the bubble
// fill. Stored as text in orchestrator_settings; unset = the defaults below. The shade defaults
// are the dark-theme bubble colors (this is a single-user build on the dark theme) — before the
// Settings fieldset is ever saved, ChatView.css falls back to the per-theme tokens, so an
// unsaved light-theme install keeps its own colors until the first save.
export interface ChatBackgroundSettings {
  parallaxEnabled: boolean;
  /** 0..1 — the veil's strength over the location background. Default 0.5, the pre-0073
   *  resting bg dimming, now a real layer so the image itself stays at full opacity. */
  overlayOpacity: number;
  /** '#rrggbb' — the veil's color. Default '#000000'. */
  overlayShade: string;
  /** 0..1 — bubble background alpha. Default 0.7, the old hardcoded rgba alpha. */
  bubbleOpacity: number;
  /** '#rrggbb' — user bubble fill. Default '#4f46e5' (dark-theme indigo). */
  bubbleUserShade: string;
  /** '#rrggbb' — assistant bubble fill. Default '#26272c' (dark-theme gray). */
  bubbleAssistantShade: string;
}

/** A partial update: every field optional, at least one present (enforced by the parser). */
export interface ChatBackgroundSettingsPatch {
  parallaxEnabled?: boolean;
  overlayOpacity?: number;
  overlayShade?: string;
  bubbleOpacity?: number;
  bubbleUserShade?: string;
  bubbleAssistantShade?: string;
}

const CHAT_BG_DEFAULTS = {
  overlayOpacity: 0.5,
  overlayShade: '#000000',
  bubbleOpacity: 0.7,
  bubbleUserShade: '#4f46e5',
  bubbleAssistantShade: '#26272c',
} as const;

function parseClampedOpacity(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function getChatBackgroundSettings(store: OrchestratorSettingsStore): Promise<ChatBackgroundSettings> {
  const [parallax, overlayOpacity, overlayShade, bubbleOpacity, bubbleUserShade, bubbleAssistantShade] = await Promise.all([
    store.get('chat_background_parallax'),
    store.get('chat_background_overlay_opacity'),
    store.get('chat_background_overlay_shade'),
    store.get('chat_background_bubble_opacity'),
    store.get('chat_background_bubble_user_shade'),
    store.get('chat_background_bubble_assistant_shade'),
  ]);
  return {
    parallaxEnabled: parallax === 'true',
    overlayOpacity: parseClampedOpacity(overlayOpacity, CHAT_BG_DEFAULTS.overlayOpacity),
    overlayShade: overlayShade ?? CHAT_BG_DEFAULTS.overlayShade,
    bubbleOpacity: parseClampedOpacity(bubbleOpacity, CHAT_BG_DEFAULTS.bubbleOpacity),
    bubbleUserShade: bubbleUserShade ?? CHAT_BG_DEFAULTS.bubbleUserShade,
    bubbleAssistantShade: bubbleAssistantShade ?? CHAT_BG_DEFAULTS.bubbleAssistantShade,
  };
}

export function parseSetChatBackgroundSettingsBody(raw: unknown): ChatBackgroundSettingsPatch | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const {
    parallaxEnabled,
    overlayOpacity,
    overlayShade,
    bubbleOpacity,
    bubbleUserShade,
    bubbleAssistantShade,
  } = raw as Record<string, unknown>;
  const isBoundedOpacity = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (parallaxEnabled !== undefined && typeof parallaxEnabled !== 'boolean') return undefined;
  if (overlayOpacity !== undefined && !isBoundedOpacity(overlayOpacity)) return undefined;
  if (bubbleOpacity !== undefined && !isBoundedOpacity(bubbleOpacity)) return undefined;
  for (const shade of [overlayShade, bubbleUserShade, bubbleAssistantShade]) {
    if (shade !== undefined && (typeof shade !== 'string' || !HEX_COLOR_RE.test(shade))) return undefined;
  }
  if (
    parallaxEnabled === undefined &&
    overlayOpacity === undefined &&
    overlayShade === undefined &&
    bubbleOpacity === undefined &&
    bubbleUserShade === undefined &&
    bubbleAssistantShade === undefined
  ) {
    return undefined;
  }
  return {
    parallaxEnabled: typeof parallaxEnabled === 'boolean' ? parallaxEnabled : undefined,
    overlayOpacity: isBoundedOpacity(overlayOpacity) ? overlayOpacity : undefined,
    overlayShade: typeof overlayShade === 'string' && HEX_COLOR_RE.test(overlayShade) ? overlayShade : undefined,
    bubbleOpacity: isBoundedOpacity(bubbleOpacity) ? bubbleOpacity : undefined,
    bubbleUserShade: typeof bubbleUserShade === 'string' && HEX_COLOR_RE.test(bubbleUserShade) ? bubbleUserShade : undefined,
    bubbleAssistantShade:
      typeof bubbleAssistantShade === 'string' && HEX_COLOR_RE.test(bubbleAssistantShade) ? bubbleAssistantShade : undefined,
  };
}

export async function setChatBackgroundSettings(store: OrchestratorSettingsStore, patch: ChatBackgroundSettingsPatch): Promise<void> {
  const writes: Array<[SettingName, string]> = [];
  if (patch.parallaxEnabled !== undefined) writes.push(['chat_background_parallax', patch.parallaxEnabled ? 'true' : 'false']);
  if (patch.overlayOpacity !== undefined) writes.push(['chat_background_overlay_opacity', String(patch.overlayOpacity)]);
  if (patch.overlayShade !== undefined) writes.push(['chat_background_overlay_shade', patch.overlayShade]);
  if (patch.bubbleOpacity !== undefined) writes.push(['chat_background_bubble_opacity', String(patch.bubbleOpacity)]);
  if (patch.bubbleUserShade !== undefined) writes.push(['chat_background_bubble_user_shade', patch.bubbleUserShade]);
  if (patch.bubbleAssistantShade !== undefined) writes.push(['chat_background_bubble_assistant_shade', patch.bubbleAssistantShade]);
  for (const [key, value] of writes) await store.set(key, value);
}

/**
 * The ChatView "Text legibility" toggles (migrations 0074 + 0075) — opt-in text-rendering
 * tricks for prose on translucent bubbles over the location background, exposed as a collapsible
 * menu in the chat settings rail (components/chat/LegibilityMenu.tsx). Each toggle is stored as
 * text ('true'/'false'), default false when unset; the halo strength dial (0075) is text
 * '0'..'1', default 0.6 — opt-in, so an untouched install keeps the built-in look exactly. Household-wide settings: one set applies to every chat. The frontend reads them
 * live at chat load (GET /v1/chat-legibility-settings, same no-restart shape as
 * household_timezone) and applies them as data-legibility tokens on the chat view root; the CSS
 * rule sets of the same names (ChatView.css) key off [data-legibility~=…]. The menu POSTs each
 * toggle immediately (partial patch, admin-gated) — no Save button.
 */
export interface ChatLegibilitySettings {
  /** text-shadow halo ring around bubble prose (subtitle-renderer trick). */
  halo: boolean;
  /** 0..1 — the halo ring's intensity (migration 0075), default 0.6 when unset; applied as a
   *  color-mix percentage over the per-theme halo colors (their own alpha preserved, strength
   *  multiplied on top), so 0 = invisible ring, 1 = the full-force ring. */
  haloStrength: number;
  /** crisp 0.5px -webkit-text-stroke on quoted dialogue, headings, <summary>. */
  outline: boolean;
  /** solid near-black code chips + <pre> blocks with light text. */
  solidCode: boolean;
  /** font-weight 500 on em/i, blockquotes, and pending bubbles' muted text. */
  weightBump: boolean;
  /** hovering a bubble raises its fill opacity to 92% just for that message. */
  hoverFocus: boolean;
}

/** A partial update: every field optional, at least one present (enforced by the parser). */
export interface ChatLegibilitySettingsPatch {
  halo?: boolean;
  haloStrength?: number;
  outline?: boolean;
  solidCode?: boolean;
  weightBump?: boolean;
  hoverFocus?: boolean;
}

export async function getChatLegibilitySettings(store: OrchestratorSettingsStore): Promise<ChatLegibilitySettings> {
  const [halo, haloStrength, outline, solidCode, weightBump, hoverFocus] = await Promise.all([
    store.get('chat_legibility_halo'),
    store.get('chat_legibility_halo_strength'),
    store.get('chat_legibility_outline'),
    store.get('chat_legibility_solid_code'),
    store.get('chat_legibility_weight'),
    store.get('chat_legibility_hover_focus'),
  ]);
  return {
    halo: halo === 'true',
    haloStrength: parseClampedOpacity(haloStrength, 0.6),
    outline: outline === 'true',
    solidCode: solidCode === 'true',
    weightBump: weightBump === 'true',
    hoverFocus: hoverFocus === 'true',
  };
}

export function parseSetChatLegibilitySettingsBody(raw: unknown): ChatLegibilitySettingsPatch | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { halo, haloStrength, outline, solidCode, weightBump, hoverFocus } = raw as Record<string, unknown>;
  const isBoundedOpacity = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (halo !== undefined && typeof halo !== 'boolean') return undefined;
  if (haloStrength !== undefined && !isBoundedOpacity(haloStrength)) return undefined;
  if (outline !== undefined && typeof outline !== 'boolean') return undefined;
  if (solidCode !== undefined && typeof solidCode !== 'boolean') return undefined;
  if (weightBump !== undefined && typeof weightBump !== 'boolean') return undefined;
  if (hoverFocus !== undefined && typeof hoverFocus !== 'boolean') return undefined;
  if (
    halo === undefined &&
    haloStrength === undefined &&
    outline === undefined &&
    solidCode === undefined &&
    weightBump === undefined &&
    hoverFocus === undefined
  ) {
    return undefined;
  }
  return {
    halo: typeof halo === 'boolean' ? halo : undefined,
    haloStrength: isBoundedOpacity(haloStrength) ? haloStrength : undefined,
    outline: typeof outline === 'boolean' ? outline : undefined,
    solidCode: typeof solidCode === 'boolean' ? solidCode : undefined,
    weightBump: typeof weightBump === 'boolean' ? weightBump : undefined,
    hoverFocus: typeof hoverFocus === 'boolean' ? hoverFocus : undefined,
  };
}

export async function setChatLegibilitySettings(store: OrchestratorSettingsStore, patch: ChatLegibilitySettingsPatch): Promise<void> {
  const writes: Array<[SettingName, string]> = [];
  if (patch.halo !== undefined) writes.push(['chat_legibility_halo', patch.halo ? 'true' : 'false']);
  if (patch.haloStrength !== undefined) writes.push(['chat_legibility_halo_strength', String(patch.haloStrength)]);
  if (patch.outline !== undefined) writes.push(['chat_legibility_outline', patch.outline ? 'true' : 'false']);
  if (patch.solidCode !== undefined) writes.push(['chat_legibility_solid_code', patch.solidCode ? 'true' : 'false']);
  if (patch.weightBump !== undefined) writes.push(['chat_legibility_weight', patch.weightBump ? 'true' : 'false']);
  if (patch.hoverFocus !== undefined) writes.push(['chat_legibility_hover_focus', patch.hoverFocus ? 'true' : 'false']);
  for (const [key, value] of writes) await store.set(key, value);
}