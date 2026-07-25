/**
 * @file orchestrator/src/io/accessIdentity.ts
 * @stamp 2026-07-24
 * @architectural-role IO Wrapper — Cloudflare Access JWT verification
 * @description
 * Lets a request that already transited Cloudflare Access on bigbrain.your-domain.example (Google login
 * enforced at the edge, per docker-compose.yml's comment on that hostname) resolve straight to a
 * bigBrain user_id, as an alternative to pasting a BIGBRAIN_API_KEYS bearer key. Access forwards
 * the verified identity as a signed JWT in the Cf-Access-Jwt-Assertion header — trusting it
 * requires verifying that signature against Cloudflare's own published keys (JWKS) for the Access
 * team domain, not just reading the header, since anything reaching the orchestrator by a route
 * other than through Access could otherwise forge it. jose (not hand-rolled crypto) does that
 * verification — this is the same "use a real library for protocol/crypto correctness" precedent
 * this repo already sets with pg for the Postgres wire protocol, not the hand-roll-everything
 * pattern reserved for small self-contained things like the http routing in httpServer.ts.
 *
 * email -> user_id mapping lives in env config (BIGBRAIN_ACCESS_EMAILS), mirroring
 * apiKeyStore.ts's BIGBRAIN_API_KEYS shape exactly — the users table has no email column and
 * never has (db/migrations/0002_schema.sql); "who's allowed to authenticate as which user_id" is
 * bootstrap-level config here, not application data.
 *
 * Fully optional: if BIGBRAIN_ACCESS_TEAM_DOMAIN / BIGBRAIN_ACCESS_AUD / BIGBRAIN_ACCESS_EMAILS
 * aren't all set, userIdForAccessJwt is a permanent no-op — no JWKS fetch is ever attempted. This
 * is what keeps Open WebUI's traffic (container-to-container over traefik-net, never through
 * Cloudflare Access) and local dev/tests unaffected unless this is explicitly configured.
 *
 * @api-declaration
 * parseAccessEmails(raw) — pure; throws on a malformed "email:userId" pair, same style as
 *   apiKeyStore.ts's parser
 * createAccessIdentityResolver(env) -> AccessIdentityResolver
 *   .userIdForAccessJwt(jwt) -> Promise<string | undefined> — never throws; undefined on any
 *     failure (bad signature, expired, wrong audience/issuer, unmapped email, feature unconfigured)
 *
 * @contract
 *   assertions:
 *     purity:          parseAccessEmails is pure; createAccessIdentityResolver's resolver is
 *                      impure (network IO to Cloudflare's JWKS endpoint, cached by jose)
 *     state_ownership: [the email -> user_id map, the cached remote JWKS]
 *     external_io:     [Cloudflare's Access JWKS endpoint]
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface AccessIdentityResolver {
  userIdForAccessJwt(jwt: string): Promise<string | undefined>;
}

export function parseAccessEmails(raw: string): Map<string, string> {
  const map = new Map<string, string>();

  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const [email, userId] = trimmed.split(':');
    if (!email || !userId) {
      throw new Error(`BIGBRAIN_ACCESS_EMAILS entry "${trimmed}" is not in "email:userId" form`);
    }
    map.set(email, userId);
  }

  return map;
}

const NOOP_RESOLVER: AccessIdentityResolver = {
  async userIdForAccessJwt() {
    return undefined;
  },
};

export function createAccessIdentityResolver(env: NodeJS.ProcessEnv = process.env): AccessIdentityResolver {
  const teamDomain = env.BIGBRAIN_ACCESS_TEAM_DOMAIN;
  const aud = env.BIGBRAIN_ACCESS_AUD;
  const emailsRaw = env.BIGBRAIN_ACCESS_EMAILS;

  if (!teamDomain || !aud || !emailsRaw) return NOOP_RESOLVER;

  const emailToUserId = parseAccessEmails(emailsRaw);
  const jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain));

  return {
    async userIdForAccessJwt(jwt) {
      try {
        const { payload } = await jwtVerify(jwt, jwks, {
          issuer: teamDomain,
          audience: aud,
          algorithms: ['RS256'],
        });
        const email = typeof payload.email === 'string' ? payload.email : undefined;
        return email ? emailToUserId.get(email) : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
