/**
 * @file orchestrator/src/io/notificationSender.ts
 * @stamp 2026-07-29
 * @architectural-role IO Wrapper — the shared send-a-household-notification path
 * @description
 * Both a live send_push_notification tool call (plugins/notifications) and an 'alarm' job firing
 * unattended (plugins/temporal/src/jobPoll.ts) need the same three things ahead of an actual ntfy
 * publish: the notifications_enabled/ntfy_server_url kill switch, the per-user hourly send cap,
 * and a notification_logs audit row regardless of outcome (bb_principles.md §11). Sharing this one
 * function is what keeps those two call sites from silently drifting apart on what "sent" means.
 *
 * A genuine provider failure (network/ntfy misconfigured) is logged as 'failed' and thrown — the
 * caller decides whether that failure should propagate. A live tool call lets it surface to the
 * LLM as a real error; jobPoll.ts catches it so one bad send doesn't roll back the alarm's own
 * completed/next_run_at state, which must commit regardless of whether delivery succeeded.
 *
 * @api-declaration
 * sendHouseholdNotification(db, userId, provider, settings, args) -> {sent: boolean, reason?:
 *   string} on a suppressed (disabled/rate-limited) or successful send; throws on a genuine
 *   provider failure
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the given DbSession, delegates to the given NotificationProvider)
 *     state_ownership: []
 *     external_io:     [Postgres, whatever NotificationProvider is given does]
 */

import type { DbSession } from './postgres.js';
import type { OrchestratorSettingsStore } from './orchestratorSettings.js';
import type { NotificationPriority, NotificationProvider } from './ntfyProvider.js';

const MAX_SENDS_PER_HOUR = 10;

export interface SendHouseholdNotificationArgs {
  title: string;
  message: string;
  priority?: NotificationPriority;
  actionUrl?: string;
  tags?: string[];
}

async function logNotification(
  db: DbSession,
  userId: string,
  args: SendHouseholdNotificationArgs,
  priority: NotificationPriority,
  status: 'sent' | 'failed' | 'rate_limited' | 'disabled',
  error?: string,
): Promise<void> {
  await db.query(
    `insert into notification_logs (user_id, provider, target, title, body, priority, status, error)
     values ($1, 'ntfy', 'ntfy', $2, $3, $4, $5, $6)`,
    [userId, args.title, args.message, priority, status, error ?? null],
  );
}

export async function sendHouseholdNotification(
  db: DbSession,
  userId: string,
  provider: NotificationProvider,
  settings: OrchestratorSettingsStore,
  args: SendHouseholdNotificationArgs,
): Promise<{ sent: boolean; reason?: string }> {
  const priority = args.priority ?? 'default';

  const enabled = (await settings.get('notifications_enabled')) === 'true';
  const serverUrl = await settings.get('ntfy_server_url');
  if (!enabled || !serverUrl) {
    await logNotification(db, userId, args, priority, 'disabled');
    return {
      sent: false,
      reason: !enabled ? 'notifications are currently disabled in Settings' : 'ntfy_server_url is not configured in Settings',
    };
  }

  const [{ count }] = await db.query<{ count: string }>(
    `select count(*)::text as count from notification_logs
     where user_id = $1 and status = 'sent' and created_at > now() - interval '1 hour'`,
    [userId],
  );
  if (Number(count) >= MAX_SENDS_PER_HOUR) {
    await logNotification(db, userId, args, priority, 'rate_limited');
    return { sent: false, reason: `rate limit reached (max ${MAX_SENDS_PER_HOUR} notifications/hour)` };
  }

  const result = await provider.send(serverUrl, { title: args.title, message: args.message, priority, actionUrl: args.actionUrl, tags: args.tags });
  if (!result.ok) {
    await logNotification(db, userId, args, priority, 'failed', result.error);
    throw new Error(`notification send failed: ${result.error ?? 'unknown error'}`);
  }

  await logNotification(db, userId, args, priority, 'sent');
  return { sent: true };
}
