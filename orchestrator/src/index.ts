/**
 * @file orchestrator/src/index.ts
 * @stamp 2026-07-24
 * @architectural-role Orchestrator — process entry point / composition root
 * @description
 * Reads all config exactly once, constructs every IO Wrapper (LLM, embeddings, Postgres pool),
 * dynamically loads whatever plugins are present under BIGBRAIN_PLUGINS_DIR
 * (orchestrator/pluginLoader.ts — no static dependency on any specific plugin package, mirroring
 * SillyTavern's own plugin loader per the build plan), builds the tool registry, and starts the
 * HTTP server. Nothing else imports this file — it's wiring, not a reusable module; the reusable
 * surface is everything under io/ and orchestrator/ that this file assembles.
 *
 * The Postgres pool is constructed before the LLM/embeddings/Notion clients now (previously the
 * reverse), because their credentials may come from provider_credentials
 * (io/providerCredentials.ts) rather than directly from env — deepseek/openrouter's apiKey,
 * BIGBRAIN_EMBEDDINGS_API_KEY, and BIGBRAIN_NOTION_TOKEN are rotated far more often than the rest
 * of this config, and doing so now only requires a value change + restart (restart: unless-stopped
 * in docker-compose.yml), not a rebuild — see orchestrator/src/server/adminServer.ts. The legacy
 * env vars remain the fallback used to seed provider_credentials on first boot after this
 * shipped; once an operator replaces them with providerCredentials.UNMANAGED_SENTINEL, the two
 * explicit checks below make a since-deleted DB row a boot-time failure, not a silent one.
 *
 * @api-declaration
 * (entry point — no exports)
 *
 * @contract
 *   assertions:
 *     purity:          impure (process startup, env, Postgres pool, HTTP listener)
 *     state_ownership: [the pg.Pool this process owns]
 *     external_io:     [Postgres, inbound HTTP]
 */

import { Pool } from 'pg';
import { log } from './io/logger.js';
import { createLlmProvider } from './io/llm/index.js';
import { parseLlmProfiles, withOverriddenApiKeys } from './io/llm/profiles.js';
import { createEmbeddingProvider } from './io/embeddings/index.js';
import { createFieldCipher } from './io/fieldCipher.js';
import { createNotionClient } from './io/notion.js';
import { createPostgresClient } from './io/postgres.js';
import { createProviderCredentialStore } from './io/providerCredentials.js';
import { createToolRegistry } from './orchestrator/toolRegistry.js';
import { loadPlugins } from './orchestrator/pluginLoader.js';
import { createApiKeyStore } from './server/apiKeyStore.js';
import { startHttpServer } from './server/httpServer.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const pool = new Pool({
    host: requireEnv('BIGBRAIN_PG_HOST'),
    port: Number(process.env.BIGBRAIN_PG_PORT ?? 5432),
    database: requireEnv('BIGBRAIN_PG_DATABASE'),
    user: requireEnv('BIGBRAIN_PG_APP_USER'),
    password: requireEnv('BIGBRAIN_APP_PASSWORD'),
  });
  const db = createPostgresClient(pool);

  const cipher = createFieldCipher();
  const credentials = createProviderCredentialStore(db, cipher);

  const rawProfilesJson = requireEnv('BIGBRAIN_LLM_PROFILES');
  const legacyProfiles = parseLlmProfiles(rawProfilesJson);
  const [deepseekKey, openrouterKey, voyageKey, notionToken] = await Promise.all([
    credentials.resolve('deepseek_api_key', legacyProfiles.deepseek?.apiKey),
    credentials.resolve('openrouter_api_key', legacyProfiles.openrouter?.apiKey),
    credentials.resolve('voyage_api_key', process.env.BIGBRAIN_EMBEDDINGS_API_KEY),
    credentials.resolve('notion_token', process.env.BIGBRAIN_NOTION_TOKEN),
  ]);

  // Fail closed explicitly for the LLM keys — validateProfile would otherwise happily accept the
  // post-cutover UNMANAGED_SENTINEL string as "a valid non-empty apiKey" and boot with a dead key
  // that only fails later, at the first real LLM call. Voyage/Notion don't need this:
  // createEmbeddingProvider already throws on an empty apiKey, and an absent Notion token is a
  // legitimately supported "sync disabled" state (io/notion.ts), not a failure.
  if (legacyProfiles.deepseek && !deepseekKey) {
    throw new Error('deepseek_api_key has no provider_credentials row and no usable env fallback');
  }
  if (legacyProfiles.openrouter && !openrouterKey) {
    throw new Error('openrouter_api_key has no provider_credentials row and no usable env fallback');
  }

  const llm = createLlmProvider({
    ...process.env,
    BIGBRAIN_LLM_PROFILES: withOverriddenApiKeys(rawProfilesJson, { deepseek: deepseekKey, openrouter: openrouterKey }),
  });
  const embeddings = createEmbeddingProvider({ ...process.env, BIGBRAIN_EMBEDDINGS_API_KEY: voyageKey ?? '' });
  const notion = createNotionClient({ ...process.env, BIGBRAIN_NOTION_TOKEN: notionToken ?? '' });

  // Default matches the Docker image layout: /app/orchestrator/dist/index.js -> /app/plugins.
  const pluginsDir = process.env.BIGBRAIN_PLUGINS_DIR ?? new URL('../../plugins', import.meta.url).pathname;
  const pluginTools = await loadPlugins(pluginsDir, { llm, embeddings, cipher, notion, db });
  const tools = createToolRegistry(pluginTools);

  const apiKeys = createApiKeyStore(requireEnv('BIGBRAIN_API_KEYS'));
  const adminApiKey = requireEnv('BIGBRAIN_ADMIN_API_KEY');
  const port = Number(process.env.BIGBRAIN_ORCHESTRATOR_PORT ?? 8787);
  // Where other containers on traefik-net (e.g. Open WebUI) actually reach this service — see
  // docker-compose.yml's container_name. Only used to fill in the OpenAPI spec's `servers` entry.
  const publicBaseUrl = process.env.BIGBRAIN_ORCHESTRATOR_BASE_URL ?? 'http://bigbrain-orchestrator:8787';

  startHttpServer({ llm, db, tools, apiKeys, adminApiKey, credentials, modelName: 'bigbrain', port, publicBaseUrl });
}

main().catch((err) => {
  log.error('orchestrator failed to start', err);
  process.exit(1);
});
