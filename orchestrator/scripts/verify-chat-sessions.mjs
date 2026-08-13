// Proves io/chatSessions.ts's CRUD/search/append logic against a fake in-memory pool (no real
// Postgres), mirroring verify-provider-credentials.mjs's style, plus toolRegistry.ts's
// filterToolRegistry wrapper.

import { randomUUID } from 'node:crypto';
import { createPostgresClient } from '../dist/io/postgres.js';
import { createChatSessionStore, DEFAULT_RP_TOOLS } from '../dist/io/chatSessions.js';
import { createToolRegistry, filterToolRegistry } from '../dist/orchestrator/toolRegistry.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fake pool: in-memory chat_sessions / chat_messages / folders / chat_message_swipes /
// locations / characters tables ---
function createFakePool() {
  const sessions = new Map(); // chat_id -> row
  const messages = []; // {message_id, chat_id, user_id, role, content, reasoning, created_at, active_swipe_id}
  const swipes = []; // {swipe_id, message_id, content, reasoning, created_at}
  const folders = new Map(); // folder_id -> row
  const locations = []; // {location_id, user_id, name, status, anchor_chat_id, anchor_swipe_id, ...}
  const characters = []; // {character_id, user_id, name, status, anchor_chat_id, anchor_swipe_id}
  const locationChatLinks = []; // {location_id, chat_id, anchor_swipe_id} — forkChat §2.7 link rows
  const characterChatLinks = []; // {character_id, chat_id, anchor_swipe_id} — forkChat §2.7 link rows
  const swipeImages = []; // {chat_id, swipe_id, location_id, image_url, render_hash, image_generated_at}
  const syncStatus = new Map(); // chat_id -> {user_id, last_attempt_at, last_status, last_step, last_error, last_success_at, last_chunks_added, last_entries_updated, consecutive_errors}
  const canonCounts = new Map(); // chat_id -> {proposed, approved, last_proposed_at}
  const syncPoints = []; // {sync_id, chat_id, user_id, ordinal, last_message_id, created_at, bridge_prompt, closed_at} (0079)
  const syncEntries = []; // {sync_id, topic_key, content, updated_at} (chat_memory_entries, inspection slice)
  const syncFacts = []; // {sync_id, fact_id, category, arc_tag, entity_key, summary, detail, status, proposed_at} (0079)
  let clock = 1000;
  const now = () => new Date((clock += 1000)).toISOString();

  return {
    sessions,
    messages,
    swipes,
    folders,
    locations,
    characters,
    swipeImages,
    locationChatLinks,
    characterChatLinks,
    syncStatus,
    canonCounts,
    syncPoints,
    syncEntries,
    syncFacts,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          // getChatSyncStatus (chatSessions.ts) — the per-chat slice of the rolling sync loop's
          // status record. Branches sit here, before the generic chat_sessions/canon_facts/
          // chat_sync_points stubs below, because the status query embeds a `from canon_facts
          // where chat_id` subquery and the unsynced query embeds a `from chat_sync_points where
          // chat_id` subquery that those empty-rows stubs would otherwise swallow.
          if (sql.includes('from chat_memory_sync_status s')) {
            const chatId = params[0];
            const row = syncStatus.get(chatId);
            if (!row || row.user_id !== scopedUserId) return { rows: [] };
            const canon = canonCounts.get(chatId) ?? { proposed: 0, approved: 0, last_proposed_at: null };
            return {
              rows: [
                {
                  last_attempt_at: row.last_attempt_at,
                  last_status: row.last_status,
                  last_step: row.last_step,
                  last_error: row.last_error,
                  last_success_at: row.last_success_at,
                  last_chunks_added: row.last_chunks_added,
                  last_entries_updated: row.last_entries_updated,
                  consecutive_errors: row.consecutive_errors,
                  canon_proposed_count: String(canon.proposed),
                  canon_approved_count: String(canon.approved),
                  canon_last_proposed_at: canon.last_proposed_at,
                },
              ],
            };
          }
          if (sql.includes('select count(*)::text as unsynced')) {
            const chatId = params[0];
            // No chat_sync_points rows exist in this pool (the stub below returns []), so the
            // anchor is always null and every message counts — exactly what real Postgres returns
            // for a never-synced chat, which is all these tests exercise.
            const count = messages.filter((m) => m.chat_id === chatId && m.user_id === scopedUserId).length;
            return { rows: [{ unsynced: String(count) }] };
          }

          // chat_sessions
          // Discriminated by param count, not sql.includes('parent_chat_id') — SESSION_COLUMNS
          // (used in every `returning` clause here, including createChat's) already contains that
          // substring, so a text match alone can't tell the two inserts apart.
          if (sql.includes('insert into chat_sessions') && params.length === 12) {
            // forkChat's insert — column order per chatSessions.ts:
            // (user_id, title, folder_id, params, tool_names, parent_chat_id, fork_message_id, kind,
            //  character_id, prompt_stack_preset_id, cleanup_preset_id, cleanup_enabled_at)
            const [userId, title, folderId, paramsJson, toolNames, parentChatId, forkMessageId, kind, characterId, promptStackPresetId, cleanupPresetId, cleanupEnabledAt] =
              params;
            const row = {
              chat_id: randomUUID(),
              user_id: userId,
              title: title ?? 'New chat',
              folder_id: folderId ?? null,
              params: paramsJson ? JSON.parse(paramsJson) : {},
              tool_names: toolNames ?? null,
              canvas_note_id: null,
              parent_chat_id: parentChatId ?? null,
              fork_message_id: forkMessageId ?? null,
              archived_at: null,
              kind: kind ?? 'chat',
              character_id: characterId ?? null,
              prompt_stack_preset_id: promptStackPresetId ?? null,
              cleanup_preset_id: cleanupPresetId ?? null,
              cleanup_enabled_at: cleanupEnabledAt ?? null,
              created_at: now(),
              updated_at: now(),
            };
            sessions.set(row.chat_id, row);
            return { rows: [row] };
          }
          if (sql.includes('insert into chat_sessions')) {
            const [userId, title, folderId, kind, toolNames] = params;
            const row = {
              chat_id: randomUUID(),
              user_id: userId,
              title: title ?? 'New chat',
              folder_id: folderId ?? null,
              params: {},
              tool_names: toolNames ?? null,
              canvas_note_id: null,
              parent_chat_id: null,
              fork_message_id: null,
              archived_at: null,
              kind: kind ?? 'chat',
              character_id: null,
              prompt_stack_preset_id: null,
              cleanup_preset_id: null,
              cleanup_enabled_at: null,
              created_at: now(),
              updated_at: now(),
            };
            sessions.set(row.chat_id, row);
            return { rows: [row] };
          }
          // getLineage: walk parent_chat_id up to the root (RLS-scoped at every hop, same as real
          // Postgres would enforce on the recursive join).
          if (sql.startsWith('with recursive up')) {
            const owned = (id) => {
              const s = sessions.get(id);
              return s && s.user_id === scopedUserId ? s : undefined;
            };
            let current = owned(params[0]);
            if (!current) return { rows: [] };
            const seen = new Set([current.chat_id]);
            while (current.parent_chat_id) {
              const parent = owned(current.parent_chat_id);
              if (!parent || seen.has(parent.chat_id)) break;
              current = parent;
              seen.add(current.chat_id);
            }
            return { rows: [{ chat_id: current.chat_id }] };
          }
          // getLineage: every descendant of the given root, root included, oldest first.
          if (sql.startsWith('with recursive down')) {
            const root = sessions.get(params[0]);
            if (!root || root.user_id !== scopedUserId) return { rows: [] };
            const family = [...sessions.values()].filter((s) => s.user_id === scopedUserId);
            const byParent = new Map();
            for (const s of family) {
              if (!byParent.has(s.parent_chat_id)) byParent.set(s.parent_chat_id, []);
              byParent.get(s.parent_chat_id).push(s);
            }
            const rows = [];
            const queue = [root];
            while (queue.length > 0) {
              const node = queue.shift();
              rows.push(node);
              queue.push(...(byParent.get(node.chat_id) ?? []));
            }
            rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
            return { rows };
          }
          if (sql.includes('left join chat_memory_entries e on e.sync_id')) {
            // The syncs-summary list (0079): the grouped counts query in getChatSyncStatus —
            // one left-join shape no other query in this pool shares. The real SQL counts with
            // count(distinct ...) precisely because the two left joins fan out (E×F product rows
            // per sync); the filter counts below are the same answer, so this fake mirrors the
            // SQL's *result* semantics rather than its row-multiplication mechanics.
            const chatId = params[0];
            const rows = syncPoints
              .filter((sp) => sp.chat_id === chatId && sp.closed_at)
              .sort((a, b) => b.ordinal - a.ordinal)
              .slice(0, 50)
              .map((sp) => ({
                sync_id: sp.sync_id,
                ordinal: sp.ordinal,
                created_at: sp.created_at,
                entry_count: String(syncEntries.filter((e) => e.sync_id === sp.sync_id).length),
                fact_count: String(syncFacts.filter((f) => f.sync_id === sp.sync_id).length),
              }));
            return { rows };
          }
          if (sql.includes('from chat_sync_points where chat_id')) {
            // The unsynced-count query's own embedded max(ordinal) subquery — empty-rows stub,
            // as before (no sync points exist in this pool's status tests).
            return { rows: [] };
          }
          if (sql.includes('from canon_facts where chat_id')) {
            return { rows: [] };
          }
          // getChatSyncInspection's sync-point read (0079) — the `and chat_id = $2` distinguishes
          // it from every other chat_sync_points query in this pool.
          if (sql.includes('from chat_sync_points where sync_id = $1 and chat_id = $2')) {
            const [syncId, chatId] = params;
            const sp = syncPoints.find((p) => p.sync_id === syncId && p.chat_id === chatId);
            if (!sp) return { rows: [] };
            return {
              rows: [
                {
                  sync_id: sp.sync_id,
                  ordinal: sp.ordinal,
                  last_message_id: sp.last_message_id,
                  created_at: sp.created_at,
                  bridge_prompt: sp.bridge_prompt ?? null,
                },
              ],
            };
          }
          // The per-sync inspection reads (0079) — matched after the chat-scoped branches above
          // (they share no text, but keeping them adjacent mirrors the query order in
          // getChatSyncInspection itself).
          if (sql.includes('from chat_memory_entries where sync_id')) {
            const [syncId] = params;
            const rows = syncEntries
              .filter((e) => e.sync_id === syncId)
              .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
              .map((e) => ({ topic_key: e.topic_key, content: e.content, updated_at: e.updated_at }));
            return { rows };
          }
          if (sql.includes('from canon_facts where sync_id')) {
            const [syncId] = params;
            const rows = syncFacts
              .filter((f) => f.sync_id === syncId)
              .sort((a, b) => a.proposed_at.localeCompare(b.proposed_at))
              .map((f) => ({
                fact_id: f.fact_id,
                category: f.category,
                arc_tag: f.arc_tag ?? null,
                entity_key: f.entity_key ?? null,
                summary: f.summary,
                detail: f.detail,
                status: f.status,
              }));
            return { rows };
          }
          // getChat's swipe-metadata lookup (chatSessions.ts) — previously a stub that always
          // returned empty (no test exercised swipes); now backed by the in-memory swipes table
          // so ensureActiveSwipe's canonical swipe row reads back as {index: 0, count: 1}.
          if (sql.includes('from chat_message_swipes where message_id')) {
            const ids = Array.isArray(params[0]) ? params[0] : [params[0]];
            const rows = swipes
              .filter((s) => ids.includes(s.message_id))
              // Reasoning (0095_reasoning_blocks.sql): getChat's metadata lookup only reads
              // swipe_id, but cycleSwipe/recordSwipeIfContent select content+reasoning from the
              // same table — carry all three so every consumer of this branch is satisfied.
              .map((s) => ({ message_id: s.message_id, swipe_id: s.swipe_id, content: s.content ?? null, reasoning: s.reasoning ?? null }));
            return { rows };
          }
          if (sql.includes('select chat_id, title, folder_id, updated_at from chat_sessions')) {
            let rows = [...sessions.values()].filter((s) => s.user_id === scopedUserId);
            if (sql.includes('title ilike')) {
              const q = params[0].replaceAll('%', '').toLowerCase();
              rows = rows.filter(
                (s) =>
                  s.title.toLowerCase().includes(q) ||
                  messages.some((m) => m.chat_id === s.chat_id && m.content.toLowerCase().includes(q)),
              );
            }
            if (sql.includes('folder_id = $')) {
              const folderId = params[params.length - 1];
              rows = rows.filter((s) => s.folder_id === folderId);
            }
            rows = [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
            return { rows };
          }
          if (sql.includes('delete from chat_sessions')) {
            const row = sessions.get(params[0]);
            if (!row || row.user_id !== scopedUserId) return { rows: [] };
            sessions.delete(params[0]);
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].chat_id === params[0]) messages.splice(i, 1);
            }
            return { rows: [{ chat_id: params[0] }] };
          }
          if (sql.includes('from chat_sessions where chat_id')) {
            const row = sessions.get(params[0]);
            return { rows: row && row.user_id === scopedUserId ? [row] : [] };
          }
          if (sql.startsWith('update chat_sessions set')) {
            const row = sessions.get(params[0]);
            if (!row || row.user_id !== scopedUserId) return { rows: [] };
            row.updated_at = now();
            // Positional mapping mirrors the SET clause construction order in chatSessions.ts.
            const setParts = sql.slice(sql.indexOf('set ') + 4, sql.includes('where') ? sql.indexOf(' where') : undefined);
            let idx = 1;
            if (setParts.includes('title =')) row.title = params[idx++];
            if (setParts.includes('folder_id =')) row.folder_id = params[idx++];
            if (setParts.includes('params =')) row.params = JSON.parse(params[idx++]);
            if (setParts.includes('tool_names =')) row.tool_names = params[idx++];
            if (setParts.includes('canvas_note_id =')) row.canvas_note_id = params[idx++];
            if (setParts.includes('cleanup_preset_id =')) row.cleanup_preset_id = params[idx++];
            if (setParts.includes('cleanup_enabled_at =')) row.cleanup_enabled_at = params[idx++];
            return { rows: sql.includes('returning') ? [row] : [] };
          }
          // chat_messages — always returns the inserted row (real Postgres only does with
          // `returning message_id`, but appendMessages always asks for it now, so this stays simple).
          if (sql.includes('insert into chat_messages')) {
            const [chatId, userId, role, content, reasoning] = params;
            const row = {
              message_id: randomUUID(),
              chat_id: chatId,
              user_id: userId,
              role,
              content,
              reasoning: reasoning ?? null,
              created_at: now(),
              active_swipe_id: null,
            };
            messages.push(row);
            return { rows: [row] };
          }
          // ensureActiveSwipe's and forkChat-resurrection's single-message read — anchored on
          // 'select' (a plain includes() would also swallow `delete from chat_messages where
          // message_id`, which the deleteMessage branch below owns) and discriminated from the
          // getChat select-all by the `where message_id` predicate.
          if (sql.startsWith('select') && sql.includes('from chat_messages where message_id')) {
            const row = messages.find((m) => m.message_id === params[0] && m.chat_id === params[1] && m.user_id === scopedUserId);
            return { rows: row ? [row] : [] };
          }
          // ensureActiveSwipe / forkChat mirroring: give a message its own swipe row.
          if (sql.includes('insert into chat_message_swipes')) {
            const [messageId, content, reasoning, createdAt] = params;
            const row = { swipe_id: randomUUID(), message_id: messageId, content, reasoning: reasoning ?? null, created_at: createdAt ?? now() };
            swipes.push(row);
            return { rows: [{ swipe_id: row.swipe_id }] };
          }
          if (sql.includes('update chat_messages set active_swipe_id')) {
            const [swipeId, messageId] = params;
            const row = messages.find((m) => m.message_id === messageId);
            if (row) row.active_swipe_id = swipeId;
            return { rows: [] };
          }
          // recordSwipeIfContent's content writeback (regeneration / in-place edit): content and
          // the fresh swipe together; reasoning rides along (0095_reasoning_blocks.sql — the row
          // mirrors the active swipe's reasoning). Matches after the active_swipe_id-only branch
          // above, which its `set active_swipe_id = $1` clause doesn't collide with. Also serves
          // cycleSwipe, whose update has the same content+active_swipe_id+reasoning shape.
          if (sql.includes('update chat_messages set content')) {
            const [content, swipeId, reasoning, messageId] = params;
            const row = messages.find((m) => m.message_id === messageId);
            if (row) {
              row.content = content;
              row.active_swipe_id = swipeId;
              row.reasoning = reasoning ?? null;
            }
            return { rows: [] };
          }
          // forkChat resurrection (§2.7): transient/inactive rows anchored to the copied swipes.
          // The `from locations`/`from characters` predicates live on different lines from the
          // `where user_id` in the real SQL, so the matchers don't require adjacency. Since the
          // fork now resurrects every copied swipe (not just the fork point's), the anchor param
          // is an array; a bare id (the characters query, fork-point only) still works.
          if (sql.includes('from location_chat_links') && sql.includes('anchor_swipe_id')) {
            const [chatId, anchorParam] = params;
            const anchorIds = Array.isArray(anchorParam) ? anchorParam : [anchorParam];
            return {
              rows: locationChatLinks
                .filter((l) => l.chat_id === chatId && l.anchor_swipe_id && anchorIds.includes(l.anchor_swipe_id))
                .map((l) => ({ location_id: l.location_id, anchor_swipe_id: l.anchor_swipe_id ?? null })),
            };
          }
          if (sql.includes('from character_chat_links') && sql.includes('anchor_swipe_id')) {
            const [chatId, anchorParam] = params;
            const anchorIds = Array.isArray(anchorParam) ? anchorParam : [anchorParam];
            return {
              rows: characterChatLinks
                .filter((c) => c.chat_id === chatId && c.anchor_swipe_id && anchorIds.includes(c.anchor_swipe_id))
                .map((c) => ({ character_id: c.character_id, anchor_swipe_id: c.anchor_swipe_id ?? null })),
            };
          }
          if (sql.includes('insert into location_chat_links')) {
            const [locationId, chatId, anchorSwipeId] = params;
            if (!locationChatLinks.some((l) => l.location_id === locationId && l.chat_id === chatId)) {
              locationChatLinks.push({ location_id: locationId, chat_id: chatId, anchor_swipe_id: anchorSwipeId ?? null });
            }
            return { rows: [] };
          }
          if (sql.includes('insert into character_chat_links')) {
            const [characterId, chatId, anchorSwipeId] = params;
            if (!characterChatLinks.some((c) => c.character_id === characterId && c.chat_id === chatId)) {
              characterChatLinks.push({ character_id: characterId, chat_id: chatId, anchor_swipe_id: anchorSwipeId ?? null });
            }
            return { rows: [] };
          }
          if (sql.includes('from locations') && sql.includes('anchor_swipe_id')) {
            const [userId, anchorParam] = params;
            const anchorIds = Array.isArray(anchorParam) ? anchorParam : [anchorParam];
            const rows = locations.filter(
              (l) => l.user_id === userId && l.anchor_swipe_id && anchorIds.includes(l.anchor_swipe_id) && (l.status === 'transient' || l.status === 'inactive'),
            );
            // endpoint.md §6.2: the resurrection clone now carries the visual cache columns too,
            // plus location_id/anchor_swipe_id for re-keying the per-swipe image associations.
            return {
              rows: rows.map((l) => ({
                location_id: l.location_id,
                name: l.name,
                visual_description: l.visual_description,
                definition: l.definition ?? null,
                environment: JSON.stringify(l.environment ?? {}),
                seed: l.seed ?? null,
                image_url: l.image_url ?? null,
                image_generated_at: l.image_generated_at ?? null,
                image_rendered_input: l.image_rendered_input ? JSON.stringify(l.image_rendered_input) : null,
                image_render_hash: l.image_render_hash ?? null,
                anchor_swipe_id: l.anchor_swipe_id ?? null,
              })),
            };
          }
          if (sql.includes('from characters') && sql.includes('anchor_swipe_id')) {
            const [userId, anchorSwipeId] = params;
            const rows = characters.filter(
              (c) => c.user_id === userId && c.anchor_swipe_id === anchorSwipeId && (c.status === 'transient' || c.status === 'inactive'),
            );
            return { rows: rows.map((c) => ({ name: c.name })) };
          }
          // forkChat: per-swipe image associations (location_swipe_images) for every copied
          // swipe, re-keyed onto the branch's chat/swipe/location ids.
          if (sql.includes('from location_swipe_images') && sql.includes('swipe_id = any')) {
            const [chatId, swipeIds] = params;
            const rows = swipeImages.filter(
              (s) => s.chat_id === chatId && s.swipe_id && swipeIds.includes(s.swipe_id),
            );
            return {
              rows: rows.map((s) => ({
                swipe_id: s.swipe_id,
                location_id: s.location_id,
                image_url: s.image_url ?? null,
                render_hash: s.render_hash ?? null,
                image_generated_at: s.image_generated_at ?? null,
              })),
            };
          }
          if (sql.includes('insert into location_swipe_images')) {
            const [chatId, swipeId, locationId, imageUrl, renderHash, imageGeneratedAt] = params;
            const existing = swipeImages.find((s) => s.chat_id === chatId && s.swipe_id === swipeId);
            if (existing) {
              Object.assign(existing, { location_id: locationId, image_url: imageUrl, render_hash: renderHash, image_generated_at: imageGeneratedAt });
            } else {
              swipeImages.push({ chat_id: chatId, swipe_id: swipeId, location_id: locationId, image_url: imageUrl, render_hash: renderHash, image_generated_at: imageGeneratedAt });
            }
            return { rows: [] };
          }
          if (sql.includes('insert into locations') && params.length >= 10) {
            // forkChat's clone carries definition (describer.md §4) between visual_description
            // and environment — 12 params: userId, name, visual_description, definition,
            // environment, seed, image_url, image_generated_at, image_rendered_input,
            // image_render_hash, chat_id, anchor_swipe_id.
            const [userId, name, visualDescription, definition, environmentJson, seed, imageUrl, imageGeneratedAt, renderedInputJson, renderHash, chatId, anchorSwipeId] = params;
            const row = {
              location_id: randomUUID(),
              user_id: userId,
              name,
              visual_description: visualDescription,
              definition: definition ?? null,
              environment: JSON.parse(environmentJson ?? '{}'),
              seed: seed ?? null,
              image_url: imageUrl ?? null,
              image_generated_at: imageGeneratedAt ?? null,
              image_rendered_input: renderedInputJson ? JSON.parse(renderedInputJson) : null,
              image_render_hash: renderHash ?? null,
              status: 'transient',
              anchor_chat_id: chatId,
              anchor_swipe_id: anchorSwipeId,
            };
            locations.push(row);
            return { rows: [row] };
          }
          if (sql.includes('insert into characters') && params.length >= 4) {
            const [userId, name, chatId, anchorSwipeId] = params;
            const row = { character_id: randomUUID(), user_id: userId, name, status: 'transient', anchor_chat_id: chatId, anchor_swipe_id: anchorSwipeId };
            characters.push(row);
            return { rows: [] };
          }
          // Anchored with startsWith, checked before the generic select-all branch below —
          // 'delete from chat_messages where chat_id' is itself a substring match for the old
          // (unanchored) select query's includes() check, the exact class of bug this file's
          // history already hit once with folders/chat_sessions.
          if (sql.startsWith('delete from chat_messages where message_id')) {
            const idx = messages.findIndex(
              (m) => m.message_id === params[0] && m.chat_id === params[1] && m.user_id === scopedUserId,
            );
            if (idx === -1) return { rows: [] };
            const [deleted] = messages.splice(idx, 1);
            return { rows: [{ message_id: deleted.message_id }] };
          }
          if (sql.startsWith('delete from chat_messages where chat_id')) {
            const [chatId, messageId] = params;
            const target = messages.find(
              (m) => m.message_id === messageId && m.chat_id === chatId && m.user_id === scopedUserId,
            );
            if (!target) return { rows: [] };
            const toDelete = messages.filter(
              (m) => m.chat_id === chatId && m.user_id === scopedUserId && m.created_at >= target.created_at,
            );
            for (const m of toDelete) {
              const idx = messages.indexOf(m);
              messages.splice(idx, 1);
            }
            return { rows: toDelete.map((m) => ({ message_id: m.message_id })) };
          }
          if (sql.includes('from chat_messages where chat_id')) {
            const rows = messages
              .filter((m) => m.chat_id === params[0] && m.user_id === scopedUserId)
              .sort((a, b) => a.created_at.localeCompare(b.created_at));
            return { rows };
          }

          // folders
          if (sql.includes('insert into folders')) {
            const [userId, name, parentId] = params;
            const row = { folder_id: randomUUID(), user_id: userId, name, parent_id: parentId, created_at: now() };
            folders.set(row.folder_id, row);
            return { rows: [row] };
          }
          if (sql.startsWith('delete from folders')) {
            const row = folders.get(params[0]);
            if (!row || row.user_id !== scopedUserId) return { rows: [] };
            folders.delete(params[0]);
            // emulate on delete set null for chats
            for (const s of sessions.values()) {
              if (s.folder_id === params[0]) s.folder_id = null;
            }
            return { rows: [{ folder_id: params[0] }] };
          }
          if (sql.startsWith('update folders set')) {
            const row = folders.get(params[0]);
            if (!row || row.user_id !== scopedUserId) return { rows: [] };
            let idx = 1;
            if (sql.includes('name =')) row.name = params[idx++];
            if (sql.includes('parent_id =')) row.parent_id = params[idx++];
            return { rows: [row] };
          }
          if (sql.startsWith('select folder_id, name, parent_id from folders where folder_id')) {
            const row = folders.get(params[0]);
            return { rows: row && row.user_id === scopedUserId ? [row] : [] };
          }
          if (sql.includes('select folder_id, name, parent_id from folders')) {
            const rows = [...folders.values()]
              .filter((f) => f.user_id === scopedUserId)
              .sort((a, b) => a.name.localeCompare(b.name));
            return { rows };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

const pool = createFakePool();
const db = createPostgresClient(pool);
const store = createChatSessionStore(db);

// --- create / list / get round trip ---
const created = await store.createChat(USER_A, { title: 'Groceries planning' });
assert(created.chatId.length > 0, 'createChat returns a session with an id');
assert(created.title === 'Groceries planning', 'createChat honors the given title');
assert(created.toolNames === null, 'a new chat allows all tools (toolNames null)');

{
  const rpChat = await store.createChat(USER_A, { title: 'An RP', kind: 'rp' });
  assert(
    JSON.stringify(rpChat.toolNames) === JSON.stringify(DEFAULT_RP_TOOLS),
    "an rp chat defaults to DEFAULT_RP_TOOLS ([]) — no tools at all, not the recall pair and not null/all",
  );
  const explicitRp = await store.createChat(USER_A, { title: 'RP no tools', kind: 'rp', toolNames: [] });
  assert(JSON.stringify(explicitRp.toolNames) === '[]', 'an explicit toolNames overrides the rp default');
}

const defaultTitled = await store.createChat(USER_A);
assert(defaultTitled.title === 'New chat', 'createChat defaults the title');

{
  const list = await store.listChats(USER_A);
  assert(list.length === 4, 'listChats returns every chat (2 general + 2 rp)');
}
{
  const list = await store.listChats(USER_B);
  assert(list.length === 0, 'another user sees no chats (RLS scoping via the session user)');
}

// --- appendMessages + getChat ---
await store.appendMessages(USER_A, created.chatId, [
  { role: 'user', content: 'what is on the shopping list?' },
  { role: 'assistant', content: 'You have carrots and milk pending.' },
]);
{
  const detail = await store.getChat(USER_A, created.chatId);
  assert(detail !== undefined, 'getChat finds the session');
  assert(detail.messages.length === 2, 'both appended messages come back');
  assert(detail.messages[0].role === 'user' && detail.messages[1].role === 'assistant', 'messages keep their order');
}
{
  const detail = await store.getChat(USER_B, created.chatId);
  assert(detail === undefined, "another user's getChat can't see the session");
}

// --- appendMessages bumps updated_at so the chat sorts to the top ---
{
  await store.appendMessages(USER_A, defaultTitled.chatId, [{ role: 'user', content: 'newer activity' }]);
  const list = await store.listChats(USER_A);
  assert(list[0].chatId === defaultTitled.chatId, 'the most recently active chat sorts first');
}

// --- search hits title and message content ---
{
  const byTitle = await store.listChats(USER_A, { search: 'groceries' });
  assert(byTitle.length === 1 && byTitle[0].chatId === created.chatId, 'search matches a chat title');
  const byContent = await store.listChats(USER_A, { search: 'carrots' });
  assert(byContent.length === 1 && byContent[0].chatId === created.chatId, "search matches a message's content");
  const noHit = await store.listChats(USER_A, { search: 'zebra' });
  assert(noHit.length === 0, 'search with no match returns nothing');
}

// --- updateChat: params + toolNames round trip ---
{
  const updated = await store.updateChat(USER_A, created.chatId, {
    params: { system: 'Answer tersely.', temperature: 0.2, max_tokens: 500 },
    toolNames: ['get_list_items'],
  });
  assert(updated.params.system === 'Answer tersely.', 'params.system round-trips');
  assert(updated.params.temperature === 0.2, 'params.temperature round-trips');
  assert(updated.toolNames.length === 1 && updated.toolNames[0] === 'get_list_items', 'toolNames round-trips');
}

// --- updateChat: canvasNoteId (Canvas) round trip ---
{
  assert(created.canvasNoteId === null, 'a new chat starts with no canvas focus');
  const focused = await store.updateChat(USER_A, created.chatId, { canvasNoteId: 'note-123' });
  assert(focused.canvasNoteId === 'note-123', 'canvasNoteId round-trips through updateChat');

  const untouched = await store.updateChat(USER_A, created.chatId, { title: 'Groceries planning (renamed)' });
  assert(untouched.canvasNoteId === 'note-123', 'a patch that omits canvasNoteId leaves the existing focus alone');

  const cleared = await store.updateChat(USER_A, created.chatId, { canvasNoteId: null });
  assert(cleared.canvasNoteId === null, 'canvasNoteId can be explicitly cleared back to null');
}

// --- updateChat: cleanup_enabled_at (async cleanup subloop toggle, migration 0072) round trip ---
{
  assert(created.cleanupEnabledAt === null, 'a new chat starts with cleanup disabled');
  const enabled = await store.updateChat(USER_A, created.chatId, { cleanupEnabledAt: '2026-08-07T00:00:00.000Z' });
  assert(enabled.cleanupEnabledAt === '2026-08-07T00:00:00.000Z', 'cleanup_enabled_at round-trips through updateChat');

  const untouched = await store.updateChat(USER_A, created.chatId, { title: 'Groceries planning (renamed)' });
  assert(untouched.cleanupEnabledAt === '2026-08-07T00:00:00.000Z', 'a patch that omits cleanup_enabled_at leaves the toggle alone');

  const off = await store.updateChat(USER_A, created.chatId, { cleanupEnabledAt: null });
  assert(off.cleanupEnabledAt === null, 'cleanup_enabled_at can be explicitly cleared back to null (turning cleanup off)');
}

// --- folders ---
const folder = await store.createFolder(USER_A, { name: 'Meal planning' });
assert(folder.name === 'Meal planning', 'createFolder returns the folder');
{
  await store.updateChat(USER_A, created.chatId, { folderId: folder.folderId });
  const inFolder = await store.listChats(USER_A, { folderId: folder.folderId });
  assert(inFolder.length === 1 && inFolder[0].chatId === created.chatId, 'a chat can be filed into a folder');
}
{
  const folderList = await store.listFolders(USER_A);
  assert(folderList.length === 1, 'listFolders returns the folder');
  const otherUserFolders = await store.listFolders(USER_B);
  assert(otherUserFolders.length === 0, "another user sees no folders");
}
{
  await store.deleteFolder(USER_A, folder.folderId);
  const detail = await store.getChat(USER_A, created.chatId);
  assert(detail.session.folderId === null, 'deleting a folder releases its chats to no-folder');
}

// --- deleteMessage / truncateMessagesFrom (edit/rerun's shared primitive) ---
{
  const chat = await store.createChat(USER_A, { title: 'Delete/truncate scratch' });
  await store.appendMessages(USER_A, chat.chatId, [
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
  ]);
  await store.appendMessages(USER_A, chat.chatId, [
    { role: 'user', content: 'U2' },
    { role: 'assistant', content: 'A2' },
  ]);
  const before = await store.getChat(USER_A, chat.chatId);
  const [u1, a1, u2, a2] = before.messages;

  const otherUserDeleted = await store.deleteMessage(USER_B, chat.chatId, a1.messageId);
  assert(otherUserDeleted === false, "another user can't delete a message in someone else's chat (RLS scoping)");

  const deletedMissing = await store.deleteMessage(USER_A, chat.chatId, 'no-such-message-id');
  assert(deletedMissing === false, 'deleting a missing message reports false, does not throw');

  const deletedA1 = await store.deleteMessage(USER_A, chat.chatId, a1.messageId);
  assert(deletedA1 === true, 'deleteMessage reports success');
  const afterDelete = await store.getChat(USER_A, chat.chatId);
  assert(
    afterDelete.messages.length === 3 && afterDelete.messages.every((m) => m.messageId !== a1.messageId),
    'exactly the one targeted message is gone, everything else (including messages after it) survives',
  );
  assert(
    afterDelete.messages.map((m) => m.content).join(',') === 'U1,U2,A2',
    'a standalone delete does not touch message order or any other message',
  );

  const otherUserTruncated = await store.truncateMessagesFrom(USER_B, chat.chatId, u2.messageId);
  assert(otherUserTruncated === false, "another user can't truncate someone else's chat (RLS scoping)");

  const truncatedMissing = await store.truncateMessagesFrom(USER_A, chat.chatId, 'no-such-message-id');
  assert(truncatedMissing === false, 'truncating from a missing message reports false, does not throw');

  const truncated = await store.truncateMessagesFrom(USER_A, chat.chatId, u2.messageId);
  assert(truncated === true, 'truncateMessagesFrom reports success');
  const afterTruncate = await store.getChat(USER_A, chat.chatId);
  assert(
    afterTruncate.messages.length === 1 && afterTruncate.messages[0].messageId === u1.messageId,
    'truncating from U2 removes U2 and everything chronologically after it (A2), leaving only U1',
  );
}

// --- editMessageContent: in-place rewrite of a persisted message, original kept as a swipe ---
{
  const chat = await store.createChat(USER_A, { title: 'Edit scratch' });
  await store.appendMessages(USER_A, chat.chatId, [
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'U2' },
    { role: 'assistant', content: 'A2' },
  ]);
  const before = await store.getChat(USER_A, chat.chatId);
  const [u1, a1, u2, a2] = before.messages;

  const otherUserEdited = await store.editMessageContent(USER_B, chat.chatId, a1.messageId, 'A1 hacked');
  assert(otherUserEdited === undefined, "another user can't edit a message in someone else's chat (RLS scoping)");

  const editedMissing = await store.editMessageContent(USER_A, chat.chatId, 'no-such-message-id', 'x');
  assert(editedMissing === undefined, 'editing a missing message reports undefined, does not throw');

  const edited = await store.editMessageContent(USER_A, chat.chatId, a1.messageId, 'A1 edited');
  assert(
    edited && edited.messageId === a1.messageId && edited.content === 'A1 edited' && edited.role === 'assistant',
    'editMessageContent rewrites the message in place, same message_id and role',
  );
  assert(
    edited.swipes && edited.swipes.count === 2 && edited.swipes.index === 1,
    'the original text is preserved as swipe #0 and the edited text is the active swipe',
  );

  const afterEdit = await store.getChat(USER_A, chat.chatId);
  assert(afterEdit.messages.length === 4, 'an in-place edit leaves the conversation length untouched (no truncation)');
  assert(
    afterEdit.messages[1].content === 'A1 edited' &&
      afterEdit.messages[2].messageId === u2.messageId &&
      afterEdit.messages[3].messageId === a2.messageId &&
      afterEdit.messages[0].messageId === u1.messageId,
    'everything chronologically after (and before) the edited message survives untouched',
  );
}

