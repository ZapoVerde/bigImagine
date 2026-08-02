/**
 * @file plugins/notifications/src/index.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as web/weather): an `info` object and an
 * async `registerTools`. No startBackgroundJobs — send_push_notification is purely a per-call
 * tool, nothing to poll (there is no autonomous sensor loop yet; see docs/spec.md's deferred
 * agent_routine dispatch).
 *
 * ntfy_topic is a secret (bb_principles.md §12 — the ntfy server has no Cloudflare Access gate, so
 * the topic name alone grants publish/subscribe access) resolved via deps.credentials
 * (db/migrations/0034_notifications_credentials_settings.sql), same encrypted store the LLM/
 * Notion/calendar/web keys use — this is the only thing that gates registration, same one-secret
 * gate shape as web_search's brave_api_key. ntfy_server_url is deliberately NOT checked here: it's
 * plain orchestrator_settings config, read live by sendPushNotificationTool.ts on every call (same
 * shape as notifications_enabled) rather than baked in at boot, so both Settings-tab fields take
 * effect immediately with no restart. That also means the tool can be registered as soon as a
 * topic exists, even before the server url is filled in — the tool's own live check turns that gap
 * into a clean "not sent, ntfy_server_url is not configured" outcome rather than a crash.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [send_push_notification], or [] if ntfy_topic isn't configured
 *
 * @contract
 *   assertions:
 *     purity:          impure (resolves a credential; constructs a tool that does network + Postgres IO)
 *     state_ownership: []
 *     external_io:     [Postgres, via deps.credentials]
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { log } from '@bigbrain/orchestrator/logger';
import { createNtfyProvider } from '@bigbrain/orchestrator/ntfy-provider';
import { createSendPushNotificationTool } from './sendPushNotificationTool.js';

export const info = {
  id: 'notifications',
  name: 'Notifications',
  description: 'Outbound lockscreen push notifications (Ntfy) for time-sensitive alerts.',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  const topic = await deps.credentials.resolve('ntfy_topic', process.env.BIGBRAIN_NTFY_TOPIC);
  if (!topic) {
    log.info('notifications: no ntfy_topic configured (Settings tab or BIGBRAIN_NTFY_TOPIC), send_push_notification disabled');
    return [];
  }

  const provider = createNtfyProvider(topic);
  return [createSendPushNotificationTool(provider, deps.settings)];
}
