/**
 * @file orchestrator/src/server/apiKeyStore.ts
 * @stamp 2026-07-23
 * @architectural-role Stateful Owner — the API-key -> user_id map
 * @description
 * The only place BIGBRAIN_API_KEYS is parsed; the sole owner of the resulting map. This is what
 * satisfies bb_principles.md §4 at the HTTP boundary: which user_id a request is scoped to comes
 * from this trusted, server-side lookup keyed by the request's bearer token — never from
 * anything the request body claims. Format: "key1:uuid1,key2:uuid2", one household member per
 * pair; adding a member is a users row plus one new pair here, no code change.
 *
 * @api-declaration
 * createApiKeyStore(raw) — throws if raw is empty/unset or any pair is malformed, rather than
 *   booting a server that would accept zero valid keys
 * ApiKeyStore.userIdForKey(key) — undefined if the key isn't recognized
 *
 * @contract
 *   assertions:
 *     purity:          impure (owns the parsed map)
 *     state_ownership: [the key -> user_id map]
 *     external_io:     []
 */

export interface ApiKeyStore {
  userIdForKey(key: string): string | undefined;
}

export function createApiKeyStore(raw: string): ApiKeyStore {
  const map = new Map<string, string>();

  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const [key, userId] = trimmed.split(':');
    if (!key || !userId) {
      throw new Error(`BIGBRAIN_API_KEYS entry "${trimmed}" is not in "key:userId" form`);
    }
    map.set(key, userId);
  }

  if (map.size === 0) {
    throw new Error('BIGBRAIN_API_KEYS is empty — at least one key:userId pair is required');
  }

  return { userIdForKey: (key) => map.get(key) };
}
