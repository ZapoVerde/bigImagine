/**
 * @file orchestrator/src/server/admin/lorebookInterchange.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (world-info entry parsing) + IO Wrapper (Postgres + embedding
 * IO) — the same dual-role split the original adminServer.ts import/export block used; moved here
 * verbatim as part of the adminServer domain split
 * @description
 * The SillyTavern/world-info interchange (docs/lorebook-plan.md §8a step 7, bi_principles.md §7):
 * importing an ST world-info export `{ name, entries: { [uid]: entryObject } }` into a new book
 * and exporting a book back into that shape. Import stores the verbatim entryObject in source_json
 * (nothing lost even though only a subset of fields are modeled as columns); export reverses it —
 * a non-empty source_json round-trips byte-for-byte, and entries created in the BigImagine UI
 * (whose source_json is '{}') reconstruct an ST-shaped object from the modeled columns so the
 * export is still a valid ST import. This is a distinct capability from ordinary lorebook CRUD
 * (admin/lorebooks.ts / admin/lorebookEntries.ts).
 *
 * @api-declaration
 * importLorebookWorldInfo(db, embeddings, userId, name, rawEntries) — creates a book and inserts
 *   its entries in one user-scoped transaction; undefined when the user doesn't exist, the name is
 *   blank, or the entries object is malformed (all-or-nothing). Embeddings are batched in one call
 *   (fail-open: null vectors on provider failure)
 * exportLorebookWorldInfo(db, userId, lorebookId) — { name, entries: { [uid]: entryObject } };
 *   undefined when the book isn't visible to the user
 *
 * @contract
 *   assertions:
 *     purity:          parseWorldInfoEntry is pure; the rest are impure (Postgres IO, embedding IO
 *                      via the injected EmbeddingProvider)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected PostgresClient), EmbeddingProvider (via the
 *                       injected provider)]
 */

import type { PostgresClient } from '../../io/postgres.js';
import type { EmbeddingProvider } from '../../io/embeddings/types.js';
import { toPgVectorLiteral } from '../../util/pgvector.js';
import type { LorebookEntryDraft } from '../../util/parseCharacterBookEntries.js';
import { log } from '../../io/logger.js';

// --- Lorebook import/export (docs/lorebook-plan.md §8a step 7, bi_principles.md §7) ---
// The ST world-info on-disk format (0051's header comment): `{ name, entries: { [uid]: entryObject } }`
// where entryObject is ST's real entry definition (~35 fields, world-info.js
// newWorldInfoEntryDefinition). Import stores the verbatim entryObject in source_json (nothing
// lost even though only a subset of fields are modeled as columns); export reverses it — a
// non-empty source_json round-trips byte-for-byte, and entries created in the BigImagine UI
// (whose source_json is '{}') reconstruct an ST-shaped object from the modeled columns so the
// export is still a valid ST import.

// The draft shape is shared with the chub character_book parser
// (util/parseCharacterBookEntries.ts) — both produce lorebook_entries column values, from
// differently-sourced input.

/** Parses one ST entryObject into the column values. Unknown fields are deliberately ignored —
 *  they live on in source_json. Non-numeric/invalid fields fall back to the column defaults so a
 *  hand-edited export can't poison the row. */
function parseWorldInfoEntry(raw: unknown): LorebookEntryDraft | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
  const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const int = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isInteger(v) ? v : fallback);
  return {
    uid: 0, // filled by the caller from the object key
    key: strArr(e.key),
    keysecondary: strArr(e.keysecondary),
    comment: str(e.comment, ''),
    content: str(e.content, ''),
    constant: bool(e.constant, false),
    selective: bool(e.selective, true),
    disable: bool(e.disable, false),
    orderValue: int(e.order, 100),
    position: int(e.position, 0),
    probability: int(e.probability, 100),
    depth: typeof e.depth === 'number' ? e.depth : null,
    groupName: str(e.group, ''),
    useProbability: bool(e.useProbability, false),
    groupWeight: int(e.groupWeight, 1),
    groupOverride: bool(e.groupOverride, false),
    sticky: int(e.sticky, 0),
    cooldown: int(e.cooldown, 0),
    delay: int(e.delay, 0),
    sourceJson: e,
  };
}

export interface WorldInfoImportResult {
  lorebookId: string;
  name: string;
  entryCount: number;
}

/** Imports an ST world-info export `{ name, entries: { [uid]: entryObject } }` into a new book.
 *  Returns undefined when the user doesn't exist, the name is blank, or the entries object has a
 *  non-integer key / non-object value (all-or-nothing — a malformed export must not half-land).
 *  Embeddings are batched in one call (fail-open: null vectors on provider failure). */
