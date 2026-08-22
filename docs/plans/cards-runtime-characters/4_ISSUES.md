# Issues Found in Review — Cards / Runtime Characters Implementation

> Reviewed against `1_ARCHITECTURAL_REPORT.md`, `2_BLUEPRINT.md`, and `3_IMPLEMENTATION_PLAN.md`.
> Implementation is committed across: `722f648`, `b25abc2`, `7472d79`, `e5c4e6b`, `cafc832`.

---

## Issue 1 — `cards.card_id` has no default generator; every Card create/import path will throw at runtime

**Severity: Critical (blocks Card creation entirely).**

`db/migrations/0133_cards_runtime_characters_foundation.sql` defines:

```sql
create table cards (
  card_id          uuid primary key,
  ...
);
```

There is no `default gen_random_uuid()`, unlike the legacy table it replaces
(`db/migrations/0044_characters.sql:16`: `character_id uuid primary key default gen_random_uuid()`).
`pgcrypto` is already enabled (`db/migrations/0002_schema.sql`), so the extension isn't the gap —
the `default` clause was simply dropped when the table was redefined.

Every application insert into `cards` omits `card_id` and relies on a database-side default that
does not exist:

- `plugins/cards/src/createCardTool.ts` — `insert into cards (user_id, name, persona, ...) values (...)`
- `plugins/cards/src/insertCardFromCard.ts` — same, the shared file/Chub import path

Both will fail against real Postgres with a NOT NULL violation on `card_id`. This breaks
`create_card`, `import_card`, `import_card_from_url`, and `search_chub_cards` (Chub import) —
i.e. every way to get a new Card into the system.

**Why it wasn't caught:** `plugins/cards/scripts/verify-cards.mjs`'s fake pool manufactures its own
id (`card-${++sequence}`) in its `insert into cards` handler regardless of what the real SQL
would do, so the test suite passes while the real schema would reject the same call.

**Fix:** add `default gen_random_uuid()` to `cards.card_id` in a follow-up migration (or patch
0133 if it hasn't shipped to production yet).

---

## Issue 2 — Historical chats whose legacy source was a runtime Character (not a Card) silently lose their source reference

**Severity: Medium (data-loss risk for a specific legacy subset; explicitly flagged as an open question by the plan itself but never resolved).**

`0133`'s backfill only sets `chat_sessions.card_id` for chats whose legacy `character_id` pointed
at a status-null (Card) row:

```sql
update chat_sessions s
set card_id = c.character_id
from characters c
where s.character_id = c.character_id
  and c.status is null;
```

The migration's own comment acknowledges the gap it's leaving open:

> "Chats that reference a runtime Character remain nullable until the later RP consumer cutover
> decides how those historical non-Card chats should be represented."

No later task (2.3, 3.2, 4.1, 4.2) actually revisits this. `0134_destructive_cards_cutover.sql`
then unconditionally drops `chat_sessions.character_id` with no re-check:

```sql
alter table chat_sessions drop column if exists character_id;
```

Any chat left with `card_id IS NULL` from the 0133 gap permanently loses all record of what
Card/Character it was originally tied to — there is no fallback, warning, or manual-review step.
If any such rows exist in production data, they're silently orphaned from their source material
(prompt assembly's live Card reads will just see `cardId: null` for them going forward).

**Fix:** before applying 0134, run a query for `chat_sessions where card_id is null and
character_id is not null` and decide explicitly (leave null / point at a placeholder Card /
flag for manual review) rather than letting the destructive migration erase the linkage
unexamined.

---

## Issue 3 — Stale doc comment still describes the old Character-based apply path

**Severity: Low (cosmetic, but exactly the kind of comment drift Blueprint §9 "Documentation/comments requiring semantic cleanup" asked to close).**

`plugins/context-stack-presets/src/applyPromptStackToChatTool.ts:8` still reads:

> "the target chat's linked character_id (db/migrations/0049_chat_kind.sql, stamped by ..."

The column no longer exists post-cutover (dropped in 0134); the code below the comment already
reads `chat_sessions.card_id` / `cards` correctly (lines 88-120). Only the preamble comment is
stale.

**Fix:** update the comment to describe `card_id`/`cards` instead of `character_id`.

---

## Notes / things checked that look correct

- `deleteCardTool.ts` deletes dependent `chat_sessions` before the `cards` row, returns
  `deletedChatIds`, and never touches `characters` — matches AC-16/17/18.
- `chatSessions.ts`'s `forkChat` correctly inherits `parent.cardId` and links (not clones)
  eligible `character_chat_links` rows via `anchor_swipe_id` — matches the independent-start
  vs. fork lineage rules (AC-05 through AC-09).
- `lorebook_card_links` uses its own table with `on delete cascade` FKs to both `cards` and
  `lorebooks`, correctly separate from `lorebook_character_links` — matches AC-26.
- `0134`'s precondition check (`raise exception` if any status-null Card lacks a `cards`
  counterpart) is a good safety gate before the destructive delete.
- Frontend `useTabs.ts` correctly normalizes a persisted `'characters'` tab type to `'cards'`
  one-way, with dedup for chats that already have both — matches AC-06 in Task 3.2.
- `plugins/characters/src/index.ts` now registers only runtime-scoped tools (`get_characters`,
  `get_character`, `update_character`, `delete_character`, `remove_character_from_chat`) — the
  Card-era files (`cardCodec.ts`, `insertCharacterFromCard.ts`, `applyCharacterToChatTool.ts`,
  import/export/Chub tools) are actually gone from `plugins/characters/src/`, not just unregistered.
