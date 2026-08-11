// verify-character-book-parse.mjs — pure-function tests for util/parseCharacterBookEntries.ts
// (chub-lorebook-import-plan.md §A build order step 1): a hand-built V2 JSON fixture with a
// `character_book` block, plus the no-op cases that must be fast and obvious.
//
// Run: node scripts/verify-character-book-parse.mjs  (chained from the orchestrator verify script)

import { parseCharacterBookEntries, characterBookName } from '../dist/util/parseCharacterBookEntries.js';

let failures = 0;
function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    failures++;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- fixtures ---

const V2_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Bram',
    description: 'A gruff blacksmith.',
    character_book: {
      name: "Bram's Forge",
      description: 'The forge where Bram works.',
      scan_depth: 2,
      token_budget: 2048,
      recursive_scanning: false,
      entries: [
        {
          id: 3,
          keys: ['forge', 'anvil'],
          secondary_keys: ['smithy'],
          comment: 'The forge itself',
          content: 'A roaring forge at the edge of town.',
          constant: false,
          selective: true,
          enabled: true,
          insertion_order: 10,
          position: 'before_char',
          case_sensitive: false,
        },
        {
          // No id → synthesized uid; disabled → disable: true; no comment → name fallback.
          keys: ['Bram'],
          name: "Bram's name",
          content: 'Bram is a gruff blacksmith with a soft spot for stray cats.',
          enabled: false,
          insertion_order: 20,
          position: 'after_char',
        },
      ],
    },
  },
};

const NO_BOOK_CARD = { spec: 'chara_card_v2', data: { name: 'Plain', description: 'Nothing.' } };
const EMPTY_BOOK_CARD = { spec: 'chara_card_v2', data: { name: 'Empty', character_book: { name: 'Empty Book', entries: [] } } };

// --- parseCharacterBookEntries ---

{
  const drafts = parseCharacterBookEntries(V2_CARD);
  assert(drafts !== null && drafts.length === 2, 'a card with a character_book yields one draft per entry');
  const [forge, bram] = drafts ?? [];

  assert(forge.uid === 3, 'an explicit entry id becomes the uid');
  assert(forge.key.join() === 'forge,anvil' && forge.keysecondary.join() === 'smithy', 'keys/secondary_keys map to key/keysecondary');
  assert(forge.comment === 'The forge itself' && forge.content === 'A roaring forge at the edge of town.', 'comment/content map through');
  assert(forge.constant === false && forge.selective === true && forge.disable === false, 'constant/selective/!enabled map through');
  assert(forge.orderValue === 10, 'insertion_order maps to orderValue');
  assert(forge.position === 0, "position 'before_char' maps to 0");
  assert(forge.probability === 100 && forge.depth === null && forge.groupName === '', 'unmapped fields take column defaults');
  assert(forge.sourceJson === V2_CARD.data.character_book.entries[0], 'the whole entry is kept verbatim as source_json');
  assert(forge.sourceJson.case_sensitive === false, 'case_sensitive survives in source_json only (lorebook-plan.md §3c)');

  assert(bram.uid === 0, 'a missing id gets a synthesized uid starting at 0');
  assert(bram.disable === true && bram.comment === "Bram's name", '!enabled → disable, comment falls back to name');
  assert(bram.position === 1, "position 'after_char' maps to 1");
}

{
  // uid synthesis must skip ids already taken by earlier entries.
  const card = {
    data: {
      character_book: {
        entries: [{ id: 0, content: 'a' }, { content: 'b' }, { content: 'c' }],
      },
    },
  };
  const drafts = parseCharacterBookEntries(card);
  assert(drafts !== null && drafts[1].uid === 1 && drafts[2].uid === 2, 'synthesized uids skip ids already taken');
}

{
  // A wild hand-edited card must never produce colliding uids: duplicate, non-integer, or
  // negative explicit ids get remapped through nextFree instead of violating unique (lorebook_id, uid).
  const card = {
    data: {
      character_book: {
        entries: [
          { id: 4, content: 'a' },
          { id: 4, content: 'b' }, // duplicate → remapped
          { id: -2, content: 'c' }, // negative → remapped
          { id: 2.5, content: 'd' }, // non-integer → remapped
          { content: 'e' }, // missing → remapped
        ],
      },
    },
  };
  const drafts = parseCharacterBookEntries(card);
  const uids = (drafts ?? []).map((d) => d.uid);
  assert(new Set(uids).size === uids.length, 'a wild card yields all-unique uids');
  assert(uids[0] === 4 && uids[1] === 0, 'the first duplicate explicit id is honored, the second is remapped to the lowest free uid');
  assert(uids[2] === 1 && uids[3] === 2 && uids[4] === 3, 'negative/non-integer/missing ids fall through to the next free uid in order');
}

{
  const drafts = parseCharacterBookEntries(NO_BOOK_CARD);
  assert(drafts === null, 'a card with no character_book → null (fast no-op)');
  assert(parseCharacterBookEntries(EMPTY_BOOK_CARD) === null, 'an empty entries array → null');
  assert(parseCharacterBookEntries(null) === null && parseCharacterBookEntries('nope') === null, 'non-object card → null');
  assert(parseCharacterBookEntries({ data: { character_book: 'not an object' } }) === null, 'a non-object character_book → null');
}

{
  // Non-object entries are skipped, but a parse yielding zero valid entries is still a no-op.
  const card = { data: { character_book: { entries: [null, 'x', 42] } } };
  assert(parseCharacterBookEntries(card) === null, 'all-invalid entries → null, never an empty array');
  const mixed = { data: { character_book: { entries: [null, { keys: ['ok'], content: 'fine' }] } } };
  const drafts = parseCharacterBookEntries(mixed);
  assert(drafts !== null && drafts.length === 1 && drafts[0].content === 'fine', 'invalid entries are skipped, valid ones survive');
}

// --- characterBookName ---

{
  assert(characterBookName(V2_CARD) === "Bram's Forge", 'character_book.name is readable');
  assert(characterBookName(NO_BOOK_CARD) === null, 'no character_book → null book name');
  assert(characterBookName(EMPTY_BOOK_CARD) === "Empty Book", 'an empty book still has its name');
  assert(characterBookName({ data: { character_book: { name: '   ' } } }) === null, 'a blank name → null (caller falls back)');
}

if (failures > 0) {
  console.error(`\nverify-character-book-parse FAILED (${failures})`);
  process.exit(1);
}
console.log('\nverify-character-book-parse passed');