// --- Reasoning blocks (db/migrations/0095_reasoning_blocks.sql): the optional reasoning column
// lands on the correct row/swipe, follows each swipe independently, is absent (never empty
// string) when a turn has none, and is cleared by an edit ---
{
  const chat = await store.createChat(USER_A, { title: 'Reasoning scratch' });
  await store.appendMessages(USER_A, chat.chatId, [
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1 with thought', reasoning: 'the plan: open the door' },
    { role: 'user', content: 'U2' },
    { role: 'assistant', content: 'A2 no thought' },
  ]);
  const detail = await store.getChat(USER_A, chat.chatId);
  const a1 = detail.messages[1];
  const a2 = detail.messages[3];
  assert(a1.reasoning === 'the plan: open the door', "a fresh send's reasoning lands on the row");
  assert(a2.reasoning === undefined, 'a turn with no reasoning leaves the field absent, not empty string');

  // recordSwipe: the regenerated swipe + row take the passed reasoning; the original keeps its
  // own (each swipe's reasoning is independent — the plan's swipe edge case).
  const regen = await store.recordSwipe(USER_A, chat.chatId, a1.messageId, 'A1 regen', 'the new plan: lock the door');
  assert(regen && regen.reasoning === 'the new plan: lock the door', "recordSwipe writes the regenerated swipe's reasoning onto the message");
  const cycledPrev = await store.cycleSwipe(USER_A, chat.chatId, a1.messageId, 'prev');
  assert(
    cycledPrev.status === 'switched' && cycledPrev.message.reasoning === 'the plan: open the door',
    "cycling 'prev' shows the original swipe's own reasoning, not the regenerated one's",
  );
  const cycledNext = await store.cycleSwipe(USER_A, chat.chatId, a1.messageId, 'next');
  assert(
    cycledNext.status === 'switched' && cycledNext.message.reasoning === 'the new plan: lock the door',
    "cycling 'next' back shows the regenerated swipe's own reasoning",
  );

  // editMessageContent clears reasoning for the edited row (a user-typed edit has no reasoning
  // behind it — the plan's edge case); the pre-existing swipe (the regenerated variant) keeps
  // its own reasoning when cycled back to.
  const edited = await store.editMessageContent(USER_A, chat.chatId, a1.messageId, 'A1 edited');
  assert(edited && edited.reasoning === undefined, 'editing a message clears its reasoning');
  const afterEdit = await store.getChat(USER_A, chat.chatId);
  assert(afterEdit.messages[1].reasoning === undefined, 'the edited row reads back with no reasoning');
  const cycledBack = await store.cycleSwipe(USER_A, chat.chatId, a1.messageId, 'prev');
  assert(
    cycledBack.status === 'switched' && cycledBack.message.reasoning === 'the new plan: lock the door',
    'the pre-edit swipe keeps its own reasoning after the edit clears the row',
  );
}

