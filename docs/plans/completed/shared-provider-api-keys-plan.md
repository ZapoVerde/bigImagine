# Shared Provider API Keys for LLM Connections

*Created 2026-08-18. Governed by `bi_principles.md`. Plan only — **not yet implemented** at time of
writing. Related existing plans: `docs/plans/completed/deepseek-pricing-sync.md` (why a connection's
provider identity matters), `docs/plans/completed/llm-stats-page-plan.md`, and the `bgrm-connection-
purpose.md` plan (a different axis of the same "connection type vocabulary" question).*

---

## Goal

Every LLM connection that talks to the same provider should use that provider's API key **once, set
in one place**, shared in the background by every connection of that provider — not one freshly-typed
(or manually "reuse this other connection's key") key per connection.

Concretely: add discrete `deepseek` and `openrouter` **kinds** to `llm_connections` (alongside the
existing `anthropic` and freeform `openai-compatible`), whose API key is resolved at call time from
the `provider_credentials` row of the same name (`deepseek_api_key` / `openrouter_api_key` — both
already exist there). Rotating the key in Settings rotates it for every DeepSeek/OpenRouter
connection at once. Freeform `openai-compatible` (and `anthropic`) connections keep their own
per-connection key exactly as today, so "any old provider" stays fully flexible.

## Does the "kind" approach work? (Answer to the question asked)

**Yes, and most of the plumbing already exists.** The two halves of this design are already in the
codebase, just not connected:

- `provider_credentials` already carries `deepseek_api_key` and `openrouter_api_key`
  (`orchestrator/src/io/providerCredentials.ts` `CREDENTIAL_NAMES`, migration 0008), is editable from
  the Settings surface (`SettingsView.tsx` renders every `CredentialSummary`), and is the exact
  write-only-at-rest secret store §12 describes.
- The legacy env-seed already resolved those names at boot:
  `index.ts` line 148 `credentials.resolve('deepseek_api_key', profile.apiKey)` — the "provider key,
  shared by name" behavior existed before `llm_connections` existed, and was dropped when connections
  became per-row-key rows.

The gap is only that `llm_connections` (migration 0062) makes every connection own its key
(`api_key_ciphertext not null`), and has no provider identity — a DeepSeek connection is just an
`openai-compatible` row whose `base_url` host happens to be `api.deepseek.com`. That host-inference is
the deeper cause of the friction: there is no way to say "these rows are all the same provider" except
parsing a URL, which is why the only sharing mechanism today is the manual `copyApiKeyFrom` dropdown
and why `deepseekPricingSync` must guess DeepSeek membership by URL host.

Making the provider a first-class `kind` closes both at once: the key is shared by the explicit
provider name, and every provider-specific feature (DeepSeek pricing sync, OpenRouter provider
pinning/reliability) gets a real predicate instead of a URL heuristic. It does **not** weld the
reasoning layer to a vendor (§6): the new kinds dispatch through the *same* capability-based
`openaiCompatible` adapter, never a vendor-specific request path.

### Why `kind` and not a separate `provider` column

- `kind` is already the identity axis in the sibling registry: image connections are
  `kind = 'runware' | 'fal' | 'comfyui'` (migration 0068), provider-as-kind with no separate column.
- The frontend already renders a Kind `<select>`; adding two options is the smallest change to the
  existing mental model.
- `deepseek` and `openrouter` are unambiguous about their adapter (both OpenAI-compatible), so
  overloading `kind` costs nothing today. If a future provider needs to be a named kind *and*
  something other than an OpenAI-shaped adapter, that is a clean new kind + a new dispatch arm in
  `createLlmProviderForProfile` (io/llm/index.ts), not a redesign.

The escape hatch for "I genuinely have two different DeepSeek accounts": `kind = 'openai-compatible'`
with `base_url = https://api.deepseek.com` and its own key — unchanged from today.

---

## Background

### Current behavior

`llm_connections` (migration 0062) is a registry of named connections. Each row has
`kind ('anthropic' | 'openai-compatible')`, `model`, `base_url`, and a **required per-row**
`api_key_ciphertext`. `io/llmConnections.ts` decrypts that ciphertext in `toProfile()` for every
`resolve*` path; `create`/`update` require "exactly one of `apiKey` / `copyApiKeyFrom`".

