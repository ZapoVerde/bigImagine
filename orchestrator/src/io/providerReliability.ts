/**
 * @file orchestrator/src/io/providerReliability.ts
 * @stamp 2026-08-16
 * @architectural-role IO Wrapper — background provider-reliability sweep for OpenRouter routing
 * @description
 * The server-side form of scripts/probe-provider-reliability.mjs: instead of a hardcoded provider
 * list run from the CLI, this runs a sweep against the live provider catalog for one saved
 * connection's model (openaiCompatible.ts's listProviders), firing one isolated probe per provider
 * ({ provider: { order: [name], allow_fallbacks: false } } — the exact request shape pinning sends,
 * plus provider.quantizations when the sweep is run under a quantization filter) and recording how
 * many attempts actually produced content. A reasoning-capable model routed
 * through OpenRouter can silently return finish_reason "stop" with zero content and zero reasoning
 * tokens, and how often that happens turned out to depend entirely on which upstream provider
 * OpenRouter picked (2026-08-16 investigation); this is the "which providers are good today"
 * measurement, kept re-runnable rather than hardcoded because the answer drifts.
 *
 * Scheduling is built for the failure mode the CLI probe tripped over: hammering providers
 * back-to-back tripped 429s on BaseTen/AkashML/Io Net and made their real reliability unreadable.
 * So attempts are paced to one start every delayMs (default 2s), round-robin interleaved across
 * providers (one BaseTen, then one AkashML — never all of BaseTen then all of AkashML), and no
 * provider is ever probed twice while its previous attempt is still in flight: a hung provider
 * can't wedge the sweep, because the next provider's attempt starts on schedule regardless. Each
 * attempt carries its own AbortController timeout so a provider that accepts the request but never
 * streams a byte is scored a failure, not left to stall the sweep forever.
 *
 * In-memory only, keyed by connection id — a diagnostic, not durable state; a restart loses any
 * in-flight sweep (fine: a sweep is cheap enough to just re-run). The same state object is mutated
 * in place as attempts land, so GET /v1/admin/connections/:id/reliability reads a live partial
 * result instead of waiting for the whole sweep to finish.
 *
 * @api-declaration
 * startProviderReliabilitySweep(connections, connectionId, params?) — resolves the connection,
 *   pulls the live provider list, and starts the background sweep; returns the initial state, or a
 *   discriminated error reason: the connection is gone (not_found), the connection has no provider
 *   catalog to sweep (no_provider_catalog — every non-OpenRouter kind), or a sweep is already
 *   running (already_running)
 * getProviderReliabilitySweep(connectionId) — the live state, undefined when no sweep has ever run
 * stopProviderReliabilitySweep(connectionId) — stops an in-flight sweep: marks the state
 *   'cancelled' and aborts every live probe (each in-flight attempt then records a 'cancelled'
 *   note, never an ok), so a sweep hammering a 429-prone provider can be stopped from the UI;
 *   idempotent — a finished sweep is returned unchanged — and undefined when no sweep exists
 * ProviderReliabilityRow / ProviderReliabilityAttempt / ReliabilitySweepState — the wire shapes the
 *   Connections tab renders (ok/total per provider, per-attempt notes, live status)
 *
 * @contract
 *   assertions:
 *     purity:          impure (network calls)
 *     state_ownership: [the module-level sweeps map]
 *     external_io:     [an OpenAI-compatible chat completions API, its /models/{id}/endpoints]
 */

import type { LlmConnectionStore } from './llmConnections.js';
import { createLlmProviderForProfile } from './llm/index.js';
import type { LlmProfile } from './llm/profiles.js';
import { log } from './logger.js';

export interface ProviderReliabilityAttempt {
  ok: boolean;
  note: string;
}

export interface ProviderReliabilityRow {
  name: string;
  tag: string;
  ok: number;
  total: number;
  attempts: ProviderReliabilityAttempt[];
  /** OpenRouter's published per-token price for this provider+model endpoint, carried over from
   *  the catalog so the Connections tab can render in/out cost next to the reliability tally —
   *  the "which one am I after" signal. Undefined when the catalog reported none. */
  pricing?: { prompt: string; completion: string };
}

export interface ReliabilitySweepState {
  connectionId: string;
  model: string;
  status: 'running' | 'done' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  attemptsPerProvider: number;
  delayMs: number;
  /** The quantization filter this sweep was run under (e.g. ["int8"]), forwarded as
   *  provider.quantizations on every probe — so results reflect the int8-serving path, not
   *  whatever quantizations OpenRouter's default routing would have used. Undefined = unfiltered. */
  quantizations?: string[];
  providers: ProviderReliabilityRow[];
}

