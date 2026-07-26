/**
 * @file doc-sandbox/src/index.ts
 * @stamp 2026-07-26
 * @architectural-role Orchestrator — process entry point
 * @description
 * Starts the doc-sandbox HTTP server on BIGBRAIN_DOC_SANDBOX_PORT (default 8788, matching the
 * port docker-compose.yml wires the orchestrator to reach this container on).
 *
 * @api-declaration
 * (none — process entry point only)
 *
 * @contract
 *   assertions:
 *     purity:          impure (process entry point)
 *     state_ownership: []
 *     external_io:     []
 */

import { startServer } from './server.js';

const port = Number(process.env.BIGBRAIN_DOC_SANDBOX_PORT ?? 8788);
startServer(port);