// --- forkChat: copies settings + messages up to the fork point, tracks lineage ---
{
  const forkFolder = await store.createFolder(USER_A, { name: 'Fork test folder' });
  const parent = await store.createChat(USER_A, { title: 'Fork parent', folderId: forkFolder.folderId });
  await store.updateChat(USER_A, parent.chatId, {
    params: { system: 'Stay in character.', temperature: 0.7 },
    toolNames: ['roll_dice'],
  });
  await store.appendMessages(USER_A, parent.chatId, [
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
  ]);
  const midDetail = await store.getChat(USER_A, parent.chatId);
  const forkPoint = midDetail.messages[1]; // A1
  await store.appendMessages(USER_A, parent.chatId, [
    { role: 'user', content: 'U2' },
    { role: 'assistant', content: 'A2' },
  ]);

  const forked = await store.forkChat(USER_A, parent.chatId, forkPoint.messageId);
  assert(forked !== undefined, 'forkChat succeeds at a valid message id');
  assert(forked.title === 'Fork of Fork parent', 'a fork with no explicit title defaults to "Fork of {parent title}"');
  assert(forked.folderId === forkFolder.folderId, "a fork inherits the parent's folder");
  assert(forked.params.system === 'Stay in character.', "a fork inherits the parent's params");
  assert(forked.toolNames.length === 1 && forked.toolNames[0] === 'roll_dice', "a fork inherits the parent's toolNames");
  assert(forked.parentChatId === parent.chatId, 'a fork records its parent chat id');
  assert(forked.forkMessageId === forkPoint.messageId, 'a fork records the message it branched from');

  const forkedDetail = await store.getChat(USER_A, forked.chatId);
  assert(
    forkedDetail.messages.length === 2 && forkedDetail.messages.map((m) => m.content).join(',') === 'U1,A1',
    'a fork copies messages up to (and including) the fork point, not anything after it',
  );

  const missingFork = await store.forkChat(USER_A, parent.chatId, 'no-such-message-id');
  assert(missingFork === undefined, "forking from a message id that doesn't exist in the chat returns undefined");

  // --- getLineage: the whole family, root first, reachable from any member ---
  const fromParent = await store.getLineage(USER_A, parent.chatId);
  const fromFork = await store.getLineage(USER_A, forked.chatId);
  assert(
    fromParent.length === 2 && fromFork.length === 2,
    'getLineage returns the whole two-chat family whether asked from the parent or the fork',
  );
  assert(fromParent[0].chatId === parent.chatId, 'getLineage orders the root first');
  assert(
    JSON.stringify(fromParent.map((n) => n.chatId).sort()) === JSON.stringify(fromFork.map((n) => n.chatId).sort()),
    'the family is identical regardless of which member getLineage is asked about',
  );

  const soloChat = await store.createChat(USER_A, { title: 'Never forked' });
  const soloLineage = await store.getLineage(USER_A, soloChat.chatId);
  assert(
    soloLineage.length === 1 && soloLineage[0].chatId === soloChat.chatId,
    'a chat with no forks still returns its own single-node family',
  );

  const missingLineage = await store.getLineage(USER_A, 'no-such-chat-id');
  assert(missingLineage === undefined, 'getLineage on a nonexistent chat id returns undefined');
}

