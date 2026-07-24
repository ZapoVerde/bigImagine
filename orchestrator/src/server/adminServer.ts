/**
 * @file orchestrator/src/server/adminServer.ts
 * @stamp 2026-07-24
 * @architectural-role Pure Function (request parsing) + IO Wrapper (credential store IO) — same
 * dual-role split already established by openApiToolServer.ts for this codebase's other
 * additive HTTP surface
 * @description
 * The admin-only counterpart to openApiToolServer.ts: instead of letting an external caller
 * invoke a household-scoped tool, this lets the one admin rotate a provider credential
 * (io/providerCredentials.ts) without a rebuild. Gated by a single static admin bearer key
 * (BIGBRAIN_ADMIN_API_KEY), checked in httpServer.ts via isAdminAuthenticated — deliberately not
 * ApiKeyStore/BIGBRAIN_API_KEYS, since this isn't user data and there is no admin/regular
 * distinction in that per-household-member map (nor should there be one bolted on for this).
 *
 * Never returns a plaintext or ciphertext credential value — listCredentials only ever reports
 * whether each of the four fixed names is configured and when it was last touched. The admin
 * page (adminPage.ts) is built around that: credentials can be set/rotated, never viewed back.
 *
 * @api-declaration
 * parseSetCredentialBody(raw) — validates {name, value}; undefined on any malformed shape
 * listCredentials(store) — CredentialSummary[] for all four fixed names
 * setCredential(store, name, value) — encrypts + upserts the one named credential
 *
 * @contract
 *   assertions:
 *     purity:          parseSetCredentialBody is pure; listCredentials/setCredential are impure
 *                      (Postgres IO via the injected ProviderCredentialStore)
 *     state_ownership: []
 *     external_io:     [Postgres (via the ProviderCredentialStore it's given)]
 */

import type { CredentialName, CredentialSummary, ProviderCredentialStore } from '../io/providerCredentials.js';
import { CREDENTIAL_NAMES } from '../io/providerCredentials.js';

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