Sharing a key today means the admin picks "reuse another connection's key" in
`TextConnectionEditor.tsx` — `copyApiKeyFrom` copies one row's ciphertext to another
(`copyCiphertext()`). It is per-connection bookkeeping, not a shared source of truth: rotate the
source and every copied row silently keeps the stale key.

Provider identity is inferred from `base_url`, twice:

- `deepseekPricingSync.ts` → `matchDeepSeekPricing` (`io/llm/deepseekPricing.ts`): a connection is
  "DeepSeek" iff `new URL(baseUrl).host === 'api.deepseek.com'`.
- `TextConnectionEditor.tsx`: the OpenRouter-only fieldsets (provider pinning, reliability sweep) are
  offered to *every* `openai-compatible` connection and 404/no-op for anything that isn't OpenRouter.

### Why the old seed already did this

Pre-`llm_connections`, the LLM key lived in `provider_credentials` for the two named providers and was
resolved by profile *name* (`index.ts` seed lines 146-151). `llm_connections` replaced that with
per-row keys; the `deepseek_api_key`/`openrouter_api_key` names remained in `CREDENTIAL_NAMES` and in
the Settings surface, but now only the one-time seed consults them. This plan reconnects them.

### Desired end state

| kind | adapter | base_url | key source |
|---|---|---|---|
| `anthropic` | anthropic | optional override | per-row (`api_key_ciphertext`) |
| `openai-compatible` | openai-compatible | required, freeform | per-row (`apiKey` or `copyApiKeyFrom`) |
| `deepseek` | openai-compatible | fixed `https://api.deepseek.com` (hidden) | shared `provider_credentials.deepseek_api_key` |
| `openrouter` | openai-compatible | fixed `https://openrouter.ai/api/v1` (hidden) | shared `provider_credentials.openrouter_api_key` |

---

## Files

New:

- `db/migrations/0117_llm_connection_provider_kinds.sql` — widen `kind`'s CHECK, make
  `api_key_ciphertext` nullable with a paired CHECK, and backfill existing rows (see §Logic.2).

Edited:

- `orchestrator/src/io/llmConnections.ts` — `kind` union widens; store gains a
  `credentials: ProviderCredentialStore` dep; `create`/`update` validate per-kind key rules;
  `toProfile` resolves shared keys from `provider_credentials`; `list()`/`toRow` expose
  `usesSharedKey` / `sharedKeyConfigured`.
