// Proves the two chub.ai tools end to end: extractChubFullPath's URL/bare-slug parsing,
// search_chub_characters' response normalization, and import_character_card_from_url's full
// fetch-detail -> fetch-PNG -> decode -> insert path — all against a faked global.fetch (pia-proxy
// itself is a live container, not something this local-tier test can reach) and a small fake
// DbSession, same style as verify-http-retry.mjs's faked fetch and verify-characters.mjs's fake
// pool. BIGBRAIN_CHARACTER_MEDIA_DIR must be set (see package.json's verify script) before
// ../dist/index.js is ever imported, since avatarStorage.ts reads it at module load time.

import { encodePngCard } from '../dist/cardCodec.js';
import { extractChubFullPath, createImportCharacterCardFromUrlTool } from '../dist/importCharacterCardFromUrlTool.js';
import { createSearchChubCharactersTool } from '../dist/searchChubCharactersTool.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function fakeSettings(piaProxyUrl) {
  return { get: async (key) => (key === 'pia_proxy_url' ? piaProxyUrl : undefined), set: async () => {} };
}

// --- extractChubFullPath ---
assert(
  extractChubFullPath('https://chub.ai/characters/botmaster/sabrina-abc') === 'botmaster/sabrina-abc',
  'extractChubFullPath pulls the fullPath out of a real chub.ai page URL',
);
assert(
  extractChubFullPath('https://chub.ai/characters/botmaster/sabrina-abc/') === 'botmaster/sabrina-abc',
  'extractChubFullPath strips a trailing slash',
);
assert(extractChubFullPath('botmaster/sabrina-abc') === 'botmaster/sabrina-abc', 'extractChubFullPath accepts a bare fullPath, not just a URL');
{
  let threw = false;
  try {
    extractChubFullPath('https://chub.ai/some/other/page');
  } catch {
    threw = true;
  }
  assert(threw, 'extractChubFullPath throws on a chub.ai URL with no /characters/ segment');
}

// --- search_chub_characters ---
{
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return new Response(
      JSON.stringify({
        data: {
          count: 2,
          nodes: [
            {
              fullPath: 'botmaster/sabrina', name: 'Sabrina', tagline: 'a tagline', avatar_url: 'https://avatars.charhub.io/x/avatar.webp',
              starCount: 120, rating: 4.5, ratingCount: 30, nChats: 900, nMessages: 12000, n_favorites: 55, nTokens: 480, forksCount: 3,
              topics: ['Fantasy', 'Romance'], createdAt: '2026-01-01T00:00:00Z', lastActivityAt: '2026-08-01T00:00:00Z',
              verified: true, recommended: true, hasGallery: true,
            },
            { fullPath: 'someone/no-tagline', name: 'No Tagline' },
          ],
        },
      }),
      { status: 200 },
    );
  };

  const tool = createSearchChubCharactersTool(fakeSettings('http://pia-proxy:8080'));
  const result = await tool.handler({ query: 'sabrina', page: 2 }, {});

  assert(
    requestedUrl.startsWith('http://pia-proxy:8080/fetch?url=') && decodeURIComponent(requestedUrl).includes('search=sabrina') && decodeURIComponent(requestedUrl).includes('page=2'),
    'search_chub_characters builds the correct pia-proxy request with query and page',
  );
  assert(result.count === 2 && result.page === 2, 'search_chub_characters returns the upstream count and requested page');
  assert(result.results.length === 2, 'search_chub_characters normalizes every node with a fullPath and name');
  assert(result.results[0].tagline === 'a tagline' && result.results[0].avatarUrl.includes('avatar.webp'), 'a normalized result keeps tagline/avatarUrl');
  assert(
    result.results[0].starCount === 120 && result.results[0].rating === 4.5 && result.results[0].ratingCount === 30
      && result.results[0].nChats === 900 && result.results[0].nMessages === 12000 && result.results[0].nFavorites === 55
      && result.results[0].nTokens === 480 && result.results[0].forksCount === 3
      && result.results[0].topics.length === 2 && result.results[0].createdAt === '2026-01-01T00:00:00Z'
      && result.results[0].lastActivityAt === '2026-08-01T00:00:00Z'
      && result.results[0].verified === true && result.results[0].recommended === true && result.results[0].hasGallery === true,
    'a normalized result carries all the new stat fields',
  );
  assert(result.results[1].tagline === '' && result.results[1].avatarUrl === '', 'a node missing tagline/avatar_url normalizes to empty strings, not undefined');
  assert(
    result.results[1].starCount === 0 && result.results[1].nTokens === 0 && Array.isArray(result.results[1].topics) && result.results[1].topics.length === 0
      && result.results[1].verified === false && result.results[1].createdAt === '',
    'a node missing the new stat fields normalizes to 0/[]/false/"" defaults, not undefined',
  );
}

