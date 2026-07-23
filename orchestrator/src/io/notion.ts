/**
 * @file orchestrator/src/io/notion.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — Notion API access for the Lists sync target
 * @description
 * docs/spec.md §6.4's Notion Sync Gateway, both directions. Unlike the LLM/embeddings providers
 * (bb_principles.md §6, fail closed on missing config), Notion config is deliberately OPTIONAL:
 * Notion is a best-effort mirror, never load-bearing — lists work fully without it. Missing
 * config means createNotionClient returns undefined and callers treat sync as a no-op, not a
 * startup failure.
 *
 * Targets Notion's current (2026-03-11) API, which splits "database" from "data source" — a
 * page's parent is a data_source_id, not a database_id directly. Confirmed live against a real
 * connection/page rather than assumed from docs, since Notion's API had visibly moved past what
 * most current guides describe.
 *
 * Rate-limited to Notion's ~3 req/sec via a simple serializing throttle (minimum gap between
 * calls) — proportionate to household-scale traffic; not a durable job queue. If the process
 * restarts mid-sync, an unsynced write just stays unsynced until the next edit touches that row —
 * acceptable because Postgres, never Notion, is authoritative for identity (see below).
 *
 * notion_sync_map.notion_database_id stores what's actually needed to create pages — the
 * data_source_id — not literally a database_id; that column predates Notion's data-source split
 * and was never renamed for it.
 *
 * Inbound (queryListItemsDataSource, used by plugins/lists/src/notionReconcile.ts on a poll, not
 * a webhook — see spec.md's discussion of why polling was chosen over exposing a new public
 * endpoint) reads every page in the data source. ownerUserId is the bigBrain user any
 * Notion-originated item (one typed directly into Notion, not yet tracked) gets attributed to —
 * this whole gateway is scoped to one Notion workspace tied to one owning bigBrain user; it does
 * not support multiple users each syncing their own separate Notion workspace. Reconciliation
 * only ever adopts a page's Done/Completed-At state from Notion, never its Item/List (name)
 * properties — Postgres stays authoritative for identity; a rename in Notion is simply
 * overwritten back by the next outbound push. That split is deliberate: checking something off
 * in Notion is the explicit feature being built; silently renaming bigBrain's data from an
 * external edit is not.
 *
 * @api-declaration
 * createNotionClient(env) — undefined unless BIGBRAIN_NOTION_TOKEN, BIGBRAIN_NOTION_LISTS_DATA_SOURCE_ID,
 *   and BIGBRAIN_NOTION_OWNER_USER_ID are all set
 * NotionClient.upsertListItemPage({ pageId?, itemName, listName, done, completedAt }) — creates a
 *   page if pageId is omitted, otherwise updates the existing one
 * NotionClient.queryListItemsDataSource() — every page currently in the Lists data source
 *
 * @contract
 *   assertions:
 *     purity:          impure (network call)
 *     state_ownership: [the throttle's nextAvailableAt timestamp]
 *     external_io:     [Notion API]
 */

import { fetchWithRetry } from './httpRetry.js';
import { log } from './logger.js';

const NOTION_VERSION = '2026-03-11';
const MIN_GAP_MS = 350; // keeps calls under Notion's ~3 req/sec even back-to-back

export interface UpsertListItemPageArgs {
  pageId?: string;
  itemName: string;
  listName: string;
  done: boolean;
  completedAt: string | null;
}

export interface NotionListItemPage {
  pageId: string;
  itemName: string;
  listName: string;
  done: boolean;
  completedAt: string | null;
}

export interface NotionClient {
  readonly listsDataSourceId: string;
  readonly ownerUserId: string;
  upsertListItemPage(args: UpsertListItemPageArgs): Promise<{ pageId: string }>;
  queryListItemsDataSource(): Promise<NotionListItemPage[]>;
}

interface NotionConfig {
  token: string;
  listsDataSourceId: string;
  ownerUserId: string;
}

let nextAvailableAt = 0;

