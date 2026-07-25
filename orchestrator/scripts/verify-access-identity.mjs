// Proves io/accessIdentity.ts actually verifies the Cloudflare Access JWT's signature rather than
// just trusting whatever email is inside it — the single most important property of this module.
// Runs a real local JWKS endpoint and real jose signing/verification; no Cloudflare involved.

import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccessIdentityResolver, parseAccessEmails } from '../dist/io/accessIdentity.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const KID = 'test-key-1';
const AUD = 'test-audience-tag';
const MAPPED_EMAIL = 'jeremy@example.com';
const MAPPED_USER_ID = '11111111-1111-1111-1111-111111111111';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const { publicKey: otherPublicKey, privateKey: otherPrivateKey } = await generateKeyPair('RS256');
void otherPublicKey;

const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256', use: 'sig' };

// A minimal fake of Cloudflare's own /cdn-cgi/access/certs JWKS endpoint.
const jwksServer = createServer((req, res) => {
  if (req.url === '/cdn-cgi/access/certs') {
    const body = JSON.stringify({ keys: [publicJwk] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
const teamDomain = `http://127.0.0.1:${jwksServer.address().port}`;

function sign(claims, { key = privateKey, kid = KID, aud = AUD, iss = teamDomain, exp = '10m' } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt()
    .setIssuer(iss)
    .setAudience(aud)
    .setExpirationTime(exp)
    .sign(key);
}

const env = {
  BIGBRAIN_ACCESS_TEAM_DOMAIN: teamDomain,
  BIGBRAIN_ACCESS_AUD: AUD,
  BIGBRAIN_ACCESS_EMAILS: `${MAPPED_EMAIL}:${MAPPED_USER_ID},other@example.com:22222222-2222-2222-2222-222222222222`,
};
const resolver = createAccessIdentityResolver(env);

// --- Valid, correctly-signed JWT with a mapped email resolves the right user_id ---
{
  const jwt = await sign({ email: MAPPED_EMAIL });
  const userId = await resolver.userIdForAccessJwt(jwt);
  assert(userId === MAPPED_USER_ID, 'a valid Access JWT with a mapped email resolves the correct user_id');
}

// --- Valid, correctly-signed JWT with an email nobody mapped resolves undefined, doesn't throw ---
{
  const jwt = await sign({ email: 'stranger@example.com' });
  const userId = await resolver.userIdForAccessJwt(jwt);
  assert(userId === undefined, 'a validly-signed JWT for an unmapped email resolves undefined, not an error');
}

// --- The core test: a forgery (same kid, wrong private key) is rejected, not trusted ---
{
  const forged = await sign({ email: MAPPED_EMAIL }, { key: otherPrivateKey });
  const userId = await resolver.userIdForAccessJwt(forged);
  assert(userId === undefined, 'a JWT signed with the wrong private key (a forged seal) is rejected');
}

// --- Expired JWT is rejected ---
{
  const expired = await sign({ email: MAPPED_EMAIL }, { exp: '-10s' });
  const userId = await resolver.userIdForAccessJwt(expired);
  assert(userId === undefined, 'an expired JWT is rejected');
}

// --- Wrong audience is rejected ---
{
  const wrongAud = await sign({ email: MAPPED_EMAIL }, { aud: 'someone-elses-app' });
  const userId = await resolver.userIdForAccessJwt(wrongAud);
  assert(userId === undefined, 'a JWT for a different Access application (wrong aud) is rejected');
}

// --- Wrong issuer is rejected ---
{
  const wrongIss = await sign({ email: MAPPED_EMAIL }, { iss: 'https://not-our-team.cloudflareaccess.com' });
  const userId = await resolver.userIdForAccessJwt(wrongIss);
  assert(userId === undefined, 'a JWT from a different Access team domain (wrong iss) is rejected');
}

// --- Garbage input never throws ---
{
  const userId = await resolver.userIdForAccessJwt('not-even-a-jwt');
  assert(userId === undefined, 'garbage input resolves undefined rather than throwing');
}

jwksServer.close();

// --- Unconfigured (any of the three env vars missing) is a permanent, safe no-op ---
{
  const noop = createAccessIdentityResolver({});
  const jwt = await sign({ email: MAPPED_EMAIL });
  const userId = await noop.userIdForAccessJwt(jwt);
  assert(userId === undefined, 'with no BIGBRAIN_ACCESS_* env vars set, the resolver is a no-op');
}
{
  const partial = createAccessIdentityResolver({ BIGBRAIN_ACCESS_TEAM_DOMAIN: teamDomain });
  const jwt = await sign({ email: MAPPED_EMAIL });
  const userId = await partial.userIdForAccessJwt(jwt);
  assert(userId === undefined, 'with only some of the three env vars set, the resolver is still a no-op');
}

// --- parseAccessEmails mirrors apiKeyStore.ts's parser: malformed pairs fail loudly ---
{
  let threw = false;
  try {
    parseAccessEmails('not-a-valid-pair');
  } catch {
    threw = true;
  }
  assert(threw, 'parseAccessEmails throws on a malformed "email:userId" pair');
}
{
  const map = parseAccessEmails(`${MAPPED_EMAIL}:${MAPPED_USER_ID}`);
  assert(map.get(MAPPED_EMAIL) === MAPPED_USER_ID, 'parseAccessEmails parses a well-formed pair correctly');
}

if (process.exitCode) {
  console.error('\naccess identity verification FAILED');
  process.exit(1);
}
console.log('\naccess identity verification passed');
