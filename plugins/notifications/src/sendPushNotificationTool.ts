/**
 * @file plugins/notifications/src/sendPushNotificationTool.ts
 * @stamp 2026-07-29
 * @architectural-role IO Wrapper — the send_push_notification RegisteredTool
 * @description
 * The LLM's own reasoning decides *whether* and *what* to send (bb_principles.md §2) — this tool
 * only validates the LLM's arguments and hands them to @bigbrain/orchestrator/notification-sender's
 * sendHouseholdNotification, the same gate-check-then-send-then-log path plugins/temporal/src/
 * jobPoll.ts uses to deliver a fired 'alarm' job unattended. That shared function owns the
 * notifications_enabled/ntfy_server_url kill switch, the per-user hourly send cap, and the
 * notification_logs audit row (bb_principles.md §11) — this file no longer duplicates any of it,
 * so the two call sites can't drift on what "sent" means.
 *
 * Only ntfy_topic (a credential — restart-to-rotate, like every other secret in this codebase)
 * gates whether registerTools offers this tool at all (index.ts). ntfy_server_url deliberately
 * does not: it's plain config, free to sit unset/wrong without blocking registration, and the
 * shared sender's own live check already turns that into a clean, observable "not sent" outcome
 * instead of a broken tool the LLM can't tell is broken.
 *
 * A disabled or rate-limited call returns a soft {sent: false, reason} object rather than
 * throwing — an expected, reasoned-about outcome, not an error. A genuine provider failure
 * (network/ntfy misconfigured) is different in kind: still
 * logged, but then thrown, same as plugins/web's webSearchTool surfacing braveSearchProvider's own
 * thrown error — the LLM needs to see a real failure to tell the user it didn't go through, not
 * silently swallow it.
 *
 * @api-declaration
 * createSendPushNotificationTool(provider, settings) — returns the send_push_notification
 *   RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via ctx.db, delegates to the injected NotificationProvider)
 *     state_ownership: []
 *     external_io:     [Postgres (via ctx.db), whatever NotificationProvider is given does]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { NotificationPriority, NotificationProvider } from '@bigbrain/orchestrator/ntfy-provider';
import { sendHouseholdNotification } from '@bigbrain/orchestrator/notification-sender';

type OrchestratorSettingsStore = PluginDeps['settings'];

interface SendPushNotificationArgs {
  title: string;
  message: string;
  priority?: NotificationPriority;
  actionUrl?: string;
  tags?: string[];
}

function isSendPushNotificationArgs(value: unknown): value is SendPushNotificationArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.title !== 'string' || v.title.trim() === '') return false;
  if (typeof v.message !== 'string' || v.message.trim() === '') return false;
  if (v.priority !== undefined && !['low', 'default', 'high', 'urgent'].includes(v.priority as string)) return false;
  if (v.actionUrl !== undefined && typeof v.actionUrl !== 'string') return false;
  if (v.tags !== undefined && (!Array.isArray(v.tags) || v.tags.some((t) => typeof t !== 'string'))) return false;
  return true;
}

export function createSendPushNotificationTool(
  provider: NotificationProvider,
  settings: OrchestratorSettingsStore,
): RegisteredTool {
  return {
    definition: {
      name: 'send_push_notification',
      description:
        'Send a lockscreen push notification to the household. Use when something time-sensitive and worth ' +
        'interrupting the user for has happened. Not for routine confirmations — the chat reply already covers those.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short notification title.' },
          message: { type: 'string', description: 'The notification body text.' },
          priority: {
            type: 'string',
            enum: ['low', 'default', 'high', 'urgent'],
            description: '"urgent" is for things that justify overriding a phone\'s silent mode. Defaults to "default".',
          },
          actionUrl: { type: 'string', description: 'Optional URL opened when the notification is tapped.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags/emoji shortcodes shown with the alert.' },
        },
        required: ['title', 'message'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isSendPushNotificationArgs(args)) {
        throw new Error('send_push_notification requires non-empty title and message: string arguments');
      }
      return sendHouseholdNotification(ctx.db, ctx.userId, provider, settings, args);
    },
  };
}
