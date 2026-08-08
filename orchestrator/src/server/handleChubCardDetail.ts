/**
 * @file orchestrator/src/server/handleChubCardDetail.ts
 * @stamp 2026-08-14
 * @architectural-role IO Wrapper — fetches and normalizes a chub.ai character's full card detail
 * @description
 * The backend for BrowseChubView.tsx's card modal: clicking a search-result card lazily fetches
 * what chub's search API doesn't return — the full `description` and chub's bespoke `definition`
 * object (first_message / example_dialogs / personality / ...), plus `max_res_url`, the URL of
 * the card PNG itself. Same route family as httpServer.ts's chub-avatar proxy and the same
 * pia-proxy tunnel (chub.ai blocks Australian IPs — see io/piaProxyFetch.ts), split out of
 * httpServer.ts the same way toolInvoke.ts / handleUploadAttachment.ts are: this module never
 * touches the raw ServerResponse or calls authenticate() itself — it returns a plain {status,
 * body} pair for httpServer.ts's thin authenticated route to send.
 *
 * fullPath is validated before it ever reaches the URL builder: it arrives as a raw browser query
 * param, so unlike the plugin tools (which only ever see a tool-call argument), it is untrusted
 * input at this seam. Rejects anything that isn't a plain `creator/slug` path — no query
 * strings, fragments, whitespace, or dot segments.
 *
 * @api-declaration
 * fetchChubCardDetail(settings, fullPath) — GETs
 *   https://api.chub.ai/api/characters/<fullPath>?full=true through pia-proxy and normalizes the
 *   response node into the ChubCardDetail shape; throws ChubDetailError with an HTTP-ish status
 * handleChubCardDetail(req, deps) — reads ?fullPath=, validates it, dispatches to
 *   fetchChubCardDetail, and returns {status, body} for httpServer.ts to send
 *
 * @contract
 *   assertions:
 *     purity:          impure (network IO via pia-proxy)
 *     state_ownership: []
 *     external_io:     [pia-proxy (and, through it, api.chub.ai)]
 */

import type { IncomingMessage } from 'node:http';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import { fetchThroughPiaProxy } from '../io/piaProxyFetch.js';
import { log } from '../io/logger.js';

// Thrown by fetchChubCardDetail so handleChubCardDetail can map it to an HTTP status without
// string-matching on error messages. `status` is what the upstream fetch or the URL shape
// dictates (e.g. chub's own 404 when a character was removed); 502 is reserved for the network
// failure path, which is caught separately.
export class ChubDetailError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

// The subset of chub's GET /api/characters/<fullPath>?full=true node shape this route surfaces.
// Every field is optional because chub's own search-node normalization (searchChubCharactersTool.ts)
// treats each as optional too; fields missing from the response normalize to their neutral value.
interface ChubDetailNode {
  fullPath?: string;
  name?: string;
  tagline?: string;
  description?: string;
  avatar_url?: string;
  max_res_url?: string;
  definition?: unknown;
  topics?: unknown;
  starCount?: unknown;
  rating?: unknown;
  ratingCount?: unknown;
  nChats?: unknown;
  nMessages?: unknown;
  n_favorites?: unknown;
  nTokens?: unknown;
  forksCount?: unknown;
  createdAt?: unknown;
  lastActivityAt?: unknown;
  verified?: unknown;
  recommended?: unknown;
  hasGallery?: unknown;
}

export interface ChubCardDetail {
  fullPath: string;
  name: string;
  tagline: string;
  description: string;
  avatarUrl: string;
  /** URL of the card PNG itself (same avatars.charhub.io CDN the chub-avatar route allows) —
   *  what the modal's Download button fetches. Empty string when the detail response lacks it. */
  maxResUrl: string;
  /** chub's bespoke definition object (first_message / example_dialogs / personality / ...),
   *  passed through as-is for the frontend to render one labeled text box per key. */
  definition: Record<string, unknown>;
  topics: string[];
  starCount: number;
  rating: number;
  ratingCount: number;
  nChats: number;
  nMessages: number;
  nFavorites: number;
  nTokens: number;
  forksCount: number;
  createdAt: string;
  lastActivityAt: string;
  verified: boolean;
  recommended: boolean;
  hasGallery: boolean;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// A plain creator/slug path (chub.ai's own URL shape) — the only thing this route ever lets reach
// the URL builder. Rejects query strings, fragments, whitespace, backslashes, NUL, and percent
// signs: an encoded `%2e%2e` or `%0a` must not get a second chance to mean something after a
// downstream decode, and a literal `%` is never part of a real chub slug anyway. Dot segments
// (`.` / `..`) are rejected separately below.
export function isValidChubFullPath(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  if (/[?#\s\\%\u0000]/.test(value)) return false;
  const segments = value.split('/');
  return segments.length >= 1 && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export async function fetchChubCardDetail(
  settings: OrchestratorSettingsStore,
  fullPath: string,
): Promise<ChubCardDetail> {
  if (!isValidChubFullPath(fullPath)) {
    throw new ChubDetailError(`"${fullPath}" is not a valid chub.ai fullPath (expected creator/slug)`, 400);
  }

  const response = await fetchThroughPiaProxy(settings, `https://api.chub.ai/api/characters/${fullPath}?full=true`);
  if (!response.ok) {
    throw new ChubDetailError(`chub.ai lookup for "${fullPath}" failed with HTTP ${response.status}`, response.status);
  }

  const body = (await response.json()) as { node?: ChubDetailNode };
  const node = body.node;
  if (!node) {
    throw new ChubDetailError(`chub.ai has no detail node for "${fullPath}" (character not found or removed)`, 404);
  }

  const definition = asRecord(node.definition);
  log.info('fetched chub card detail', {
    fullPath,
    name: asString(node.name),
    hasDescription: asString(node.description).length > 0,
    definitionKeys: Object.keys(definition),
  });

  return {
    fullPath: asString(node.fullPath) || fullPath,
    name: asString(node.name),
    tagline: asString(node.tagline),
    description: asString(node.description),
    avatarUrl: asString(node.avatar_url),
    maxResUrl: asString(node.max_res_url),
    definition,
    topics: asStringArray(node.topics),
    starCount: asNumber(node.starCount),
    rating: asNumber(node.rating),
    ratingCount: asNumber(node.ratingCount),
    nChats: asNumber(node.nChats),
    nMessages: asNumber(node.nMessages),
    nFavorites: asNumber(node.n_favorites),
    nTokens: asNumber(node.nTokens),
    forksCount: asNumber(node.forksCount),
    createdAt: asString(node.createdAt),
    lastActivityAt: asString(node.lastActivityAt),
    verified: asBoolean(node.verified),
    recommended: asBoolean(node.recommended),
    hasGallery: asBoolean(node.hasGallery),
  };
}

export async function handleChubCardDetail(
  req: IncomingMessage,
  deps: { settings: OrchestratorSettingsStore },
): Promise<{ status: number; body: unknown }> {
  const fullPath = new URL(req.url ?? '', 'http://placeholder').searchParams.get('fullPath') ?? '';
  if (!isValidChubFullPath(fullPath)) {
    return { status: 400, body: { error: 'missing or invalid fullPath query param (expected a chub.ai creator/slug path)' } };
  }

  try {
    return { status: 200, body: await fetchChubCardDetail(deps.settings, fullPath) };
  } catch (err) {
    if (err instanceof ChubDetailError) {
      return { status: err.status, body: { error: err.message } };
    }
    log.error('chub card detail fetch failed', err);
    return { status: 502, body: { error: err instanceof Error ? err.message : 'chub card detail fetch failed' } };
  }
}