// --- deleteChat ---
{
  const deleted = await store.deleteChat(USER_A, created.chatId);
  assert(deleted === true, 'deleteChat reports success');
  const detail = await store.getChat(USER_A, created.chatId);
  assert(detail === undefined, 'a deleted chat is gone');
  const deletedAgain = await store.deleteChat(USER_A, created.chatId);
  assert(deletedAgain === false, 'deleting a missing chat reports false, does not throw');
}

// --- filterToolRegistry ---
{
  const full = createToolRegistry([
    { definition: { name: 'alpha', description: 'a', parameters: {} }, handler: async () => 'a' },
    { definition: { name: 'beta', description: 'b', parameters: {} }, handler: async () => 'b' },
  ]);
  const filtered = filterToolRegistry(full, ['beta']);
  assert(filtered.definitions().length === 1 && filtered.definitions()[0].name === 'beta', 'filterToolRegistry restricts definitions()');
  assert(filtered.get('beta') !== undefined, 'an allowed tool still resolves');
  assert(filtered.get('alpha') === undefined, 'a non-allowed tool no longer resolves, even though it exists underneath');
  const none = filterToolRegistry(full, []);
  assert(none.definitions().length === 0, 'an empty allow-list yields no tools at all');
}

// --- ensureActiveSwipe: a never-regenerated assistant message gets its own anchorable swipe ---
{
  const chat = await store.createChat(USER_A, { title: 'ensureActiveSwipe scratch' });
  const [msg] = await store.appendMessages(USER_A, chat.chatId, [{ role: 'assistant', content: 'A1' }]);

  const swipeId = await store.ensureActiveSwipe(USER_A, chat.chatId, msg.messageId);
  assert(typeof swipeId === 'string' && swipeId.length > 0, 'ensureActiveSwipe returns a swipe id for a swipe-less message');

  const again = await store.ensureActiveSwipe(USER_A, chat.chatId, msg.messageId);
  assert(again === swipeId, 'ensureActiveSwipe is idempotent — the message\'s own active swipe is returned unchanged on repeat');

  const missing = await store.ensureActiveSwipe(USER_A, chat.chatId, 'no-such-message');
  assert(missing === undefined, 'ensureActiveSwipe returns undefined for a message that is not in the chat');

  const detail = await store.getChat(USER_A, chat.chatId);
  assert(detail.messages[0].swipes.index === 0 && detail.messages[0].swipes.count === 1, 'a single canonical swipe row reads back as {index: 0, count: 1}');
}