// --- search_chub_characters: tags / excludeTags ---
{
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ data: { count: 0, nodes: [] } }), { status: 200 });
  };

  const tool = createSearchChubCharactersTool(fakeSettings('http://pia-proxy:8080'));
  await tool.handler({ tags: ['Fantasy', 'Romance'], excludeTags: ['Horror'] }, {});

  // One decodeURIComponent pass undoes fetchThroughPiaProxy's own encodeURIComponent wrapping, but
  // the comma URLSearchParams put inside the *target* URL's tags= value was itself encoded (%2C)
  // before that wrapping — so it survives as the literal string "%2C" here, not a raw comma.
  const decoded = decodeURIComponent(requestedUrl);
  assert(decoded.includes('tags=Fantasy%2CRomance'), 'search_chub_characters joins tags with a comma');
  assert(decoded.includes('exclude_tags=Horror'), 'search_chub_characters maps excludeTags to exclude_tags');
}

// --- search_chub_characters: sort / minTokens / maxTokens / minRating ---
{
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ data: { count: 0, nodes: [] } }), { status: 200 });
  };

  const tool = createSearchChubCharactersTool(fakeSettings('http://pia-proxy:8080'));
  await tool.handler({ sort: 'download_count', minTokens: 100, maxTokens: 5000, minRating: 4 }, {});

  const decoded = decodeURIComponent(requestedUrl);
  assert(decoded.includes('sort=download_count'), 'search_chub_characters passes sort through unchanged');
  assert(decoded.includes('min_tokens=100'), 'search_chub_characters maps minTokens to min_tokens');
  assert(decoded.includes('max_tokens=5000'), 'search_chub_characters maps maxTokens to max_tokens');
  assert(decoded.includes('min_ai_rating=4'), 'search_chub_characters maps minRating to min_ai_rating');
}

// --- search_chub_characters: an invalid sort value is rejected before any fetch happens ---
{
  const tool = createSearchChubCharactersTool(fakeSettings('http://pia-proxy:8080'));
  let threw = false;
  try {
    await tool.handler({ sort: 'not_a_real_sort' }, {});
  } catch {
    threw = true;
  }
  assert(threw, 'search_chub_characters rejects a sort value outside CHUB_SORT_VALUES');
}

// --- import_character_card_from_url ---
{
  const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const cardJson = JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: 'Sabrina', description: 'A rich entitled character.', first_mes: 'Hey.', mes_example: '', personality: '', scenario: '', system_prompt: '', alternate_greetings: [] },
  });
  const cardPng = encodePngCard(BLANK_PNG, cardJson);

  const fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    const target = new URL(decodeURIComponent(String(url).split('?url=')[1]));
    if (target.hostname === 'api.chub.ai') {
      return new Response(
        JSON.stringify({ node: { name: 'Sabrina', max_res_url: 'https://avatars.charhub.io/avatars/botmaster/sabrina/chara_card_v2.png' } }),
        { status: 200 },
      );
    }
    if (target.hostname === 'avatars.charhub.io') {
      return new Response(cardPng, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response('not found', { status: 404 });
  };

  const inserted = [];
  const fakeDb = {
    async query(sql, params) {
      assert(sql.includes('insert into characters'), 'import_character_card_from_url inserts into characters');
      inserted.push(params);
      return [{ character_id: 'char-chub-1', name: params[1] }];
    },
  };

  const tool = createImportCharacterCardFromUrlTool(fakeSettings('http://pia-proxy:8080'));
  const result = await tool.handler({ url: 'https://chub.ai/characters/botmaster/sabrina' }, { db: fakeDb, userId: 'user-1' });

  assert(fetchCalls.length === 2, 'import_character_card_from_url fetches the character detail, then the card PNG, both through pia-proxy');
  assert(result.characterId === 'char-chub-1' && result.name === 'Sabrina', 'import_character_card_from_url returns the inserted character');
  assert(result.hasAvatar === true, 'a chub import always has an avatar (the PNG it decoded the card from)');
  assert(inserted.length === 1 && inserted[0][0] === 'user-1', 'the insert is scoped to the calling user');
  assert(JSON.parse(inserted[0][8]).data.name === 'Sabrina', 'the exact card JSON decoded from chub\'s PNG is stored as source_json');
}

if (process.exitCode) {
  console.error('\nchub tools verification FAILED');
  process.exit(1);
}
console.log('\nchub tools verification passed');
