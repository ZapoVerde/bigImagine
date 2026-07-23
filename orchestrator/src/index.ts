/**
 * @file orchestrator/src/index.ts
 * @stamp 2026-07-23
 * @architectural-role Orchestrator — process entry point / composition root
 * @description
 * Reads all config exactly once, constructs every IO Wrapper (LLM, embeddings, Postgres pool),
 * dynamically loads whatever plugins are present under BIGBRAIN_PLUGINS_DIR
 * (orchestrator/pluginLoader.ts — no static dependency on any specific plugin package, mirroring
 * SillyTavern's own plugin loader per the build plan), builds the tool registry, and starts the
 * HTTP server. Nothing else imports this file — it's wiring, not a reusable module; the reusable
 * surface is everything under io/ and orchestrator/ that this file assembles.
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
import { createEmbeddingProvider } from './io/embeddings/index.js';
import { createFieldCipher } from './io/fieldCipher.js';
import { createNotionClient } from './io/notion.js';
import { createPostgresClient } from './io/postgres.js';
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
  const llm = createLlmProvider();
  const embeddings = createEmbeddingProvider();
  const cipher = createFieldCipher();
  const notion = createNotionClient();

  const pool = new Pool({
    host: requireEnv('BIGBRAIN_PG_HOST'),
    port: Number(process.env.BIGBRAIN_PG_PORT ?? 5432),
    database: requireEnv('BIGBRAIN_PG_DATABASE'),
    user: requireEnv('BIGBRAIN_PG_APP_USER'),
    password: requireEnv('BIGBRAIN_APP_PASSWORD'),
  });
  const db = createPostgresClient(pool);

  // Default matches the Docker image layout: /app/orchestrator/dist/index.js -> /app/plugins.
  const pluginsDir = process.env.BIGBRAIN_PLUGINS_DIR ?? new URL('../../plugins', import.meta.url).pathname;
  const pluginTools = await loadPlugins(pluginsDir, { llm, embeddings, cipher, notion, db });
  const tools = createToolRegistry(pluginTools);

  const apiKeys = createApiKeyStore(requireEnv('BIGBRAIN_API_KEYS'));
  const port = Number(process.env.BIGBRAIN_ORCHESTRATOR_PORT ?? 8787);

  startHttpServer({ llm, db, tools, apiKeys, modelName: 'bigbrain', port });
}

main().catch((err) => {
  log.error('orchestrator failed to start', err);
  process.exit(1);
});