- `orchestrator/src/io/llm/profiles.ts` — `LlmProfile.kind` widens; `validateProfile` accepts the new
  kinds (and derives their baseUrl when one isn't given).
- `orchestrator/src/io/llm/index.ts` — `createLlmProviderForProfile` dispatches the new kinds to
  `createOpenAiCompatibleLlmProvider` (baseUrl defaulted from the profile).
- `orchestrator/src/index.ts` — `createLlmConnectionStore(db, cipher, credentials)`; the first-boot
  seed creates `kind = 'deepseek'`/`'openrouter'` rows for legacy profiles of those names (the key
  path is unchanged: it already resolves through `provider_credentials`).
- `orchestrator/src/server/adminServer.ts` — `parseCreateConnectionBody` / `parseUpdateConnectionBody`
  accept the new kinds with per-kind key/baseUrl validation.
- `orchestrator/src/io/deepseekPricingSync.ts` — match native DeepSeek connections by
  `kind === 'deepseek'` (retaining the host check as a fallback for freeform rows still pointed at
  `api.deepseek.com`).
- `orchestrator/scripts/probe-provider-reliability.mjs` — resolve the key via the store (or read the
  shared credential) instead of decrypting `api_key_ciphertext` directly, which is now null on
  provider-kind rows.
- `frontend/src/api/types.ts` — widen `kind` in `LlmConnectionSummary` / `CreateConnectionInput` /
  `UpdateConnectionInput`; carry `usesSharedKey`/`sharedKeyConfigured` in the summary.
- `frontend/src/components/connections/TextConnectionEditor.tsx` — Kind `<select>` gains DeepSeek and
  OpenRouter; base-URL field and the whole API-key control are hidden for provider kinds, replaced by
  a "uses the shared X key" readout with configured status; OpenRouter-only fieldsets gate on
  `kind === 'openrouter'`.
- `frontend/src/views/ConnectionsView.tsx` — list rows can badge a provider-kind connection whose
  shared key isn't configured (e.g. `⚠ no shared key`).

Docs:

- `docs/plans/shared-provider-api-keys-plan.md` (this plan).

---

## Logic

### 1. Vocabulary

Widen the connection kind union to `('anthropic' | 'openai-compatible' | 'deepseek' | 'openrouter')`
everywhere it is enumerated:

- `llm_connections.kind` CHECK (migration 0117),
- `LlmConnectionRow.kind` / `ConnectionDbRow.kind` / `LlmConnectionInit.kind` /
  `LlmConnectionPatch` (io/llmConnections.ts),
- `LlmProfile.kind` (io/llm/profiles.ts),
- `createLlmProviderForProfile` dispatch (io/llm/index.ts),
- `parseCreateConnectionBody` / `parseUpdateConnectionBody` (server/adminServer.ts),
- frontend `LlmConnectionSummary` / `CreateConnectionInput` / `UpdateConnectionInput` and the editor's
  `Draft.kind` select.

`deepseek` and `openrouter` both resolve to the `openai-compatible` adapter at dispatch time — the
adapter never grows a vendor branch. `openaiCompatible.ts` needs no change: it is already driven by
`baseUrl`, and OpenRouter's `provider` object is only sent when the profile carries one.

### 2. Migration 0117 (append-only)

```sql
begin;

-- 1. widen kind
alter table llm_connections drop constraint if exists llm_connections_kind_check;
alter table llm_connections add constraint llm_connections_kind_check
  check (kind in ('anthropic', 'openai-compatible', 'deepseek', 'openrouter'));

-- 2. hoist existing DeepSeek/OpenRouter rows' keys into provider_credentials (verbatim
--    ciphertext copy: both columns are AES-256-GCM under the same BIGBRAIN_FIELD_ENCRYPTION_KEY
--    in the same fieldCipher format — io/fieldCipher.ts; no decrypt/re-encrypt needed),
--    then convert those rows to provider kinds and drop their per-row key.
--    A pre-existing provider_credentials row wins (on conflict do nothing): it is the newer,
--    canonical value (the legacy Settings surface already let it be rotated in place).
--    If more than one existing row matches the same provider host with a *different* key
--    (not expected today — confirmed no such rows exist at plan-time — but not schema-enforced
--    either), `order by name` makes "first" a deterministic, reproducible pick (alphabetically
--    first connection name) instead of leaving it to unspecified SELECT row order; every matching
--    row still converts to the provider kind in step 2b regardless of which one won the insert.
insert into provider_credentials (name, ciphertext, updated_at)
select 'deepseek_api_key', api_key_ciphertext, now()
from llm_connections
where kind = 'openai-compatible' and base_url is not null and base_url::text <> ''
  and lower(regexp_replace(regexp_replace(base_url, '^[a-z]+://', ''), '[:/].*$', '')) = 'api.deepseek.com'
order by name
on conflict (name) do nothing;

insert into provider_credentials (name, ciphertext, updated_at)
select 'openrouter_api_key', api_key_ciphertext, now()
from llm_connections
where kind = 'openai-compatible' and base_url is not null and base_url::text <> ''
  and lower(regexp_replace(regexp_replace(base_url, '^[a-z]+://', ''), '[:/].*$', '')) = 'openrouter.ai'
order by name
on conflict (name) do nothing;

-- 2b. every matching row converts, whether or not its own key was the one hoisted in 2 —
--     that's the point of "one shared key per provider" (see §Design Decisions).
update llm_connections set kind = 'deepseek',
  base_url = 'https://api.deepseek.com', api_key_ciphertext = null
where kind = 'openai-compatible' and base_url is not null and base_url::text <> ''
  and lower(regexp_replace(regexp_replace(base_url, '^[a-z]+://', ''), '[:/].*$', '')) = 'api.deepseek.com';

update llm_connections set kind = 'openrouter',
  base_url = 'https://openrouter.ai/api/v1', api_key_ciphertext = null
where kind = 'openai-compatible' and base_url is not null and base_url::text <> ''
  and lower(regexp_replace(regexp_replace(base_url, '^[a-z]+://', ''), '[:/].*$', '')) = 'openrouter.ai';

-- 3. nullable per-row key + the pairing rule
alter table llm_connections alter column api_key_ciphertext drop not null;
alter table llm_connections add constraint llm_connections_key_source_check check (
  (kind in ('deepseek', 'openrouter') and api_key_ciphertext is null) or
  (kind not in ('deepseek', 'openrouter') and api_key_ciphertext is not null)
);

grant select, insert, update, delete on llm_connections to bigimagine_app; -- unchanged, restated

commit;
```

The whole migration runs as one transaction (`begin`/`commit`) rather than relying on psql's
per-statement autocommit: steps 2-3 mix DDL (constraint changes) with data backfill across two
tables, and a mid-script failure under autocommit would leave hoisted keys and converted rows
committed with no way to roll back by hand. One transaction means it's all-or-nothing, matching
half of this repo's existing multi-statement migrations.

The `regexp_replace` host extraction is deliberately narrow (scheme stripped, then first
`[:/]` and everything after removed) so only exact `api.deepseek.com` / `openrouter.ai` hosts convert.
Rows that don't parse (no scheme, trailing slash handled, proxy hosts, `openrouter.ai.` oddities)
stay freeform with their own key — a safe, silent no-op. The matching text is kept identical in
spirit to `matchDeepSeekPricing`'s host check so the migration and runtime agree.

### 3. Shared-key resolution (the "in the background" part)

`createLlmConnectionStore` gains a `credentials: ProviderCredentialStore` parameter (already in scope
at the `index.ts` construction site, and already a `HttpServerDeps` member for the admin routes).

Per-provider key name:

```ts
const SHARED_CREDENTIAL_BY_KIND: Record<'deepseek' | 'openrouter', CredentialName> = {
  deepseek: 'deepseek_api_key',
  openrouter: 'openrouter_api_key',
};
```

`toProfile()` for a provider-kind row resolves the key instead of decrypting the row's ciphertext:

```ts
if (row.kind === 'deepseek' || row.kind === 'openrouter') {
  const apiKey = await credentials.resolve(SHARED_CREDENTIAL_BY_KIND[row.kind], undefined);
  if (!apiKey) throw new Error(
    `${SHARED_CREDENTIAL_BY_KIND[row.kind]} is not configured — set the shared ${row.kind} key in Settings`,
  );
  // ...build LlmProfile with base_url from the row (always canonical post-migration)
}
```

`toProfile` becomes async (all `resolve*` call sites are already `async`), and the plaintext key still
never leaves the module — it goes straight into the returned `LlmProfile` for
`createLlmProviderForProfile` exactly as today (§12 preserved; the only difference is *where* the
ciphertext came from). Resolve fails closed with a specific, actionable message (matching the seed's
"`<name>_api_key` has no provider_credentials row" posture, §6): an active provider-kind connection
with no configured key is a misconfiguration, not a graceful-degrade case.

`list()`/`toRow()` expose `usesSharedKey` (kind is a provider kind) and `sharedKeyConfigured` (the
named credential has a row) so the Connections list and editor can show "shared key not configured"
without the frontend fetching credentials separately. Implementation: one extra query in `list()`
mapping the two credential names to `configured`, reused by the editor's readout.

### 4. Create / update validation

`create()`:
- provider kinds: `apiKey` and `copyApiKeyFrom` must be **absent**; `base_url` is force-set to the
  canonical URL (a supplied value is ignored or rejected — ignore, keeping the row self-consistent).
  `api_key_ciphertext` inserts as null.
- freeform kinds (`anthropic`, `openai-compatible`): unchanged — exactly one of `apiKey` /
  `copyApiKeyFrom`, ciphertext encrypted as today.

`update()`:
- provider kinds: `apiKey`/`copyApiKeyFrom` are **rejected** (a shared key is rotated in Settings, not
  per connection); `base_url` change is ignored (canonical wins). A kind change *to* a provider kind
  nulls the row's ciphertext (the connection starts drawing the shared key; if that credential is
  unconfigured the connection is unusable until it is set — surfaced by the new warning below). A kind
  change *away from* a provider kind requires the normal per-row key again.