export interface ReliabilitySweepParams {
  attemptsPerProvider?: number;
  delayMs?: number;
  requestTimeoutMs?: number;
  /** Filter the sweep to providers that serve one of these quantization formats (e.g. ["int8"]).
   *  Other providers are excluded from the sweep entirely — never probed into a guaranteed 404.
   *  An empty or absent array leaves the sweep unfiltered (the whole catalog runs). */
  quantizations?: string[];
}

export type StartReliabilitySweepResult =
  | { ok: true; state: ReliabilitySweepState }
  | { ok: false; reason: 'not_found' | 'no_provider_catalog' | 'already_running' };

const sweeps = new Map<string, ReliabilitySweepState>();

// Live AbortControllers for every in-flight probe, keyed by connection id — what
// stopProviderReliabilitySweep aborts to cut a sweep short. Entries exist only while a sweep is
// running (created at start, cleared on 'done' and on stop), and each probe deletes its own
// controller from the set in its finally, so the set can never grow stale.
const activeControllers = new Map<string, Set<AbortController>>();

// The same fixed, innocuous, synthetic prompt scripts/probe-provider-reliability.mjs sends — never
// real chat/character content, so the sweep is safe to fire at any time without touching private
// data (bb_principles.md §17: prompts are surfaced, never hidden — and this one carries nothing).
const INNOCUOUS_PROMPT =
  'You are a friendly narrator for a cozy slice-of-life story about a baker in a small town ' +
  'preparing for the weekend market. Write a short, warm opening paragraph introducing the ' +
  'bakery on a sunny morning.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One isolated probe: pin routing to exactly this one provider (provider.order: [name],
// allow_fallbacks: false) and measure whether content actually streams back — the same request
// shape the sweep is measuring, and the same empty-vs-content signal the CLI probe used. Plain
// fetch, no retry (fetchWithRetry): the point is to score this one attempt honestly, and retrying
// would just double-bill while hiding a provider's real failure rate. Never throws — every failure
// mode lands in the row's attempts list as a { ok: false, note } entry.
async function probeOnce(
  profile: LlmProfile,
  state: ReliabilitySweepState,
  row: ProviderReliabilityRow,
  requestTimeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  activeControllers.get(state.connectionId)?.add(controller);
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  let attempt: ProviderReliabilityAttempt;
  try {
    const response = await fetch(`${profile.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${profile.apiKey}` },
      body: JSON.stringify({
        model: profile.model,
        max_tokens: 16384,
        messages: [{ role: 'system', content: INNOCUOUS_PROMPT }],
        provider: {
          order: [row.name],
          allow_fallbacks: false,
          ...(state.quantizations && state.quantizations.length > 0
            ? { quantizations: state.quantizations }
            : {}),
        },
        reasoning: { exclude: true },
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      attempt = { ok: false, note: `HTTP ${response.status}` };
    } else {
      const text = await response.text();
      const lines = text.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
      let contentLen = 0;
      for (const line of lines) {
        try {
          const chunk = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: unknown } }[] };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') contentLen += delta.length;
        } catch {
          // non-JSON SSE line — ignore, matches openaiCompatible.ts's own handling
        }
      }
      attempt = { ok: contentLen > 0, note: contentLen > 0 ? `${contentLen} chars` : 'empty' };
    }
  } catch (err) {
    // A controller aborts for two distinct reasons — the per-attempt timeout, or the admin
    // stopping the sweep. stopProviderReliabilitySweep flips status to 'cancelled' before it
    // aborts, so the note tells them apart here: a stop scores 'cancelled', a timeout its ms.
    attempt =
      err instanceof Error && err.name === 'AbortError'
        ? state.status === 'cancelled'
          ? { ok: false, note: 'cancelled' }
          : { ok: false, note: `timed out after ${requestTimeoutMs}ms` }
        : { ok: false, note: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
    activeControllers.get(state.connectionId)?.delete(controller);
  }
  row.attempts.push(attempt);
  row.total += 1;
  if (attempt.ok) row.ok += 1;
  log.info(
    `provider reliability: ${profile.model} via "${row.name}" — ${attempt.ok ? 'ok' : 'failed'} (${attempt.note}), ${row.ok}/${row.total}`,
  );
}

