/**
 * @file orchestrator/src/orchestrator/pluginLoader.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — dynamic plugin discovery and loading
 * @description
 * Mirrors SillyTavern's own server/plugin-loader.js on purpose (per the build plan's decision to
 * reuse that management style): scan a directory, dynamically import() each subdirectory found
 * there, validate a minimal runtime contract rather than trust a compile-time type. This is what
 * lets the orchestrator package have zero build-time dependency on any specific plugin package —
 * plugins/document-ingestion depends on @bigbrain/orchestrator for types, never the reverse,
 * which is what avoids the circular build dependency a static import would otherwise create.
 *
 * A plugin that fails to load — a bad import, a thrown error, a malformed export — is logged
 * and skipped, exactly like ST: one broken plugin never blocks startup or the rest of the
 * plugins, per bb_principles.md §11 (observable failures, not silent or fatal ones).
 *
 * A plugin may optionally export `startBackgroundJobs(deps)` alongside `registerTools` — for
 * work that isn't triggered by a tool call at all, like plugins/lists' Notion reconciliation
 * poll (docs/spec.md §6.4's inbound half). Purely additive and optional, the same capability-flag
 * shape as LlmProvider.listModels: most plugins have no need for it and just don't export it.
 * deps.db is the raw PostgresClient (not a pre-scoped DbSession) specifically so a background job
 * can open its own withUserScope session on its own schedule, independent of any request.
 *
 * @api-declaration
 * loadPlugins(pluginsDir, deps) — returns every RegisteredTool every successfully-loaded plugin
 *   contributed, in discovery order; also calls each plugin's startBackgroundJobs if it exports one
 *
 * @contract
 *   assertions:
 *     purity:          impure (filesystem reads, dynamic import)
 *     state_ownership: []
 *     external_io:     [filesystem, each plugin's own dist/index.js]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { log } from '../io/logger.js';
import type { EmbeddingProvider } from '../io/embeddings/types.js';
import type { FieldCipher } from '../io/fieldCipher.js';
import type { LlmProvider } from '../io/llm/types.js';
import type { NotionClient } from '../io/notion.js';
import type { PostgresClient } from '../io/postgres.js';
import type { RegisteredTool } from './toolRegistry.js';

export interface PluginDeps {
  llm: LlmProvider;
  embeddings: EmbeddingProvider;
  cipher: FieldCipher;
  notion: NotionClient | undefined;
  db: PostgresClient;
}

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
}

interface PluginModule {
  info?: unknown;
  registerTools?: unknown;
  startBackgroundJobs?: unknown;
}

function isPluginInfo(value: unknown): value is PluginInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    /^[a-z0-9_-]+$/.test(v.id) &&
    typeof v.name === 'string' &&
    typeof v.description === 'string'
  );
}

function resolveEntryPoint(pluginDir: string): string | undefined {
  const pkgPath = join(pluginDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { main?: unknown };
      if (typeof pkg.main === 'string') return join(pluginDir, pkg.main);
    } catch (err) {
      log.warn(`plugin at ${pluginDir} has an unreadable package.json, falling back to dist/index.js`, err);
    }
  }
  const defaultEntry = join(pluginDir, 'dist', 'index.js');
  return existsSync(defaultEntry) ? defaultEntry : undefined;
}

export async function loadPlugins(pluginsDir: string, deps: PluginDeps): Promise<RegisteredTool[]> {
  const absoluteDir = resolve(pluginsDir);
  if (!existsSync(absoluteDir)) {
    log.warn(`plugins directory does not exist, nothing to load: ${absoluteDir}`);
    return [];
  }

  const entries = readdirSync(absoluteDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const tools: RegisteredTool[] = [];

  for (const entry of entries) {
    const pluginDir = join(absoluteDir, entry.name);
    try {
      const entryPoint = resolveEntryPoint(pluginDir);
      if (!entryPoint) {
        log.warn(`skipping plugin directory with no resolvable entry point: ${pluginDir}`);
        continue;
      }

      const mod = (await import(pathToFileURL(entryPoint).href)) as PluginModule;

      if (!isPluginInfo(mod.info)) {
        log.warn(`skipping plugin at ${pluginDir}: missing or invalid "info" export`);
        continue;
      }
      if (typeof mod.registerTools !== 'function') {
        log.warn(`skipping plugin "${mod.info.id}": missing "registerTools" export`);
        continue;
      }

      const pluginTools = (await mod.registerTools(deps)) as RegisteredTool[];
      log.info(`loaded plugin "${mod.info.id}" (${pluginTools.length} tool(s))`);
      tools.push(...pluginTools);

      if (typeof mod.startBackgroundJobs === 'function') {
        try {
          mod.startBackgroundJobs(deps);
          log.info(`started background jobs for plugin "${mod.info.id}"`);
        } catch (err) {
          log.error(`plugin "${mod.info.id}" threw starting its background jobs (its tools still loaded fine)`, err);
        }
      }
    } catch (err) {
      log.error(`failed to load plugin at ${pluginDir}`, err);
    }
  }

  return tools;
}