- freeform kinds: unchanged.

`adminServer.ts` `parseCreateConnectionBody` / `parseUpdateConnectionBody` implement the same rules so
the API can't be used to create an inconsistent row.

### 5. Editor (frontend)

- Kind `<select>` gains `DeepSeek` and `OpenRouter` options (order: `OpenAI-compatible`, `DeepSeek`,
  `OpenRouter`, `Anthropic`).
- For provider kinds: Base URL field hidden; the whole "API key" control (source select + new-key
  input + reuse dropdown) hidden, replaced with a readout sourced from `usesSharedKey` /
  `sharedKeyConfigured`:
  - configured → "Uses the shared DeepSeek/OpenRouter key — rotate it once in Settings."
  - not configured → "Uses the shared DeepSeek/OpenRouter key, which isn't set yet — set it in
    Settings before this connection can serve." plus an inline warning on Save.
- Changing kind to a provider kind on an existing freeform connection shows a confirm:
  "This connection will stop using its own key and draw the shared DeepSeek/OpenRouter key instead."
- OpenRouter-only fieldsets (provider pinning, reliability sweep, pricing autofill via `/models`)
  gate on `kind === 'openrouter'` instead of "any openai-compatible".
- Save validation drops the key-required error for provider kinds (currently `draft.keySource ===
  'new' && !draft.apiKey` and `isNew && !draft.keySource`).