export async function importLorebookWorldInfo(
  db: PostgresClient,
  embeddings: EmbeddingProvider,
  userId: string,
  name: string,
  rawEntries: unknown,
): Promise<WorldInfoImportResult | undefined> {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  if (typeof rawEntries !== 'object' || rawEntries === null || Array.isArray(rawEntries)) return undefined;

  const entries: { uid: number; parsed: LorebookEntryDraft }[] = [];
  for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    const uid = Number(key);
    if (!Number.isInteger(uid) || uid < 0) return undefined;
    const parsed = parseWorldInfoEntry(value);
    if (!parsed) return undefined;
    entries.push({ uid, parsed: { ...parsed, uid } });
  }

  return db.withUserScope(userId, async (session) => {
    const [user] = await session.query<{ user_id: string }>('select user_id from users where user_id = $1', [userId]);
    if (!user) return undefined;
    const [book] = await session.query<{ lorebook_id: string }>(
      'insert into lorebooks (user_id, name) values ($1, $2) returning lorebook_id',
      [userId, trimmed],
    );
    if (!book) return undefined;

    // One batched embed call for every content (fail-open → null vectors, entries still land).
    let vectors: (string | null)[] | null = null;
    try {
      const embedded = await embeddings.embed(entries.map((e) => `${trimmed}\n${e.parsed.content}`));
      vectors = embedded.map((v) => (v ? toPgVectorLiteral(v) : null));
    } catch (err) {
      log.warn('importLorebookWorldInfo: embed failed, importing without vectors', { userId, lorebookId: book.lorebook_id, err });
    }

    for (let i = 0; i < entries.length; i++) {
      const p = entries[i]!.parsed;
      await session.query(
        `insert into lorebook_entries
           (lorebook_id, user_id, uid, key, keysecondary, comment, content, constant, selective,
            disable, order_value, position, probability, depth, group_name, use_probability,
            group_weight, group_override, sticky, cooldown, delay, source_json, vector_embed)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                 $19, $20, $21, $22::jsonb, $23::vector)`,
        [
          book.lorebook_id,
          userId,
          p.uid,
          p.key,
          p.keysecondary,
          p.comment,
          p.content,
          p.constant,
          p.selective,
          p.disable,
          p.orderValue,
          p.position,
          p.probability,
          p.depth,
          p.groupName,
          p.useProbability,
          p.groupWeight,
          p.groupOverride,
          p.sticky,
          p.cooldown,
          p.delay,
          JSON.stringify(p.sourceJson),
          vectors?.[i] ?? null,
        ],
      );
    }
    return { lorebookId: book.lorebook_id, name: trimmed, entryCount: entries.length };
  });
}

interface WorldInfoExportRow {
  uid: number;
  key: string[];
  keysecondary: string[];
  comment: string;
  content: string;
  constant: boolean;
  selective: boolean;
  disable: boolean;
  order_value: number;
  position: number;
  probability: number;
  depth: number | null;
  group_name: string;
  use_probability: boolean;
  group_weight: number;
  group_override: boolean;
  sticky: number;
  cooldown: number;
  delay: number;
  source_json: unknown;
}

/** Reverses an import losslessly (§7): `{ name, entries: { [uid]: entryObject } }` where
 *  entryObject is the verbatim source_json when the entry was imported (non-empty object), or an
 *  ST-shaped reconstruction from the columns for UI-created entries (source_json '{}'). Returns
 *  undefined when the book isn't visible to the user. */
export async function exportLorebookWorldInfo(db: PostgresClient, userId: string, lorebookId: string): Promise<{ name: string; entries: Record<string, unknown> } | undefined> {
  return db.withUserScope(userId, async (session) => {
    const [book] = await session.query<{ name: string }>('select name from lorebooks where lorebook_id = $1', [lorebookId]);
    if (!book) return undefined;
    const rows = await session.query<WorldInfoExportRow>(
      `select uid, key, keysecondary, comment, content, constant, selective, disable, order_value,
              position, probability, depth, group_name, use_probability, group_weight, group_override,
              sticky, cooldown, delay, source_json
       from lorebook_entries
       where lorebook_id = $1 and user_id = $2
       order by uid`,
      [lorebookId, userId],
    );
    const entries: Record<string, unknown> = {};
    for (const r of rows) {
      const hasSource =
        typeof r.source_json === 'object' && r.source_json !== null && Object.keys(r.source_json as object).length > 0;
      entries[String(r.uid)] = hasSource
        ? r.source_json
        : {
            key: r.key,
            keysecondary: r.keysecondary,
            comment: r.comment,
            content: r.content,
            constant: r.constant,
            selective: r.selective,
            disable: r.disable,
            order: r.order_value,
            position: r.position,
            probability: r.probability,
            depth: r.depth,
            group: r.group_name,
            useProbability: r.use_probability,
            groupWeight: r.group_weight,
            groupOverride: r.group_override,
            sticky: r.sticky,
            cooldown: r.cooldown,
            delay: r.delay,
          };
    }
    return { name: book.name, entries };
  });
}