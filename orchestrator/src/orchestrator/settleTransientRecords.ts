/**
 * @file orchestrator/src/orchestrator/settleTransientRecords.ts
 * @stamp 2026-08-19
 * @architectural-role IO Wrapper — settles a turn's swipe-anchored transient locations/characters
 * @description
 * docs/plans/completed/vistalyze_integration/segway.md §2.5's promote/demote step, run per-turn
 * (Stages 1-2, called by server/handleChatCompletions.ts and server/turnExecution.ts's
 * regenerateSwipe right after the turn's active swipe is set) instead of only at
 * chatMemorySync.ts's rolling sync tick. That tick's own settle_transient_records step only
 * touches a message once it ages out of the live window (default 8 turn-pairs) as part of a
 * batched consolidation pass — for an actively-growing or short chat that can be dozens of
 * messages away, or never. Until settled, a demoted swipe's transient rows stay
 * `status = 'transient'`, which every eligibility check (locationAndPresenceScraper.ts's
 * eligibleClause, getCharactersTool.ts) treats as still visible — so a character introduced in a
 * swipe you've since swiped away from kept showing up in the Cast list/roster indefinitely. This
 * closes that gap by settling immediately, the same turn the swipe becomes active.
 *
 * chatMemorySync.ts's own settle_transient_records step is left in place as a backstop — its
 * queries are idempotent (`status = 'transient'` guards each update), so it becomes a no-op for
 * any message this function already settled, and still catches anything that reaches it without
 * going through this path.
 *
 * Fail-open end to end (bi_principles.md §11's "log the seam, never take the turn down with it"),
 * same contract as locationAndPresenceScraper.ts's scrapeTurnPresence: a settling failure logs
 * and returns, it never throws back into the turn that just succeeded.
 *
 * @api-declaration
 * settleTransientRecordsForMessage(db, userId, messageId) — promotes the message's active
 *   swipe's transient locations/characters to permanent, demotes every other swipe's to inactive
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected PostgresClient)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { PostgresClient } from '../io/postgres.js';
import { log } from '../io/logger.js';

export async function settleTransientRecordsForMessage(db: PostgresClient, userId: string, messageId: string): Promise<void> {
  try {
    await db.withUserScope(userId, async (session) => {
      const [message] = await session.query<{ active_swipe_id: string | null }>(
        'select active_swipe_id from chat_messages where message_id = $1',
        [messageId],
      );
      if (!message?.active_swipe_id) return;
      const activeSwipeId = message.active_swipe_id;

      const promotedLoc = await session.query<{ location_id: string }>(
        `update locations set status = 'permanent', updated_at = now()
         where user_id = $1 and status = 'transient' and location_id in (
           select location_id from location_chat_links where anchor_swipe_id = $2
         )
         returning location_id`,
        [userId, activeSwipeId],
      );
      const promotedChar = await session.query<{ character_id: string }>(
        `update characters set status = 'permanent', updated_at = now()
         where user_id = $1 and status = 'transient' and character_id in (
           select character_id from character_chat_links where anchor_swipe_id = $2
         )
         returning character_id`,
        [userId, activeSwipeId],
      );
      const demotedLoc = await session.query<{ location_id: string }>(
        `update locations set status = 'inactive', updated_at = now()
         where user_id = $1 and status = 'transient' and location_id in (
           select location_id from location_chat_links where anchor_swipe_id in (
             select swipe_id from chat_message_swipes where message_id = $2 and swipe_id <> $3
           )
         )
         returning location_id`,
        [userId, messageId, activeSwipeId],
      );
      const demotedChar = await session.query<{ character_id: string }>(
        `update characters set status = 'inactive', updated_at = now()
         where user_id = $1 and status = 'transient' and character_id in (
           select character_id from character_chat_links where anchor_swipe_id in (
             select swipe_id from chat_message_swipes where message_id = $2 and swipe_id <> $3
           )
         )
         returning character_id`,
        [userId, messageId, activeSwipeId],
      );

      if (promotedLoc.length + promotedChar.length + demotedLoc.length + demotedChar.length > 0) {
        log.info('settled transient location/character records for turn', {
          messageId,
          promotedLocations: promotedLoc.length,
          promotedCharacters: promotedChar.length,
          demotedLocations: demotedLoc.length,
          demotedCharacters: demotedChar.length,
        });
      }
    });
  } catch (err) {
    log.error('settleTransientRecordsForMessage failed, skipping (fail-open)', { messageId, err });
  }
}