- The `keySource` reuse dropdown lists only freeform/anthropic connections as sources (provider-kind
  rows have no stored key to copy) — already kind-filtered, just needs the provider kinds excluded
  from the source set.

### 6. Provider-specific features, by explicit kind

- **DeepSeek pricing sync** (`deepseekPricingSync.ts`): match `connection.kind === 'deepseek'`
  first; keep `matchDeepSeekPricing`'s host check as an OR for freeform rows still pointed at
  `api.deepseek.com`. This is the same coverage today plus an explicit predicate, and it removes the
  dependence on the row's URL for kind-marked connections. DeepSeek models routed through OpenRouter
  (`kind = 'openrouter'`, `model = 'deepseek/deepseek-chat'`) are *not* native and stay excluded, as
  they are today (their host is `openrouter.ai`).
- **OpenRouter pinning/reliability**: no server change (both route through the existing
  `openaiCompatible` adapter and admin preview routes); the editor just stops offering them to
  non-OpenRouter connections, which removes the current 404-on-every-other-provider noise.

### 7. Boot / seed

`index.ts`: `createLlmConnectionStore(db, cipher, credentials)`. The first-boot seed (table empty,
legacy env present) creates `kind = 'deepseek'`/`'openrouter'` rows for legacy profiles named
`deepseek`/`openrouter`, deriving kind from the name it already special-cases for key resolution
(lines 146-151). Other profiles keep `profile.kind`. `resolveActive()` at boot now fails closed on an
active provider-kind connection with an unconfigured shared key (via the `toProfile` throw above) —
same fail-closed posture as the seed's existing key check, and safe post-migration because the
backfill hoisted existing keys.

---

## Contracts

**`orchestrator/src/io/llmConnections.ts`**
- `kind: 'anthropic' | 'openai-compatible' | 'deepseek' | 'openrouter'`; `LlmConnectionRow` gains
  `usesSharedKey: boolean` and `sharedKeyConfigured: boolean` (provider-kind rows only; false/true for
  freeform rows respectively).
- Store API: `createLlmConnectionStore(db, cipher, credentials)`; `create`/`update` accept the new
  kinds and enforce the per-kind key/baseUrl rules; `resolveById`/`resolveByName`/`resolveActive`
  return a usable `LlmProfile` for provider-kind rows only when the shared credential is configured,
  else throw a specific error.
- Never returns plaintext or ciphertext; shared keys are read via `credentials.resolve` (write-only
  secret per §12), per-row keys via `cipher.decrypt` as today.

**`orchestrator/src/io/llm/profiles.ts`**
- `LlmProfile.kind` widens; provider kinds default `baseUrl` to the canonical URL when absent; the
  `openai-compatible requires baseUrl` rule does not apply to provider kinds.

