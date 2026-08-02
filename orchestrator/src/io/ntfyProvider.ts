/**
 * @file orchestrator/src/io/ntfyProvider.ts
 * @stamp 2026-07-29
 * @architectural-role IO Wrapper — Ntfy publish API access
 * @description
 * A thin NotificationProvider interface in front of ntfy's JSON publish endpoint, deliberately not
 * baked into plugins/notifications' sendPushNotificationTool.ts directly: adding a Home Assistant
 * or Telegram driver later means writing a new adapter behind NotificationProvider, not touching
 * the tool definition or its dedup/rate-limit/logging logic — same seam shape as plugins/web's
 * SearchProvider (bb_principles.md §6).
 *
 * Lives in orchestrator rather than plugins/notifications because plugins/temporal's jobPoll.ts
 * needs the same client to actually deliver a fired 'alarm' job (a plugin may depend on
 * @bigbrain/orchestrator, never on another plugin — orchestrator/pluginLoader.ts's own doc) — the
 * same reasoning that already put next-occurrence and http-retry here instead of in a single
 * plugin.
 *
 * Always publishes to the single household-wide topic baked into this provider at construction —
 * there is exactly one Ntfy topic per deployment (provider_credentials' ntfy_topic), not a
 * per-call target the LLM chooses, so a misbehaving tool call can't be redirected at an arbitrary
 * topic/URL. serverUrl is deliberately a per-call argument rather than also baked in at
 * construction: unlike the topic (a credential, restart-to-rotate like every other secret in this
 * codebase), the server url is a plain orchestrator_settings value read live by the caller
 * (sendPushNotificationTool.ts) on every call, same no-restart-needed shape as
 * notifications_enabled — so this provider never goes stale relative to a Settings-tab edit.
 *
 * priority is mapped to ntfy's numeric 1-5 scale (2/3/4/5 — "min" (1) is deliberately unused, this
 * gateway's own vocabulary starts at "low") rather than passed through as a word: the JSON publish
 * endpoint's documented contract is the integer, and mapping explicitly here means a typo'd
 * priority string fails at this codebase's own type-check, not silently at ntfy's API.
 *
 * @api-declaration
 * NotificationPriority — 'low' | 'default' | 'high' | 'urgent'
 * NotificationProvider — .send(serverUrl, {title, message, priority, actionUrl?, tags?}) -> {ok, error?}
 * createNtfyProvider(topic) -> NotificationProvider
 *
 * @contract
 *   assertions:
 *     purity:          impure (network call)
 *     state_ownership: []
 *     external_io:     [the configured ntfy server]
 */

import { fetchWithRetry } from './httpRetry.js';
import { log } from './logger.js';

export type NotificationPriority = 'low' | 'default' | 'high' | 'urgent';

const PRIORITY_MAP: Record<NotificationPriority, number> = {
  low: 2,
  default: 3,
  high: 4,
  urgent: 5,
};

export interface SendNotificationParams {
  title: string;
  message: string;
  priority: NotificationPriority;
  actionUrl?: string;
  tags?: string[];
}

export interface SendNotificationResult {
  ok: boolean;
  error?: string;
}

export interface NotificationProvider {
  send(serverUrl: string, params: SendNotificationParams): Promise<SendNotificationResult>;
}

export function createNtfyProvider(topic: string): NotificationProvider {
  return {
    async send(serverUrl: string, params: SendNotificationParams): Promise<SendNotificationResult> {
      const body: Record<string, unknown> = {
        topic,
        title: params.title,
        message: params.message,
        priority: PRIORITY_MAP[params.priority],
      };
      if (params.actionUrl) body.click = params.actionUrl;
      if (params.tags && params.tags.length > 0) body.tags = params.tags;

      const response = await fetchWithRetry(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        log.warn(`ntfy publish failed with HTTP ${response.status}: ${detail}`);
        return { ok: false, error: `ntfy returned HTTP ${response.status}` };
      }

      return { ok: true };
    },
  };
}
