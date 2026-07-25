# Adding a household member

There is no signup flow — a "user" is just a row in `users` (`db/migrations/0002_schema.sql`)
plus one line of env config that maps a way of authenticating to that row's `user_id`. Pick
whichever auth path fits:

## 1. Insert the `users` row (always required)

```sql
insert into users (name) values ('Alex') returning user_id;
```

Note the returned `user_id` — every path below needs it.

## 2a. Manual API key (works everywhere)

Add a `key:user_id` pair to `BIGBRAIN_API_KEYS` in `.env` (comma-separated if more than one
already exists), generate the key with `openssl rand -base64 32`, redeploy. This is the only
option for anything that isn't a browser hitting `bigbrain.your-domain.example` directly — Open WebUI's
chat/tool traffic, for example, always uses this path (`orchestrator/src/server/apiKeyStore.ts`).

The new household member pastes this key into the frontend's unlock screen once; it's then kept
in that browser's `localStorage`.

## 2b. Cloudflare Access SSO (browser access to bigbrain.your-domain.example only)

If `BIGBRAIN_ACCESS_TEAM_DOMAIN`/`BIGBRAIN_ACCESS_AUD` are already configured (see
`.env.example`), add an `email:user_id` pair to `BIGBRAIN_ACCESS_EMAILS` instead — same
comma-separated shape as `BIGBRAIN_API_KEYS`, just keyed by the Google email that logs into
Cloudflare Access rather than a bearer token (`orchestrator/src/io/accessIdentity.ts`). The
household member also needs to be added as an allowed identity in the Cloudflare Access
application itself (Zero Trust dashboard) — this env var only controls what bigBrain does once
Access has already let the request through, not who Access lets through in the first place.

Once both are set, that person's browser needs no key at all: Cloudflare Access proves who they
are, and this mapping resolves that identity straight to their `user_id`.