**`orchestrator/src/io/llm/index.ts`**
- `createLlmProviderForProfile` maps `deepseek`/`openrouter` → `createOpenAiCompatibleLlmProvider`.
  No adapter changes.

**`orchestrator/src/server/adminServer.ts`**
- Create: provider kinds need no key, force canonical `base_url`. Update: provider kinds reject
  `apiKey`/`copyApiKeyFrom` and ignore `base_url`. The existing "exactly one of apiKey/copyApiKeyFrom"
  rule applies only to freeform kinds.

**`orchestrator/scripts/probe-provider-reliability.mjs`**
- MUST NOT decrypt a null `api_key_ciphertext`; resolve the key via the store/credentials like the
  runtime does.

**Migration 0117**
- Must be applied **before** deploying the new orchestrator code (or the new kinds + null ciphertext
  backfill land ahead of code that expects them). Standard for this repo: migration first, then
  `scripts/secrets.sh deploy orchestrator`.

---

## Edge Cases

- **Existing native DeepSeek/OpenRouter rows** → converted to provider kinds; their ciphertext is
  hoisted verbatim into `provider_credentials` (only if empty there) and dropped from the row. A row
  whose key was already rotated in Settings keeps the Settings value (the `on conflict do nothing`).
- **Multiple existing rows for the same provider with different keys** → not expected (confirmed no
  such rows exist today) and not schema-enforced against, so the migration still has defined
  behavior if it ever happens: `order by name` makes the hoist deterministic (alphabetically-first
  connection name wins), and every matching row converts to the shared-key kind regardless — the
  losing row's own key is discarded, by design (§Goal: one key per provider). A reproducible,
  known-first-writer rule, not a bug to guard against.
- **Provider key set on the row but the shared credential unconfigured, pre-backfill** → the backfill
  hoists it, so the connection keeps working with the same key, now editable centrally.
- **Shared key rotated in Settings** → every provider-kind connection picks it up at the next
  `resolve*` (per-connection-creation/activation/boot and chat-override paths). No per-connection
  rotation step exists anymore for these kinds — by design.
- **Two different DeepSeek accounts** → second one is `kind = 'openai-compatible'`, own key. The
  escape hatch keeps §6's replaceability (nothing forces you into the shared-key model).
- **Active connection is provider-kind with no configured credential** → boot throws a specific error
  (fail closed, §6). The backfill makes this unreachable for existing deployments; it can only happen
  by creating a provider-kind connection before setting the key, which the editor warns about.
- **`probe-provider-reliability.mjs`** → updated to resolve shared keys, not decrypt the row.
- **`copyApiKeyFrom` still valid?** → yes, for freeform connections (e.g. two connections to one
  self-hosted endpoint). Provider kinds never appear in the source dropdown (no row key to copy), and
  the shared-key mechanism makes the feature moot for named providers — but it stays, it does not
  conflict.
- **Legacy seed re-run on an already-populated table** → never happens (seed is first-boot only).
- **Host detection false-positives** → the migration's host extraction is exact-host only
  (`api.deepseek.com` / `openrouter.ai`); anything ambiguous stays freeform, which is the safe
  direction (keeps its own key).

---

## Tests

Follow the existing verify-script convention (`orchestrator/scripts/verify-*.mjs`, chained in
`npm run verify`; no unit-test framework — fake pools/credentials, per `docs/verification.md`):

- **`verify-server.mjs`** (fake `llm_connections` store already lives there, lines ~119-142):
  - POST create with `kind: 'deepseek'`, no key → 201; row created with null ciphertext.
  - POST create with `kind: 'deepseek'` *and* `apiKey` → 400 (rejected).
  - POST create with `kind: 'openai-compatible'` and neither `apiKey` nor `copyApiKeyFrom` → 400
    (unchanged).
  - PATCH a `deepseek` connection with `apiKey`/`copyApiKeyFrom` → 400.
  - PATCH a freeform connection's kind to `deepseek` → ciphertext nulled, kind/baseUrl canonical.
  - PATCH a `deepseek` connection's kind to `openai-compatible` without a key → 400 (key required
    again).