async function throttledFetch(url: string, init: RequestInit): Promise<Response> {
  const now = Date.now();
  const waitMs = Math.max(0, nextAvailableAt - now);
  nextAvailableAt = Math.max(now, nextAvailableAt) + MIN_GAP_MS;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  return fetchWithRetry(url, init);
}

function properties(args: UpsertListItemPageArgs) {
  return {
    Item: { title: [{ text: { content: args.itemName } }] },
    List: { select: { name: args.listName } },
    Done: { checkbox: args.done },
    'Completed At': { date: args.completedAt ? { start: args.completedAt } : null },
  };
}

interface NotionPageResponse {
  id: string;
  properties: {
    Item?: { title?: { plain_text: string }[] };
    List?: { select?: { name: string } | null };
    Done?: { checkbox?: boolean };
    'Completed At'?: { date?: { start: string } | null };
  };
}

function parseListItemPage(page: NotionPageResponse): NotionListItemPage {
  return {
    pageId: page.id,
    itemName: page.properties.Item?.title?.map((t) => t.plain_text).join('') ?? '',
    listName: page.properties.List?.select?.name ?? '',
    done: page.properties.Done?.checkbox ?? false,
    completedAt: page.properties['Completed At']?.date?.start ?? null,
  };
}

function createNotionClientImpl(config: NotionConfig): NotionClient {
  const headers = {
    authorization: `Bearer ${config.token}`,
    'notion-version': NOTION_VERSION,
    'content-type': 'application/json',
  };

  return {
    listsDataSourceId: config.listsDataSourceId,
    ownerUserId: config.ownerUserId,

    async upsertListItemPage(args: UpsertListItemPageArgs): Promise<{ pageId: string }> {
      const isUpdate = Boolean(args.pageId);
      const url = isUpdate ? `https://api.notion.com/v1/pages/${args.pageId}` : 'https://api.notion.com/v1/pages';
      const body = isUpdate
        ? { properties: properties(args) }
        : {
            parent: { type: 'data_source_id', data_source_id: config.listsDataSourceId },
            properties: properties(args),
          };

      const response = await throttledFetch(url, {
        method: isUpdate ? 'PATCH' : 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Notion API error ${response.status}: ${errorBody}`);
      }

      const payload = (await response.json()) as { id: string };
      return { pageId: payload.id };
    },

    async queryListItemsDataSource(): Promise<NotionListItemPage[]> {
      const results: NotionListItemPage[] = [];
      let cursor: string | undefined;

      do {
        const response = await throttledFetch(
          `https://api.notion.com/v1/data_sources/${config.listsDataSourceId}/query`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(cursor ? { start_cursor: cursor } : {}),
          },
        );

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Notion API error ${response.status} querying data source: ${errorBody}`);
        }

        const payload = (await response.json()) as {
          results: NotionPageResponse[];
          has_more: boolean;
          next_cursor: string | null;
        };
        results.push(...payload.results.map(parseListItemPage));
        cursor = payload.has_more ? (payload.next_cursor ?? undefined) : undefined;
      } while (cursor);

      return results;
    },
  };
}

export function createNotionClient(env: NodeJS.ProcessEnv = process.env): NotionClient | undefined {
  const token = env.BIGBRAIN_NOTION_TOKEN;
  const listsDataSourceId = env.BIGBRAIN_NOTION_LISTS_DATA_SOURCE_ID;
  const ownerUserId = env.BIGBRAIN_NOTION_OWNER_USER_ID;

  if (!token || !listsDataSourceId || !ownerUserId) {
    log.info(
      'Notion sync not configured (BIGBRAIN_NOTION_TOKEN/BIGBRAIN_NOTION_LISTS_DATA_SOURCE_ID/BIGBRAIN_NOTION_OWNER_USER_ID unset) — lists will not sync to Notion',
    );
    return undefined;
  }

  return createNotionClientImpl({ token, listsDataSourceId, ownerUserId });
}