// --- forkChat §2.7 (db/migrations/0096): the fork's referenced locations/characters are LINKED,
// not cloned — sibling location_chat_links/character_chat_links rows on the branch pointing at
// the SAME location_id/character_id, so a later refinement is visible from both branches. Every
// copied swipe's links come along (not just the fork point's), and the per-swipe image
// associations (location_swipe_images) are re-keyed onto the branch with the shared location id.
// Permanent rows are never linked (they're world canon, visible everywhere already). ---
{
  const parent = await store.createChat(USER_A, { title: 'Resurrection parent' });
  await store.appendMessages(USER_A, parent.chatId, [
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'U2' },
    { role: 'assistant', content: 'A2' },
  ]);
  const detail = await store.getChat(USER_A, parent.chatId);
  const forkPoint = detail.messages[3]; // A2 — fork after two full turns

  // Simulate two scraped turns: each assistant message has its own active swipe, with a
  // transient location linked to each (the fork point's and the earlier turn's), plus a
  // permanent location that must not come along.
  const turnSwipe1 = randomUUID();
  const forkSwipe2 = randomUUID();
  const parentA1 = pool.messages.find((m) => m.message_id === detail.messages[1].messageId);
  parentA1.active_swipe_id = turnSwipe1;
  const parentA2 = pool.messages.find((m) => m.message_id === forkPoint.messageId);
  parentA2.active_swipe_id = forkSwipe2;

  const caveId = randomUUID();
  const bridgeId = randomUUID();
  const forestId = randomUUID();
  pool.locations.push({
    location_id: caveId,
    user_id: USER_A,
    name: 'The Dark Cave',
    visual_description: 'Stalactites.',
    environment: { time_of_day: 'night' },
    seed: 42,
    image_url: 'https://cdn.example.invalid/dark-cave.png',
    image_generated_at: '2026-08-13T00:00:00.000Z',
    image_rendered_input: { visual_description: 'Stalactites.', environment: { time_of_day: 'night' }, seed: 42 },
    image_render_hash: 'render-hash-abc',
    status: 'transient',
    anchor_chat_id: parent.chatId,
    anchor_swipe_id: forkSwipe2,
  });
  pool.locations.push({
    location_id: bridgeId,
    user_id: USER_A,
    name: 'The Old Bridge',
    visual_description: 'Rotten planks.',
    environment: { time_of_day: 'dusk' },
    seed: 7,
    image_url: 'https://cdn.example.invalid/old-bridge.png',
    image_generated_at: '2026-08-13T00:00:01.000Z',
    image_rendered_input: { visual_description: 'Rotten planks.', environment: { time_of_day: 'dusk' }, seed: 7 },
    image_render_hash: 'render-hash-def',
    status: 'transient',
    anchor_chat_id: parent.chatId,
    anchor_swipe_id: turnSwipe1,
  });
  pool.locations.push({
    location_id: forestId,
    user_id: USER_A,
    name: 'The Forest Clearing',
    visual_description: 'Sunlight.',
    environment: {},
    status: 'permanent',
    anchor_chat_id: null,
    anchor_swipe_id: null,
  });
  // The parent's link rows (what forkChat actually reads to decide what comes along).
  pool.locationChatLinks.push({ location_id: caveId, chat_id: parent.chatId, anchor_swipe_id: forkSwipe2 });
  pool.locationChatLinks.push({ location_id: bridgeId, chat_id: parent.chatId, anchor_swipe_id: turnSwipe1 });

  const goblinId = randomUUID();
  pool.characters.push({
    character_id: goblinId,
    user_id: USER_A,
    name: 'Goblin Merchant',
    status: 'inactive',
    anchor_chat_id: parent.chatId,
    anchor_swipe_id: forkSwipe2,
  });
  pool.characterChatLinks.push({ character_id: goblinId, chat_id: parent.chatId, anchor_swipe_id: forkSwipe2 });
  // Per-swipe image associations (migration 0076): both turns' swipes have recorded bgs.
  pool.swipeImages.push({
    chat_id: parent.chatId,
    swipe_id: forkSwipe2,
    location_id: caveId,
    image_url: 'https://cdn.example.invalid/dark-cave.png',
    render_hash: 'render-hash-abc',
    image_generated_at: '2026-08-13T00:00:00.000Z',
  });
  pool.swipeImages.push({
    chat_id: parent.chatId,
    swipe_id: turnSwipe1,
    location_id: bridgeId,
    image_url: 'https://cdn.example.invalid/old-bridge.png',
    render_hash: 'render-hash-def',
    image_generated_at: '2026-08-13T00:00:01.000Z',
  });

  const branch = await store.forkChat(USER_A, parent.chatId, forkPoint.messageId);
  assert(branch !== undefined, 'forkChat succeeds at the swiped fork point');

  const branchMsgA1 = pool.messages.find((m) => m.chat_id === branch.chatId && m.content === 'A1');
  const branchMsgA2 = pool.messages.find((m) => m.chat_id === branch.chatId && m.content === 'A2');
  assert(
    branchMsgA1 && branchMsgA1.active_swipe_id !== turnSwipe1 && branchMsgA2 && branchMsgA2.active_swipe_id !== forkSwipe2,
    'the branch\'s copied messages have their own fresh active swipes (never the parent\'s ids)',
  );

  const branchLocations = pool.locations.filter((l) => l.anchor_chat_id === branch.chatId);
  assert(
    branchLocations.length === 0,
    'locations are linked, not cloned — no fresh location rows appear in the branch',
  );
  const branchLocationLinks = pool.locationChatLinks.filter((l) => l.chat_id === branch.chatId);
  assert(
    branchLocationLinks.length === 2 && branchLocationLinks.every((l) => pool.locations.some((loc) => loc.location_id === l.location_id)),
    'both turns\' referenced locations are linked into the branch (sibling link rows, same location rows)',
  );
  const caveLink = branchLocationLinks.find((l) => l.location_id === caveId);
  const bridgeLink = branchLocationLinks.find((l) => l.location_id === bridgeId);
  assert(
    caveLink && caveLink.anchor_swipe_id === branchMsgA2.active_swipe_id,
    'the fork point\'s location link is anchored to the branch\'s fork-point swipe',
  );
  assert(
    bridgeLink && bridgeLink.anchor_swipe_id === branchMsgA1.active_swipe_id,
    'an earlier turn\'s location link is anchored to the branch\'s corresponding earlier swipe',
  );
  const sharedCave = pool.locations.find((l) => l.location_id === caveId);
  assert(
    sharedCave &&
      sharedCave.seed === 42 &&
      sharedCave.image_url === 'https://cdn.example.invalid/dark-cave.png' &&
      sharedCave.image_render_hash === 'render-hash-abc',
    'the shared location row keeps its render cache (seed/image_url/hash) — linking never forces a fresh render',
  );
  assert(
    sharedCave &&
      JSON.stringify(sharedCave.image_rendered_input) === JSON.stringify({ visual_description: 'Stalactites.', environment: { time_of_day: 'night' }, seed: 42 }),
    'the shared location row keeps the render-input snapshot, so its cache check hits on the branch too',
  );
  assert(
    !pool.locationChatLinks.some((l) => l.chat_id === branch.chatId && l.location_id === forestId),
    'a permanent location is world canon — never linked into the branch',
  );

  const branchSwipeImages = pool.swipeImages.filter((s) => s.chat_id === branch.chatId);
  assert(branchSwipeImages.length === 2, 'both per-swipe image associations are re-keyed into the branch');
  const branchCaveRow = branchSwipeImages.find((s) => s.location_id === caveId);
  const branchBridgeRow = branchSwipeImages.find((s) => s.location_id === bridgeId);
  assert(
    branchCaveRow && branchCaveRow.swipe_id === branchMsgA2.active_swipe_id && branchCaveRow.image_url === 'https://cdn.example.invalid/dark-cave.png' && branchCaveRow.render_hash === 'render-hash-abc',
    'the fork-point swipe\'s association is re-keyed to the branch chat/swipe ids with URL + render hash carried over (shared location id)',
  );
  assert(
    branchBridgeRow && branchBridgeRow.swipe_id === branchMsgA1.active_swipe_id && branchBridgeRow.image_url === 'https://cdn.example.invalid/old-bridge.png' && branchBridgeRow.render_hash === 'render-hash-def',
    'an earlier turn\'s association is re-keyed too, so prev/next cycling inside the branch reuses the recorded URL',
  );

  assert(
    !pool.characters.some((c) => c.anchor_chat_id === branch.chatId),
    'characters are linked, not cloned — no fresh character rows appear in the branch',
  );
  const branchCharacterLinks = pool.characterChatLinks.filter((c) => c.chat_id === branch.chatId);
  assert(
    branchCharacterLinks.length === 1 &&
      branchCharacterLinks[0].character_id === goblinId &&
      branchCharacterLinks[0].anchor_swipe_id === branchMsgA2.active_swipe_id,
    'the fork point\'s character is linked into the branch (sibling character_chat_links row, same character row)',
  );
}

