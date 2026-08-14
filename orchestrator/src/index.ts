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
 * The Postgres pool is constructed before the LLM/embeddings clients now (previously the
 * reverse), because their config may come from the database rather than directly from env —
 * secrets from provider_credentials (io/providerCredentials.ts: deepseek/openrouter's apiKey,
 * BIGBRAIN_EMBEDDINGS_API_KEY), non-secret identifiers from orchestrator_settings
 * (io/orchestratorSettings.ts — docs/bi_principles.md §§12-13 draw that line). Both are rotated far more often than the rest of
 * this config, and doing so now only requires a value change + restart (restart: unless-stopped in
 * docker-compose.yml), not a rebuild — see orchestrator/src/server/adminServer.ts. The legacy env
 * vars remain the fallback used until an operator sets the DB-backed value via the Settings tab;
 * for the two encrypted credentials specifically, once that value is set the store also seeds
 * itself from the env fallback on first read, and replacing that env var with
 * providerCredentials.UNMANAGED_SENTINEL turns a since-deleted DB row into a boot-time failure
 * rather than a silent one (the two explicit checks below).
 *
 * Also disables Node's default Happy Eyeballs (autoSelectFamily) dual-stack connection racing
 * before anything else runs — this container has no working IPv6 route, and any outbound host
 * that happens to publish an AAAA record (confirmed live against Open-Meteo's geocoding API)
 * hangs until timeout instead of falling back to IPv4 promptly. Process-wide, not per-call,
 * since every IO Wrapper's outbound fetch (LLM providers, plugins/web) shares the same broken
 * assumption.
 *
 * llm is wrapped in io/llm/llmGate.ts's gate exactly once, right after construction, per
 * bi_principles.md §14 — every downstream consumer (loadPlugins' deps, startHttpServer's default
 * connection, the agent_routine dispatch loop started below) shares the one gated instance, so
 * none of them has to remember to gate itself.
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

import { setDefaultAutoSelectFamily } from 'node:net';
import { Pool } from 'pg';
import { log } from './io/logger.js';
import { createLlmProviderForProfile } from './io/llm/index.js';
import { createGatedLlmProvider } from './io/llm/llmGate.js';
import { startAgentRoutineDispatchLoop } from './orchestrator/agentRoutineDispatch.js';
import { startChatMemorySyncLoop } from './orchestrator/chatMemorySync.js';
import { startCleanupLoop } from './orchestrator/cleanupLoop.js';
import { parseLlmProfiles } from './io/llm/profiles.js';
import { createLlmConnectionStore } from './io/llmConnections.js';
import { createImageConnectionStore } from './io/imageConnections.js';
import { createEmbeddingProvider } from './io/embeddings/index.js';
import { createRetryingEmbeddingProvider } from './io/embeddings/retry.js';
import { createFieldCipher } from './io/fieldCipher.js';
import { createAccessIdentityResolver } from './io/accessIdentity.js';
import { createChatSessionStore } from './io/chatSessions.js';
import { createPostgresClient } from './io/postgres.js';
import { createProviderCredentialStore } from './io/providerCredentials.js';
import { parseVisionCapableProfiles } from './server/adminServer.js';
import { createOrchestratorSettingsStore } from './io/orchestratorSettings.js';
import { createToolRegistry } from './orchestrator/toolRegistry.js';
import { loadPlugins } from './orchestrator/pluginLoader.js';
import { createApiKeyStore } from './server/apiKeyStore.js';
import { fireLocationImageGeneration } from './server/locationImages.js';
import { startHttpServer } from './server/httpServer.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  // This container has no functional IPv6 route (loopback only), but Node 20+ defaults to Happy
  // Eyeballs (autoSelectFamily) for any hostname that resolves both an A and AAAA record —
  // racing IPv4 against IPv6 rather than trying IPv4 first. Confirmed live: fetch() to
  // geocoding-api.open-meteo.com (which has an AAAA record) hung until timeout, while the exact
  // same origin over a raw IPv4 socket responded in ~200ms — this container's IPv6 attempt isn't
  // failing fast enough for Happy Eyeballs' fallback to matter. Disabling it process-wide is safe
  // here since nothing in this deployment has real IPv6 connectivity to lose, and it protects
  // every future outbound call (any provider, any plugin) from the same failure mode, not just
  // this one host.
  setDefaultAutoSelectFamily(false);

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
  const settings = createOrchestratorSettingsStore(db);
  const llmConnections = createLlmConnectionStore(db, cipher);
  const imageConnections = createImageConnectionStore(db, cipher);

  const voyageKey = await credentials.resolve('voyage_api_key', process.env.BIGBRAIN_EMBEDDINGS_API_KEY);

  // First-boot only: llm_connections (db/migrations/0062) starts empty on a fresh volume, so seed
  // it once from the pre-restructure BIGBRAIN_LLM_PROFILES env var plus whichever profile was
  // active — an existing deployment's connections/keys carry over without a manual DB write on
  // cutover. Every later boot skips this whole block entirely; once at least one row exists this
  // table alone is the source of truth, and admin edits go straight through io/llmConnections.ts,
  // never back through these env vars.
  if ((await llmConnections.list()).length === 0) {
    const legacyProfiles = parseLlmProfiles(requireEnv('BIGBRAIN_LLM_PROFILES'));
    // Mirrors the pre-cutover code's own fallback exactly: a deployment that already switched
    // profiles from the Settings tab has its choice in orchestrator_settings, not the env var —
    // BIGBRAIN_LLM_ACTIVE_PROFILE was only ever the boot-time default for a deployment that never
    // touched that UI. Falling straight to requireEnv here (skipping the DB read) is what broke
    // the real bigimagine-orchestrator deployment on first deploy of this migration: its env var
    // was never set, only orchestrator_settings.active_llm_profile was.
    const activeName = (await settings.get('active_llm_profile')) ?? requireEnv('BIGBRAIN_LLM_ACTIVE_PROFILE');
    if (!legacyProfiles[activeName]) {
      const known = Object.keys(legacyProfiles).join(', ') || '(none defined)';
      throw new Error(`BIGBRAIN_LLM_ACTIVE_PROFILE is "${activeName}", which isn't in BIGBRAIN_LLM_PROFILES — known profiles: ${known}`);
    }
    const visionCapableProfiles = parseVisionCapableProfiles(await settings.get('llm_vision_capable_profiles'));
    for (const [name, profile] of Object.entries(legacyProfiles)) {
      // deepseek/openrouter's key was already DB-rotatable via provider_credentials before this
      // table existed — resolve through it once here so an already-rotated key isn't silently
      // reverted to a stale .env value on cutover; every other profile's key comes straight from
      // its own BIGBRAIN_LLM_PROFILES entry, which was always its only source. Fails closed same
      // as before: a scrubbed post-cutover UNMANAGED_SENTINEL env value with no DB row throws here
      // rather than seeding a dead key that only fails later, at the first real LLM call.
      const apiKey =
        name === 'deepseek'
          ? await credentials.resolve('deepseek_api_key', profile.apiKey)
          : name === 'openrouter'
            ? await credentials.resolve('openrouter_api_key', profile.apiKey)
            : profile.apiKey;
      if (!apiKey) {
        throw new Error(`${name}_api_key has no provider_credentials row and no usable env fallback`);
      }
      const created = await llmConnections.create({
        name,
        kind: profile.kind,
        model: profile.model,
        apiKey,
        baseUrl: profile.baseUrl,
        supportsVision: visionCapableProfiles.includes(name),
      });
      if (name === activeName) await llmConnections.activate(created.id);
    }
  }

  const activeProfile = await llmConnections.resolveActive();
  if (!activeProfile) {
    throw new Error(
      'No active llm_connections row — configure at least one connection and activate it (the Connections tab, or POST /v1/admin/connections)',
    );
  }
  // Gated exactly once, here, per bb_principles.md §14 — everything downstream (every plugin's
  // closed-over llm, the HTTP server's default connection, this process's own agent_routine
  // dispatcher below) shares this one instance, so nothing needs to remember to gate itself. A
  // chat's own per-connection override is the one other place a *new* LlmProvider gets
  // constructed at runtime (server/httpServer.ts) — that call site gates its own throwaway
  // instance the same way, since this wrap can't reach something built after boot.
  const llm = createGatedLlmProvider(createLlmProviderForProfile(activeProfile), db, settings, activeProfile);
  const embeddings = createRetryingEmbeddingProvider(
    createEmbeddingProvider({ ...process.env, BIGBRAIN_EMBEDDINGS_API_KEY: voyageKey ?? '' }),
    settings,
  );

  // Default matches the Docker image layout: /app/orchestrator/dist/index.js -> /app/plugins.
  const pluginsDir = process.env.BIGBRAIN_PLUGINS_DIR ?? new URL('../../plugins', import.meta.url).pathname;
  const pluginTools = await loadPlugins(pluginsDir, { llm, embeddings, cipher, db, credentials, settings });
  const tools = createToolRegistry(pluginTools);

  const apiKeys = createApiKeyStore(requireEnv('BIGBRAIN_API_KEYS'));
  const chats = createChatSessionStore(db);

  // Not a plugin background job (orchestrator/src/orchestrator/agentRoutineDispatch.ts's own doc
  // explains why: it needs the full tool registry and runTurn, neither reachable from inside
  // pluginLoader.ts's plugin-scoped deps) — started directly here, the same composition-root tier
  // startHttpServer is, once every piece it needs (the gated llm above, tools, chats) exists.
  startAgentRoutineDispatchLoop({ db, llm, tools, chats, settings, embeddings });

  // Rolling chat summarization/RAG (docs/chat-memory.md) — same composition-root tier as the
  // dispatch loop above and for the same reason (needs io/llm/callContext.ts's runWithCallContext,
  // not reachable from a plugin). llmConnections lets it build its own throwaway connection when
  // chat_memory_profile names one, the same per-call construction httpServer.ts's own per-chat
  // connection override uses.
  startChatMemorySyncLoop({ db, llm, embeddings, settings, llmConnections });

  // Async heuristic cleanup (migration 0072, plan v2) — the TRG-style rewrite subloop that
  // replaced the inline post-runTurn cleanup LLM preset. Same composition-root tier as the sync
  // loop above and for the same reason (it drives repair prompts through the shared gated llm
  // under callContext's kind 'system' — never capped, per the user's "no cap" call). Needs the
  // chats store for recordSwipe/ensureActiveSwipe writebacks; the engine it runs
  // (orchestrator/cleanupHeuristics.ts) is pure and shared.
  // Optional — a no-op resolver unless BIGBRAIN_ACCESS_TEAM_DOMAIN/AUD/EMAILS are all set. See
  // io/accessIdentity.ts.
  const accessIdentity = createAccessIdentityResolver(process.env);
  const adminApiKey = requireEnv('BIGBRAIN_ADMIN_API_KEY');
  const port = Number(process.env.BIGBRAIN_ORCHESTRATOR_PORT ?? 8787);
  // Not a secret (bb_principles.md §12) — just tells the frontend whether the backup/ sidecar
  // (docker-compose.yml) has real credentials yet, so it can warn instead of silently having no
  // offsite backup. Set alongside the real BIGBRAIN_BACKUP_S3_*/AGE_PUBLIC_KEY vars, never read
  // by this process beyond this boolean (those secrets stay scoped to the backup container only).
  const backupConfigured = process.env.BIGBRAIN_BACKUP_CONFIGURED === 'true';

  // The HTTP layer's deps, built once and shared by the server and the cleanup loop's
  // onLocationScraped hook (location.md §4.3): the deferred post-repair scrape resolves a
  // location, and the same decoupled describe→render chain fires for it as for an immediate
  // scrape — kept out of cleanupLoop.ts's own imports so it never depends on the HTTP layer.
  const httpDeps: Parameters<typeof startHttpServer>[0] = {
    llm,
    db,
    embeddings,
    tools,
    apiKeys,
    accessIdentity,
    chats,
    adminApiKey,
    credentials,
    settings,
    llmConnections,
    imageConnections,
    modelName: 'bigbrain',
    port,
    backupConfigured,
  };

  startCleanupLoop({
    db,
    llm,
    settings,
    chats,
    onLocationScraped: (userId, chatId, locationId) => fireLocationImageGeneration(httpDeps, userId, chatId, locationId, llm),
  });

  startHttpServer(httpDeps);
}

main().catch((err) => {
  log.error('orchestrator failed to start', err);
  process.exit(1);
});