// The background sweep driver. Round-robin interleave with a start cadence: scan providers in order
// from a rotating cursor, fire the first one that isn't done and isn't already in flight, then wait
// delayMs before the next start. A provider whose attempt is still running is skipped for this tick
// and picked up again on a later one — the interleave keeps hammering a 429-prone provider from
// making a healthy neighbor's numbers unreadable, and max-one-in-flight keeps the per-provider
// attempts sequential so a slow provider's score isn't contaminated by concurrent load. When every
// provider has its full attempt count, the sweep flips to 'done' and the state freezes for the last
// GET to read.
async function runSweep(profile: LlmProfile, state: ReliabilitySweepState, requestTimeoutMs: number): Promise<void> {
  const rows = state.providers;
  const attemptsPerProvider = state.attemptsPerProvider;
  const delayMs = state.delayMs;
  const inFlight = new Set<string>();
  let cursor = 0;

  while (state.status === 'running') {
    let fired = false;
    for (let offset = 0; offset < rows.length; offset++) {
      const row = rows[(cursor + offset) % rows.length]!;
      if (row.total >= attemptsPerProvider || inFlight.has(row.tag)) continue;
      cursor = (cursor + offset + 1) % rows.length;
      inFlight.add(row.tag);
      void probeOnce(profile, state, row, requestTimeoutMs).finally(() => inFlight.delete(row.tag));
      fired = true;
      break;
    }
    if (!fired) {
      if (rows.every((r) => r.total >= attemptsPerProvider)) {
        state.status = 'done';
        state.finishedAt = Date.now();
        activeControllers.delete(state.connectionId); // all probes resolved — nothing left to abort
        return;
      }
      // everything left is in flight — yield a tick so those probes can resolve
      await sleep(50);
      continue;
    }
    await sleep(delayMs);
  }
}

export async function startProviderReliabilitySweep(
  connections: LlmConnectionStore,
  connectionId: string,
  params: ReliabilitySweepParams = {},
): Promise<StartReliabilitySweepResult> {
  const existing = sweeps.get(connectionId);
  if (existing?.status === 'running') return { ok: false, reason: 'already_running' };

  const profile = await connections.resolveById(connectionId);
  if (!profile) return { ok: false, reason: 'not_found' };

  const provider = createLlmProviderForProfile(profile);
  if (!provider.listProviders) return { ok: false, reason: 'no_provider_catalog' };

  // Pull the live catalog up front (before the background sweep starts) so a connection that can't
  // list providers — a native DeepSeek endpoint 404s on /models/{id}/endpoints — is rejected
  // immediately instead of starting a sweep that dies on its first probe.
  let catalog;
  try {
    catalog = await provider.listProviders(profile.model);
  } catch (err) {
    log.warn(`provider reliability sweep: failed to list providers for connection "${connectionId}"`, err);
    return { ok: false, reason: 'no_provider_catalog' };
  }

  const quantizations =
    params.quantizations && params.quantizations.length > 0 ? params.quantizations : undefined;
  const state: ReliabilitySweepState = {
    connectionId,
    model: profile.model,
    status: 'running',
    startedAt: Date.now(),
    attemptsPerProvider: params.attemptsPerProvider ?? 3,
    delayMs: params.delayMs ?? 2000,
    quantizations,
    // A quantization filter narrows the sweep to providers that actually serve it — probing the
    // others would just collect OpenRouter's 404 ("no endpoint matches this quantization") and
    // muddy the tally. Unfiltered runs the whole catalog.
    providers: (
      quantizations
        ? catalog.filter((p) => p.quantization && quantizations.includes(p.quantization))
        : catalog
    ).map((p) => ({
      name: p.name,
      tag: p.tag,
      ok: 0,
      total: 0,
      attempts: [],
      ...(p.pricing ? { pricing: p.pricing } : {}),
    })),
  };
  sweeps.set(connectionId, state);
  activeControllers.set(connectionId, new Set());
  void runSweep(profile, state, params.requestTimeoutMs ?? 30000);
  return { ok: true, state };
}

export function getProviderReliabilitySweep(connectionId: string): ReliabilitySweepState | undefined {
  return sweeps.get(connectionId);
}

/** Stop a running sweep: flip the state to 'cancelled' and abort every in-flight probe (each
 *  aborted attempt then records a 'cancelled' note rather than an ok or a timeout). The sweep
 *  driver's `while (state.status === 'running')` exits on the next wake, and nothing more starts.
 *  Idempotent — a sweep already 'done' or 'cancelled' is returned unchanged. Undefined when no
 *  sweep has ever run for the connection (the caller 404s). */
export function stopProviderReliabilitySweep(connectionId: string): ReliabilitySweepState | undefined {
  const state = sweeps.get(connectionId);
  if (!state) return undefined;
  if (state.status === 'running') {
    state.status = 'cancelled';
    state.finishedAt = Date.now();
    const controllers = activeControllers.get(connectionId);
    if (controllers) {
      for (const controller of controllers) controller.abort();
      activeControllers.delete(connectionId);
    }
    log.info(`provider reliability: sweep for connection "${connectionId}" stopped by admin`);
  }
  return state;
}