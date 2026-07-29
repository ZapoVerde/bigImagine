/**
 * @file plugins/lists/src/addListItemTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — adds an item to a (possibly new) list
 * @description
 * Goes through findOrCreateList so "add milk to my grocery list" works in one call even if the
 * grocery list doesn't exist yet — the model never has to call create_list first for the common
 * case. user_id is denormalized onto list_items (not just reachable via a join to lists) so RLS
 * applies directly to this table too, per bb_principles.md §4.
 *
 * If the target list has a section_order (set_list_section_order.ts), the new item is classified
 * into one of those sections (classifySection.ts) before insert, so get_list_items can sort it
 * into store-walk order. Best-effort: a lists with no section_order skips classification entirely
 * (no LLM call for the common case), and a classification failure is logged but never blocks the
 * item actually being added — same best-effort spirit as the Notion sync below it.
 *
 * priority/due_at (db/migrations/0024_action_dates_priority.sql) are both optional and set
 * explicitly here, never inferred — bb_principles.md §3: once set, a priority isn't second-guessed
 * by anything downstream. Either can also be set later via update_list_item.
 *
 * Notion sync (syncListItemToNotion, notionSync.ts) runs in the background, not awaited — a slow
 * or failing Notion API must never add latency to adding an item (see notionSync.ts's header for
 * why this matters).
 *
 * @api-declaration
 * createAddListItemTool(llm, notion, db) — returns the add_list_item RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session, best-effort LLM call,
 *                      best-effort background Notion IO)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given, and independently via db for the
 *                      background Notion sync), LLM]
 */

import { log } from '@bigbrain/orchestrator/logger';
import type { LlmProvider } from '@bigbrain/orchestrator/llm-types';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import type { NotionClient } from '@bigbrain/orchestrator/notion';
import type { PostgresClient } from '@bigbrain/orchestrator/postgres';
import { classifySection } from './classifySection.js';
import { findOrCreateList } from './listLookup.js';
import { syncListItemToNotionInBackground } from './notionSync.js';

const VALID_PRIORITIES = ['P1', 'P2', 'P3'];

function isAddListItemArgs(
  value: unknown,
): value is { list_name: string; item_name: string; priority?: string; due_at?: string } {
  const v = value as Record<string, unknown>;
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof v.list_name !== 'string' ||
    v.list_name === '' ||
    typeof v.item_name !== 'string' ||
    v.item_name === ''
  ) {
    return false;
  }
  if (v.priority !== undefined && !VALID_PRIORITIES.includes(v.priority as string)) return false;
  if (v.due_at !== undefined && typeof v.due_at !== 'string') return false;
  return true;
}

export function createAddListItemTool(llm: LlmProvider, notion: NotionClient | undefined, db: PostgresClient): RegisteredTool {
  return {
    definition: {
      name: 'add_list_item',
      description:
        'Add an item to a named list, creating the list first if it does not already exist (e.g. "add milk to my grocery list").',
      parameters: {
        type: 'object',
        properties: {
          list_name: { type: 'string', description: 'The name of the list to add the item to.' },
          item_name: { type: 'string', description: 'The item to add.' },
          priority: { type: 'string', enum: VALID_PRIORITIES, description: 'Optional: P1 (urgent) through P3 (whenever). Only set when the user explicitly asks for it.' },
          due_at: { type: 'string', description: 'Optional: ISO timestamp this item is due by.' },
        },
        required: ['list_name', 'item_name'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isAddListItemArgs(args)) {
        throw new Error('add_list_item requires non-empty list_name and item_name: string arguments; priority (if given) must be P1/P2/P3 and due_at (if given) a string');
      }

      const { listId, created } = await findOrCreateList(ctx.db, ctx.userId, args.list_name);

      let section: string | null = null;
      const listRow = await ctx.db.query<{ section_order: string[] }>(`select section_order from lists where list_id = $1`, [listId]);
      const sectionOrder = listRow[0]?.section_order ?? [];
      if (sectionOrder.length > 0) {
        try {
          section = await classifySection(llm, sectionOrder, args.item_name);
        } catch (err) {
          log.error(`section classification failed for "${args.item_name}" on list ${listId} (item still added, unsectioned)`, err);
        }
      }

      const rows = await ctx.db.query<{ item_id: string }>(
        `insert into list_items (list_id, user_id, item_name, section, priority, due_at) values ($1, $2, $3, $4, $5, $6) returning item_id`,
        [listId, ctx.userId, args.item_name, section, args.priority ?? null, args.due_at ?? null],
      );
      const itemId = rows[0]!.item_id;

      syncListItemToNotionInBackground(db, notion, ctx.userId, {
        itemId,
        itemName: args.item_name,
        listName: args.list_name,
        status: 'pending',
        completedAt: null,
      });

      return {
        itemId,
        listId,
        listName: args.list_name,
        itemName: args.item_name,
        priority: args.priority ?? null,
        dueAt: args.due_at ?? null,
        listWasCreated: created,
      };
    },
  };
}
