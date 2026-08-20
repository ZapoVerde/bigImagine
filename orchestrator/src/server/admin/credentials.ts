/**
 * @file orchestrator/src/server/admin/credentials.ts
 * @stamp 2026-08-20
 * @architectural-role Pure Function (request parsing) + IO Wrapper (credential store IO) — the
 * same dual-role split the original adminServer.ts credentials block used; moved here verbatim as
 * part of the adminServer domain split
 * @description
 * Provider credential administration (io/providerCredentials.ts): the one admin rotates a provider
 * credential without a rebuild. Write-only by construction (docs/bb_principles.md §12) —
 * listCredentials only ever reports whether each fixed name (CREDENTIAL_NAMES) is configured and
 * when it was last touched; the value itself never round-trips back out through any admin surface.
 * LLM/image connection CRUD is deliberately elsewhere (admin/llmConnections.ts,
 * admin/imageConnections.ts).
 *
 * @api-declaration
 * parseSetCredentialBody(raw) — validates {name, value}; undefined on any malformed shape
 * listCredentials(store) — CredentialSummary[] for every fixed name in CREDENTIAL_NAMES
 * setCredential(store, name, value) — encrypts + upserts the one named credential
 *
 * @contract
 *   assertions:
 *     purity:          parseSetCredentialBody is pure; the rest are impure (Postgres IO via the
 *                      injected credential store)
 *     state_ownership: []
 *     external_io:     [Postgres (via the injected ProviderCredentialStore)]
 */

import type { CredentialName, CredentialSummary, ProviderCredentialStore } from '../../io/providerCredentials.js';
import { CREDENTIAL_NAMES } from '../../io/providerCredentials.js';

export interface SetCredentialBody {
  name: CredentialName;
  value: string;
}

export function parseSetCredentialBody(raw: unknown): SetCredentialBody | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, value } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !(CREDENTIAL_NAMES as readonly string[]).includes(name)) return undefined;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return { name: name as CredentialName, value };
}

export function listCredentials(store: ProviderCredentialStore): Promise<CredentialSummary[]> {
  return store.list();
}

export function setCredential(store: ProviderCredentialStore, name: CredentialName, value: string): Promise<void> {
  return store.set(name, value);
}