// Proves server/handleChubCardDetail.ts's contracts: fullPath validation rejects anything that
// isn't a plain creator/slug path before it reaches the URL builder, the pia-proxy request is
// built correctly, the chub detail node normalizes into the ChubCardDetail shape (description +
// bespoke definition + max_res_url included), and the {status, body} handler maps missing/invalid
// input (400), upstream errors (pass-through status), and network failure (502) correctly.

import {
  fetchChubCardDetail,
  handleChubCardDetail,
  isValidChubFullPath,
  ChubDetailError,
} from '../dist/server/handleChubCardDetail.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function fakeSettings(value) {
  return { get: async (key) => (key === 'pia_proxy_url' ? value : undefined), set: async () => {} };
}

function fakeReq(url) {
  return { url };
}

const realFetch = globalThis.fetch;

// --- fullPath validation ---
{
  assert(isValidChubFullPath('botmaster/sabrina'), 'accepts a plain creator/slug fullPath');
  assert(
    isValidChubFullPath('botmaster/0edb974b-7b04-41bc-a5c8-1c4fcd8aa27a'),
    'accepts chub.ai\'s UUID-style slug shape',
  );
  assert(!isValidChubFullPath(''), 'rejects an empty fullPath');
  assert(!isValidChubFullPath('a b'), 'rejects whitespace');
  assert(!isValidChubFullPath('a?b'), 'rejects a query string');
  assert(!isValidChubFullPath('a#b'), 'rejects a fragment');
  assert(!isValidChubFullPath('a/../b'), 'rejects dot segments');
  assert(!isValidChubFullPath('a//b'), 'rejects empty path segments');
  assert(!isValidChubFullPath('/leading'), 'rejects a leading slash');
  assert(!isValidChubFullPath('a%2e%2eb'), 'rejects percent-encoded characters');
  assert(!isValidChubFullPath('a\u0000b'), 'rejects NUL bytes');
}

// --- handler: missing / invalid fullPath is a 400 before any fetch happens ---
{
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response('{}', { status: 200 });
  };

  const missing = await handleChubCardDetail(fakeReq('/v1/characters/chub-detail'), { settings: fakeSettings('http://pia-proxy:8080') });
  assert(missing.status === 400, 'missing fullPath query param returns 400');
  const invalid = await handleChubCardDetail(
    fakeReq('/v1/characters/chub-detail?fullPath=https%3A%2F%2Fevil.example%2Fx'),
    { settings: fakeSettings('http://pia-proxy:8080') },
  );
  assert(invalid.status === 400, 'an invalid fullPath (URL-like, not creator/slug) returns 400');
  assert(fetched === false, 'no fetch happens for missing/invalid fullPath');
}

// --- fetch: correct pia-proxy request + normalization ---
{
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return new Response(
      JSON.stringify({
        node: {
          fullPath: 'botmaster/sabrina',
          name: 'Sabrina',
          tagline: 'The teenager next door',
          description: 'A long full description.',
          avatar_url: 'https://avatars.charhub.io/avatars/abc.png',
          max_res_url: 'https://avatars.charhub.io/avatars/abc-max.png',
          definition: { first_message: 'Hi!', personality: 'Shy', example_dialogs: ['a', 'b'] },
          topics: ['Slice of Life'],
          starCount: 12,
          rating: 4.5,
          ratingCount: 30,
          nChats: 100,
          nMessages: 999,
          n_favorites: 7,
          nTokens: 512,
          forksCount: 2,
          createdAt: '2026-01-01T00:00:00Z',
          lastActivityAt: '2026-08-01T00:00:00Z',
          verified: true,
          recommended: false,
          hasGallery: true,
        },
      }),
      { status: 200 },
    );
  };

  const detail = await fetchChubCardDetail(fakeSettings('http://pia-proxy:8080'), 'botmaster/sabrina');

  assert(
    requestedUrl === `http://pia-proxy:8080/fetch?url=${encodeURIComponent('https://api.chub.ai/api/characters/botmaster/sabrina?full=true')}`,
    'builds the correct pia-proxy /fetch?url= request against chub\'s detail endpoint',
  );
  assert(detail.name === 'Sabrina' && detail.description === 'A long full description.', 'description and name pass through');
  assert(detail.definition.first_message === 'Hi!' && detail.definition.personality === 'Shy', 'the bespoke definition object passes through as-is');
  assert(detail.maxResUrl === 'https://avatars.charhub.io/avatars/abc-max.png', 'maxResUrl (the card PNG) passes through');
  assert(detail.topics[0] === 'Slice of Life' && detail.nTokens === 512 && detail.verified === true, 'stats/topics normalize');
  assert(detail.nFavorites === 7, 'n_favorites normalizes to nFavorites');
}

// --- fetch: upstream 404 passes through ---
{
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  try {
    await fetchChubCardDetail(fakeSettings('http://pia-proxy:8080'), 'creator/gone');
    assert(false, 'an upstream 404 throws ChubDetailError');
  } catch (err) {
    assert(err instanceof ChubDetailError && err.status === 404, 'an upstream 404 throws ChubDetailError with status 404');
  }
  const handled = await handleChubCardDetail(fakeReq('/v1/characters/chub-detail?fullPath=creator/gone'), {
    settings: fakeSettings('http://pia-proxy:8080'),
  });
  assert(handled.status === 404, 'the handler maps the upstream 404 to a 404 response');
}

// --- handler: network failure is a 502, not a crash ---
{
  globalThis.fetch = async () => {
    throw new Error('connection refused');
  };
  const handled = await handleChubCardDetail(fakeReq('/v1/characters/chub-detail?fullPath=botmaster/sabrina'), {
    settings: fakeSettings('http://pia-proxy:8080'),
  });
  assert(handled.status === 502, 'a thrown fetch failure maps to a 502 response');
}

globalThis.fetch = realFetch;

if (process.exitCode) {
  console.error('\nchub card detail verification FAILED');
  process.exit(1);
}
console.log('\nchub card detail verification passed');
