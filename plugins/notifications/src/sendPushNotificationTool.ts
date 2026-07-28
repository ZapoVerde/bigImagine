/**
 * @file plugins/notifications/src/sendPushNotificationTool.ts
 * @stamp 2026-07-27
 * @architectural-role IO Wrapper — the send_push_notification RegisteredTool
 * @description
 * The LLM's own reasoning decides *whether* and *what* to send (bb_principles.md §2) — this tool
 * only moves the resulting message to the configured NotificationProvider and records what
 * happened. Two safety checks sit ahead of every send, in order:
 *
 *   1. notifications_enabled and ntfy_server_url (both orchestrator_settings) — read live on every
 *      call rather than baked in at registration, so editing either from the Settings tab takes
 *      effect immediately, no restart (same live-read shape as household_timezone). A missing/off
 *      value for either is treated identically — this tool isn't currently equipped to send.
 *   2. a fixed per-user hourly send cap (MAX_SENDS_PER_HOUR) — a hardcoded safety net rather than
 *      a Settings-tab value, since nothing has needed tuning it yet; promote it to a setting if
 *      that ever changes.
 *
 * Only ntfy_topic (a credential — restart-to-rotate, like every other secret in this codebase)
 * gates whether registerTools offers this tool at all (index.ts). ntfy_server_url deliberately
 * does not: it's plain config, free to sit unset/wrong without blocking registration, and this
 * tool's own live check already turns that into a clean, observable "not sent" outcome instead of
 * a broken tool the LLM can't tell is broken.
 *
 * Both a disabled and a rate-limited call still write a notification_logs row (status 'disabled'/
 * 'rate_limited') — bb_principles.md §11: a suppressed send is exactly the kind of thing that
 * should be visible in the audit trail, not silently dropped. Both return a soft {sent: false,
 * reason} object rather than throwing, same shape as get_weather's {found: false} — an expected,
 * reasoned-about outcome, not an error. A genuine provider failure (network/ntfy misconfigured)
 * is different in kind: still logged, but then thrown, same as plugins/web's webSearchTool
 * surfacing braveSearchProvider's own thrown error — the LLM needs to see a real failure to tell
 * the user it didn't go through, not silently swallow it.
 *
 * No dedup-window or quiet-hours suppression here (yet) — every call today is a manual tool call
 * inside a live chat turn, the user is already present, so neither protects against anything real
 * right now. Add both when a cron/sensor-driven trigger (docs/spec.md's deferred agent_routine
 * dispatch) actually exists to misfire.
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

import type { RegisteredTool, ToolHandlerContext } from '@bigbrain/orchestrator/tool-registry';
import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { NotificationPriority, NotificationProvider } from './ntfyProvider.js';

type OrchestratorSettingsStore = PluginDeps['settings'];

const MAX_SENDS_PER_HOUR = 10;

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

async function logNotification(
  ctx: ToolHandlerContext,
  args: SendPushNotificationArgs,
  priority: NotificationPriority,
  status: 'sent' | 'failed' | 'rate_limited' | 'disabled',
  error?: string,
): Promise<void> {
  await ctx.db.query(
    `insert into notification_logs (user_id, provider, target, title, body, priority, status, error)
     values ($1, 'ntfy', 'ntfy', $2, $3, $4, $5, $6)`,
    [ctx.userId, args.title, args.message, priority, status, error ?? null],
  );
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
      const priority = args.priority ?? 'default';

      const enabled = (await settings.get('notifications_enabled')) === 'true';
      const serverUrl = await settings.get('ntfy_server_url');
      if (!enabled || !serverUrl) {
        await logNotification(ctx, args, priority, 'disabled');
        return {
          sent: false,
          reason: !enabled ? 'notifications are currently disabled in Settings' : 'ntfy_server_url is not configured in Settings',
        };
      }

      const [{ count }] = await ctx.db.query<{ count: string }>(
        `select count(*)::text as count from notification_logs
         where user_id = $1 and status = 'sent' and created_at > now() - interval '1 hour'`,
        [ctx.userId],
      );
      if (Number(count) >= MAX_SENDS_PER_HOUR) {
        await logNotification(ctx, args, priority, 'rate_limited');
        return { sent: false, reason: `rate limit reached (max ${MAX_SENDS_PER_HOUR} notifications/hour)` };
      }

      const result = await provider.send(serverUrl, { title: args.title, message: args.message, priority, actionUrl: args.actionUrl, tags: args.tags });
      if (!result.ok) {
        await logNotification(ctx, args, priority, 'failed', result.error);
        throw new Error(`send_push_notification failed: ${result.error ?? 'unknown error'}`);
      }

      await logNotification(ctx, args, priority, 'sent');
      return { sent: true };
    },
  };
}