- **New `verify-llm-connections.mjs`** (or extended `verify-server.mjs`): store-level resolution —
  a `deepseek` row whose fake `credentials.resolve` returns a key yields an `LlmProfile` with that
  key; a row whose credential is absent throws the specific unconfigured error; `list()` reports
  `usesSharedKey`/`sharedKeyConfigured`; freeform rows still decrypt their own ciphertext.
- **`verify-deepseek-pricing.mjs`**: sync matches a `kind === 'deepseek'` row even with a nonstandard
  baseUrl; still matches a freeform row whose host is `api.deepseek.com`; excludes an
  `openrouter`-kind row running `deepseek/deepseek-chat`.
- **`verify-llm-adapters.mjs`**: `createLlmProviderForProfile` with a `deepseek`/`openrouter` profile
  constructs an `openai-compatible` provider (name, baseUrl), exercising the real dispatch.
- **Migration 0117** (deployed-checks or a manual fixture): host-matched rows convert and their keys
  hoist; an existing `provider_credentials` value wins; unparseable hosts stay freeform.
- **Frontend (manual/Cypress if present)**: Kind select shows the four options; provider-kind
  connections hide Base URL + API key and show the shared-key readout; OpenRouter fieldsets appear
  only for `openrouter`; saving a provider-kind connection without a key succeeds.

---

## Design Decisions

Open items to lock before coding:

1. **`kind` vs a separate `provider` column.** This plan recommends the `kind` approach (matches the
   user's framing and the image-connection precedent; smallest UI/schema change). The alternative —
   keep `kind` as pure adapter and add a nullable `provider` column — decouples the two axes but adds
   a column and a second vocabulary for no current benefit. Adopt `kind` unless the operator objects.
2. **Backfill existing rows or leave them.** This plan recommends converting host-matched rows (it is
   the point of the feature and matches how the legacy key already lived). Alternative: only new
   connections get the new kinds; existing rows keep per-row keys and the pricing sync keeps
   host-matching for them. Slightly safer operationally, but leaves the original friction in place for
   everything already configured. Recommend backfill; the migration is written so a converted row's
   key never changes value.
3. **Fail-closed resolution.** Provider-kind `resolve*` throws when the shared key is unconfigured
   (recommended, matches the seed) vs returning `undefined` (treats the connection as "not there",
   which would silently route turns elsewhere). Recommend throw.
4. **`sharedKeyConfigured` in the list payload** (recommended, keeps the Connections UI
   self-contained) vs the editor separately calling the existing `listCredentials` route.

---

## Out of Scope

- Changing `provider_credentials` itself (its two LLM names, write-only shape, and Settings surface
  already cover the need — no migration to that table beyond the backfill inserts).
- Anthropic as a provider-kind: standing rule, and there is no `anthropic_api_key` credential name to
  share; it stays freeform.
- Image connections: separate `kind` vocabulary, separate `api_key_ciphertext`; BGRM etc. untouched.
- Adding new providers (only DeepSeek and OpenRouter become named kinds; anything else is
  `openai-compatible`).
- Removing the `copyApiKeyFrom` mechanism (still used by freeform connections).
- Any adapter/request-shape change: the new kinds reuse the existing OpenAI-compatible adapter
  untouched.

---

## Principles / Conventions in Play

- `bi_principles.md` §4 (explicit over inferred — provider identity stops being inferred from a URL),
  §6 (the reasoning layer stays capability-based; new kinds dispatch to the same shared adapter),
  §8 (io/llmConnections.ts stays an IO Wrapper; the shared-key lookup is IO, no derivation added —
  the provider→credential map is data, not logic), §9 (self-describing module preambles updated),
  §10 (file budget — the store's new rules stay in `llmConnections.ts`, validation in
  `adminServer.ts`, matching in `deepseekPricingSync.ts`/`deepseekPricing.ts`), §11 (log at the
  seams: warn when a provider-kind connection resolves against an unconfigured shared key),
  §12 (shared keys remain write-only, encrypted at rest, never returned), §13 (the key is DB-backed,
  editable from the Settings surface, never `.env`).
- Migrations are **append-only**: the kind widen + null-ciphertext backfill is migration **0117**,
  never an edit to 0062.
- Deploy order: migration first, then `scripts/secrets.sh deploy orchestrator` (migration SQL is
  applied by hand against `bigimagine-postgres`, per 0062's header comment).