// --- getChatSyncStatus: the per-chat slice of the rolling sync loop's status record ---
// (chatSessions.ts's getChatSyncStatus, read side of the RP chat header menu's Sync Status
// panel — same columns as server/adminServer.ts's cross-user table, narrowed to one chat and
// scoped by the owner's RLS, no admin key involved. Uses its own dedicated chat — `created` was
// deleted by the deleteChat tests above.)
const syncChat = await store.createChat(USER_A, { title: 'Sync status chat' });
await store.appendMessages(USER_A, syncChat.chatId, [
  { role: 'user', content: 'first unsynced message' },
  { role: 'assistant', content: 'second unsynced message' },
]);
pool.syncStatus.set(syncChat.chatId, {
  user_id: USER_A,
  last_attempt_at: '2026-08-07T12:00:00.000Z',
  last_status: 'ok',
  last_step: null,
  last_error: null,
  last_success_at: '2026-08-07T12:00:00.000Z',
  last_chunks_added: 2,
  last_entries_updated: 1,
  consecutive_errors: 0,
});
pool.canonCounts.set(syncChat.chatId, { proposed: 3, approved: 2, last_proposed_at: '2026-08-07T11:00:00.000Z' });
{
  const sync = await store.getChatSyncStatus(USER_A, syncChat.chatId, 32);
  assert(sync !== undefined, 'getChatSyncStatus finds an existing chat');
  assert(sync.lastStatus === 'ok', 'an ok status row reads back as ok');
  assert(sync.lastChunksAdded === 2 && sync.lastEntriesUpdated === 1, 'last run chunk/entry counts round-trip');
  assert(sync.consecutiveErrors === 0, 'a healthy chat carries zero consecutive errors');
  assert(sync.canonProposedCount === 3 && sync.canonApprovedCount === 2, 'canon proposed/approved counts round-trip');
  assert(sync.canonLastProposedAt === '2026-08-07T11:00:00.000Z', 'last canon proposal timestamp round-trips');
  assert(sync.unsyncedMessages === 2, 'unsynced counts the chat\'s messages past its last sync point');
  assert(sync.dueAfterMessages === 32, 'the caller-supplied due threshold is echoed through');
}
{
  const sync = await store.getChatSyncStatus(USER_B, syncChat.chatId, 32);
  assert(sync === undefined, "another user's getChatSyncStatus can't see the chat (RLS scoping)");
}
{
  const sync = await store.getChatSyncStatus(USER_A, defaultTitled.chatId, 32);
  assert(sync !== undefined, 'a chat that never synced still gets a status read');
  assert(sync.lastStatus === null, 'a never-synced chat has a null last status, not a fabricated one');
  assert(sync.lastAttemptAt === null && sync.lastSuccessAt === null, 'a never-synced chat has no attempt/success timestamps');
  assert(
    sync.consecutiveErrors === 0 && sync.canonProposedCount === 0 && sync.canonApprovedCount === 0,
    'a never-synced chat carries zero errors and zero canon facts',
  );
  assert(sync.unsyncedMessages === 1, 'a never-synced chat counts all its messages as unsynced');
}
{
  pool.syncStatus.set(defaultTitled.chatId, {
    user_id: USER_A,
    last_attempt_at: '2026-08-07T12:30:00.000Z',
    last_status: 'error',
    last_step: 'summarize_embed',
    last_error: 'embeddings provider unreachable',
    last_success_at: '2026-08-07T12:00:00.000Z',
    last_chunks_added: null,
    last_entries_updated: null,
    consecutive_errors: 3,
  });
  const sync = await store.getChatSyncStatus(USER_A, defaultTitled.chatId, 32);
  assert(sync.lastStatus === 'error' && sync.lastStep === 'summarize_embed', 'an error row names the exact step that failed');
  assert(sync.lastError === 'embeddings provider unreachable', 'an error row carries the underlying error message');
  assert(sync.consecutiveErrors === 3, 'consecutive failures round-trip');
  assert(sync.lastSuccessAt === '2026-08-07T12:00:00.000Z', 'the last success timestamp survives an error status');
}
{
  const sync = await store.getChatSyncStatus(USER_A, 'nonexistent-chat', 32);
  assert(sync === undefined, 'getChatSyncStatus on a nonexistent chat returns undefined');
}

