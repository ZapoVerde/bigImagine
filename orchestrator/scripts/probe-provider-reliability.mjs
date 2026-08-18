// Diagnostic tool, not a verify script — makes real, billed calls against a live OpenRouter
// connection and is never run as part of `npm run verify`. Built for the 2026-08-16 investigation
// into runStreamingRpTurn's "empty reply after 3 retries" error: a reasoning-capable model routed
// through OpenRouter can silently return finish_reason "stop" with zero content and zero reasoning
// tokens, and how often that happens turned out to depend entirely on which upstream provider
// OpenRouter picked — not on prompt content, not on request shape (confirmed against both
// SillyTavern's exact request contract and BigImagine's own). Isolating one provider at a time
// (provider.order: [name], allow_fallbacks: false) revealed some hosts are consistently reliable
// and others consistently aren't, which this script re-measures on demand — that "which hosts are
// good today" answer isn't stable enough to hardcode as a fact, only to keep re-checking.
//
// Sends a fixed, innocuous, synthetic prompt only — never real chat/character content — so it's
// safe to fire at any time without touching private data. Paces requests with a delay (default
// 4s) between every single call, including across providers, after hammering several providers
// back-to-back with no delay in the original investigation tripped 429s on BaseTen/AkashML/Io Net
// and made their real reliability unreadable.
//
// Usage: node scripts/probe-provider-reliability.mjs [connectionName] [attemptsPerProvider] [delayMs]
//   node scripts/probe-provider-reliability.mjs                              # defaults below
//   node scripts/probe-provider-reliability.mjs "Openrouter Deepseek V4" 6 4000
// Must run with the same env vars the orchestrator container has (BIGBRAIN_PG_*, BIGBRAIN_APP_PASSWORD,
// BIGBRAIN_FIELD_ENCRYPTION_KEY) — easiest from inside the container:
//   docker exec bigimagine-orchestrator node /app/orchestrator/scripts/probe-provider-reliability.mjs

import { createFieldCipher } from '../dist/io/fieldCipher.js';
import pg from 'pg';

const CONNECTION_NAME = process.argv[2] ?? 'Openrouter Deepseek V4';
const ATTEMPTS_PER_PROVIDER = Number(process.argv[3] ?? 6);
const DELAY_MS = Number(process.argv[4] ?? 4000);

// The fp8-quantization tier for deepseek/deepseek-v4-flash-0731 as of 2026-08-16 (OpenRouter's own
// provider list for a model shifts over time — re-pull GET /models/{id}/endpoints if this list
// looks stale, rather than trusting it's still current).
const PROVIDERS = [
  'Baidu',
  'GMICloud',
  'Novita',
  'SiliconFlow',
  'CoreWeave',
  'Cloudflare',
  'StreamLake',
  'Parasail',
  'DeepInfra',
  'Mancer 2',
  'BaseTen',
  'AkashML',
  'Io Net',
];

const INNOCUOUS_PROMPT =
  'You are a friendly narrator for a cozy slice-of-life story about a baker in a small town ' +
  'preparing for the weekend market. Write a short, warm opening paragraph introducing the ' +
  'bakery on a sunny morning.';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeOnce(baseUrl, apiKey, model, providerName) {
  const body = {
    model,
    max_tokens: 16384,
    messages: [{ role: 'system', content: INNOCUOUS_PROMPT }],
    provider: { order: [providerName], allow_fallbacks: false },
    reasoning: { exclude: true },
    stream: true,
    stream_options: { include_usage: true },
  };
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, note: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!response.ok) {
    return { ok: false, note: `HTTP ${response.status}` };
  }
  const text = await response.text();
  const lines = text.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
  let contentLen = 0;
  for (const line of lines) {
    try {
      const chunk = JSON.parse(line.slice(6));
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) contentLen += delta.length;
    } catch {
      // non-JSON SSE line — ignore, matches openaiCompatible.ts's own handling
    }
  }
  return { ok: contentLen > 0, note: contentLen > 0 ? `${contentLen} chars` : 'empty' };
}

async function main() {
  const cipher = createFieldCipher();
  const client = new pg.Client({
    host: process.env.BIGBRAIN_PG_HOST,
    port: Number(process.env.BIGBRAIN_PG_PORT ?? 5432),
    database: process.env.BIGBRAIN_PG_DATABASE,
    user: process.env.BIGBRAIN_PG_APP_USER,
    password: process.env.BIGBRAIN_APP_PASSWORD,
  });
  await client.connect();
  const result = await client.query(
    `select model, base_url, kind, api_key_ciphertext from llm_connections where name = $1`,
    [CONNECTION_NAME],
  );

  const row = result.rows[0];
  if (!row) {
    await client.end();
    console.error(`no llm_connections row named "${CONNECTION_NAME}"`);
    process.exitCode = 1;
    return;
  }

  // A provider-kind row (deepseek/openrouter, db/migrations/0117) stores no per-row key — its key is
  // the shared provider_credentials ciphertext of the same name, resolved exactly like the runtime's
  // io/llmConnections.ts does. Freeform rows keep decrypting their own api_key_ciphertext.
  let apiKey = row.api_key_ciphertext ? cipher.decrypt(row.api_key_ciphertext) : null;
  if (!apiKey && (row.kind === 'deepseek' || row.kind === 'openrouter')) {
    const credName = row.kind === 'deepseek' ? 'deepseek_api_key' : 'openrouter_api_key';
    const creds = await client.query(`select ciphertext from provider_credentials where name = $1`, [credName]);
    if (creds.rows[0]) apiKey = cipher.decrypt(creds.rows[0].ciphertext);
  }
  await client.end();

  if (!apiKey) {
    console.error(`no API key available for connection "${CONNECTION_NAME}" (kind ${row.kind}) — the shared provider key isn't configured`);
    process.exitCode = 1;
    return;
  }

  console.log(`probing ${row.model} via ${row.base_url}`);
  console.log(`${ATTEMPTS_PER_PROVIDER} attempts per provider, ${DELAY_MS}ms between every call\n`);

  const summary = {};
  for (const providerName of PROVIDERS) {
    let ok = 0;
    const details = [];
    for (let i = 0; i < ATTEMPTS_PER_PROVIDER; i++) {
      const attempt = await probeOnce(row.base_url, apiKey, row.model, providerName);
      if (attempt.ok) ok++;
      details.push(attempt.note);
      await sleep(DELAY_MS);
    }
    summary[providerName] = `${ok}/${ATTEMPTS_PER_PROVIDER}`;
    console.log(`${providerName}: ${ok}/${ATTEMPTS_PER_PROVIDER}  [${details.join(', ')}]`);
  }

  console.log('\n=== summary ===');
  console.log(JSON.stringify(summary, null, 2));
}

main();
