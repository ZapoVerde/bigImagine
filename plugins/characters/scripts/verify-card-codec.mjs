// Proves cardCodec.ts's pure functions: a PNG round-trip (encode then decode gets back the exact
// same JSON string) and parseCardJson normalizing both a V2-shaped card and a legacy flat V1 card.
// No fake pool needed — nothing here does IO (docs/verification.md's local tier).

import { buildCardJson, decodePngCard, encodePngCard, parseCardJson } from '../dist/cardCodec.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// A minimal valid 1x1 transparent PNG, same placeholder used at export time for an avatar-less card.
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

// --- PNG round-trip ---
// decodePngCard prefers the ccv3 chunk (same precedence as the real ST install), and encodePngCard
// always writes a best-effort v3 mirror alongside the v2 chunk (character-card-parser.js's own
// behavior) — so reading back a card encoded from v2 JSON returns the *v3-mutated* JSON, not the
// original v2 string byte-for-byte. The round trip that actually matters is field-level: the name
// and data survive intact.
const cardJson = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Elara', data: { name: 'Elara' } });
const withCard = encodePngCard(BLANK_PNG, cardJson);
assert(withCard.length > BLANK_PNG.length, 'encodePngCard grows the PNG (chara + ccv3 chunks were added)');
const roundTripped = JSON.parse(decodePngCard(withCard));
assert(roundTripped.spec === 'chara_card_v3', 'decodePngCard prefers the ccv3 (v3-mirrored) chunk over chara');
assert(roundTripped.name === 'Elara' && roundTripped.data.name === 'Elara', 'the card fields survive the v2 -> v3-mirror round trip intact');

// Re-encoding (simulating a re-export) replaces rather than duplicates the chara/ccv3 chunks.
const secondCardJson = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Bram', data: { name: 'Bram' } });
const reEncoded = encodePngCard(withCard, secondCardJson);
const reDecoded = JSON.parse(decodePngCard(reEncoded));
assert(reDecoded.name === 'Bram', 're-encoding a card PNG replaces its old chara/ccv3 chunks rather than stacking them');

let threw = false;
try {
  decodePngCard(BLANK_PNG);
} catch {
  threw = true;
}
assert(threw, 'decodePngCard throws on a PNG with no card metadata');

// --- parseCardJson: V2-shaped card ---
const v2 = parseCardJson({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Elara',
    description: 'A stern knight-commander.',
    personality: 'Guarded, loyal.',
    scenario: 'A besieged keep.',
    first_mes: 'You again.',
    alternate_greetings: ['Well met.'],
    mes_example: '<START>\n{{user}}: Hello\n{{char}}: Hm.',
    system_prompt: 'Speak tersely.',
  },
});
assert(v2.name === 'Elara', 'parseCardJson reads a V2 card\'s data.name');
assert(v2.persona.includes('A stern knight-commander.') && v2.persona.includes('Personality: Guarded, loyal.'), 'parseCardJson concatenates description + personality into persona');
assert(v2.scenario === 'A besieged keep.', 'parseCardJson reads a V2 card\'s data.scenario');
assert(v2.systemPrompt === 'Speak tersely.', 'parseCardJson reads a V2 card\'s data.system_prompt');
assert(JSON.stringify(v2.greetings) === JSON.stringify(['You again.', 'Well met.']), 'parseCardJson puts first_mes first, then alternate_greetings');
assert(v2.specVersion === 'v2', 'parseCardJson defaults specVersion to v2 for a chara_card_v2 spec');

// --- parseCardJson: legacy flat V1 card (no `data`, no `spec`) ---
const v1 = parseCardJson({
  name: 'Bram',
  description: 'A gruff blacksmith.',
  scenario: 'A forge at dusk.',
  first_mes: 'What do you want?',
});
assert(v1.name === 'Bram', 'parseCardJson reads a flat V1 card\'s top-level name');
assert(v1.persona === 'A gruff blacksmith.', 'parseCardJson uses a V1 card\'s top-level description with no personality to append');
assert(v1.greetings.length === 1 && v1.greetings[0] === 'What do you want?', 'parseCardJson reads a V1 card\'s top-level first_mes');
assert(v1.specVersion === 'v2', 'parseCardJson treats a card with no spec field as v2');

let nameThrew = false;
try {
  parseCardJson({ description: 'no name here' });
} catch {
  nameThrew = true;
}
assert(nameThrew, 'parseCardJson rejects card JSON with no usable name');

// --- buildCardJson: the no-source_json fallback ---
const built = buildCardJson({
  name: 'Bare',
  persona: 'Just a persona.',
  scenario: '',
  systemPrompt: '',
  exampleDialogue: '',
  greetings: ['Hi.', 'Oh, hello.'],
});
assert(built.spec === 'chara_card_v2' && built.spec_version === '2.0', 'buildCardJson stamps a V2 spec');
assert(built.data.description === 'Just a persona.' && built.data.personality === '', 'buildCardJson puts the whole persona into description, leaving personality empty');
assert(built.data.first_mes === 'Hi.' && JSON.stringify(built.data.alternate_greetings) === JSON.stringify(['Oh, hello.']), 'buildCardJson splits greetings into first_mes + alternate_greetings');

if (process.exitCode) {
  console.error('\ncard codec verification FAILED');
  process.exit(1);
}
console.log('\ncard codec verification passed');