// --- Per-sync inspection (db/migrations/0079_sync_inspection.sql): the status payload carries a
// cheap summary list, and getChatSyncInspection fetches one sync's full record on demand. ---
{
  const syncId = randomUUID();
  const messageId = randomUUID();
  pool.syncPoints.push({
    sync_id: syncId,
    chat_id: syncChat.chatId,
    user_id: USER_A,
    ordinal: 2,
    last_message_id: messageId,
    created_at: '2026-08-07T13:00:00.000Z',
    bridge_prompt: 'SYSTEM: [TASK — NARRATIVE CHRONICLER]\n\nTRANSCRIPT:\nUser: hi',
    // A consolidated sync (it has entries/facts) — closed, so the panel's closed-only list shows it
    // (docs/plans/eager-chunk-sync-plan.md).
    closed_at: '2026-08-07T13:00:00.000Z',
  });
  pool.syncEntries.push(
    { sync_id: syncId, topic_key: 'scene', content: 'SCENE: A rainy square.', updated_at: '2026-08-07T13:01:00.000Z' },
    { sync_id: syncId, topic_key: 'events', content: '| When | What | Who |', updated_at: '2026-08-07T13:01:00.000Z' },
  );
  pool.syncFacts.push({
    sync_id: syncId,
    fact_id: randomUUID(),
    category: 'plot',
    arc_tag: 'siege_break',
    entity_key: null,
    summary: 'The siege wall breached.',
    detail: 'The Ashford Siege Breaks Open',
    status: 'proposed',
    proposed_at: '2026-08-07T13:01:30.000Z',
  });

  const sync = await store.getChatSyncStatus(USER_A, syncChat.chatId, 32);
  assert(Array.isArray(sync.syncs) && sync.syncs.length === 1, 'getChatSyncStatus returns the chat\'s sync-point summaries, newest first');
  const summary = sync.syncs[0];
  assert(
    summary.ordinal === 2 && summary.entryCount === 2 && summary.factCount === 1,
    'a sync summary carries its ordinal and aggregate entry/fact counts — the panel list without the heavy detail',
  );
  assert(
    summary.createdAt === '2026-08-07T13:00:00.000Z' && !('bridgePrompt' in summary),
    'the summary stays light — no bridge prompt shipped on the status poll',
  );

  const inspection = await store.getChatSyncInspection(USER_A, syncChat.chatId, syncId);
  assert(inspection !== undefined, 'getChatSyncInspection finds an existing sync');
  assert(inspection.ordinal === 2 && inspection.lastMessageId === messageId, 'an inspection carries its ordinal and anchor message');
  assert(
    inspection.bridgePrompt?.includes('NARRATIVE CHRONICLER') && inspection.bridgePrompt.includes('TRANSCRIPT:'),
    'the bridge prompt this sync sent the model round-trips through the inspection record',
  );
  assert(
    inspection.entries.length === 2 && inspection.entries[0].topicKey === 'scene',
    'the entries this sync created/changed are listed with their content',
  );
  assert(
    inspection.canonFacts.length === 1 &&
      inspection.canonFacts[0].category === 'plot' &&
      inspection.canonFacts[0].status === 'proposed',
    'the canon-fact proposals this sync wrote are attributed to it',
  );
  assert(
    (await store.getChatSyncInspection(USER_A, syncChat.chatId, randomUUID())) === undefined,
    'getChatSyncInspection on a sync that is not this chat\'s returns undefined',
  );
}

if (process.exitCode) {
  console.error('\nchat sessions verification FAILED');
  process.exit(1);
}
console.log('\nchat sessions verification passed');
