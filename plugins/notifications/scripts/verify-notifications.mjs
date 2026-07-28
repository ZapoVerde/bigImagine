// Proves the plugin end to end through info/registerTools (the real loader contract), plus
// ntfyProvider.ts's request/response shape directly against a stubbed global fetch (same approach
// as plugins/web's verify-web-search.mjs), and sendPushNotificationTool.ts's kill-switch/rate-limit/
// logging behavior against a small stateful fake Postgres pool (same style as plugins/temporal's
// verify-temporal.mjs, since this tool genuinely depends on prior notification_logs state).

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';
import { info, registerTools } from '../dist/index.js';
import { createNtfyProvider } from '../dist/ntfyProvider.js';
import { createSendPushNotificationTool } from '../dist/sendPushNotificationTool.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function createFakePool() {
  const logs = [];
  let counter = 0;

  return {
    logs,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          if (sql.includes('insert into notification_logs')) {
            const [userId, title, body, priority, status, error] = params;
            assert(scopedUserId === userId, 'notification_logs insert is scoped to the requesting user');
            logs.push({ notification_id: `log-${++counter}`, user_id: userId, title, body, priority, status, error });
            return { rows: [] };
          }

          if (sql.includes("select count(*)::text as count from notification_logs")) {
            const [userId] = params;
            const count = logs.filter((l) => l.user_id === userId && l.status === 'sent').length;
            return { rows: [{ count: String(count) }] };
          }

          throw new Error(`fake pool: unhandled query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

assert(info.id === 'notifications' && /^[a-z0-9_-]+$/.test(info.id), 'info.id is present and matches the id format pluginLoader.ts requires');

// --- registerTools is best-effort: no ntfy_topic resolved means no tools registered ---
{
  const fakeCredentials = { async resolve() { return undefined; } };
  const fakeSettings = { async get() { return undefined; } };
  const tools = await registerTools({ credentials: fakeCredentials, settings: fakeSettings });
  assert(tools.length === 0, 'registerTools returns no tools when ntfy_topic is unconfigured');
}

// --- registerTools resolves the topic through deps.credentials (not raw env) and registers the
// tool on that alone — ntfy_server_url is never checked here, only live at call time ---
{
  const resolveCalls = [];
  const fakeCredentials = {
    async resolve(name, envFallback) {
      resolveCalls.push({ name, envFallback });
      return 'fake-topic';
    },
  };
  const fakeSettings = { async get() { return undefined; } }; // ntfy_server_url deliberately unset
  const tools = await registerTools({ credentials: fakeCredentials, settings: fakeSettings });
  assert(tools.length === 1, 'registerTools returns the tool once ntfy_topic resolves, even with no ntfy_server_url set yet');
  assert(resolveCalls.some((c) => c.name === 'ntfy_topic'), 'registerTools resolves ntfy_topic through deps.credentials, not process.env directly');

  const registry = createToolRegistry(tools);
  assert(registry.definitions().some((d) => d.name === 'send_push_notification'), 'send_push_notification is registered');
}

// --- ntfyProvider: request shape and response handling ---
{
  const originalFetch = globalThis.fetch;
  let capturedUrl;
  let capturedBody;
  globalThis.fetch = async (url, init) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body);
    return { ok: true, status: 200 };
  };
  try {
    const provider = createNtfyProvider('my-topic');
    const result = await provider.send('https://ntfy.example.com', { title: 'Rain Alert', message: 'Get the laundry in', priority: 'urgent', actionUrl: 'https://example.com', tags: ['warning'] });

    assert(capturedUrl === 'https://ntfy.example.com', 'posts to the configured server url');
    assert(capturedBody.topic === 'my-topic', 'the configured topic is embedded in the request body');
    assert(capturedBody.priority === 5, '"urgent" maps to ntfy priority 5');
    assert(capturedBody.click === 'https://example.com', 'actionUrl maps to "click"');
    assert(Array.isArray(capturedBody.tags) && capturedBody.tags[0] === 'warning', 'tags pass through');
    assert(result.ok === true, 'a successful publish returns {ok: true}');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, async text() { return 'unauthorized'; } });
  try {
    const provider = createNtfyProvider('my-topic');
    const result = await provider.send('https://ntfy.example.com', { title: 't', message: 'm', priority: 'default' });
    assert(result.ok === false && result.error, 'a non-ok HTTP response returns {ok: false, error} rather than throwing');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- sendPushNotificationTool: validation, kill switch, missing server url, rate limit, success/failure logging ---
{
  const fakePool = createFakePool();
  const db = createPostgresClient(fakePool);
  const stubProvider = { async send() { return { ok: true }; } };

  let enabled = false;
  let serverUrl = 'https://ntfy.example.com';
  const settingsFlag = {
    async get(key) {
      if (key === 'notifications_enabled') return String(enabled);
      if (key === 'ntfy_server_url') return serverUrl;
      return undefined;
    },
  };
  const tool = createSendPushNotificationTool(stubProvider, settingsFlag);

  await db.withUserScope('user-a', async (session) => {
    let threw = false;
    try {
      await tool.handler({ title: '' }, { userId: 'user-a', db: session });
    } catch {
      threw = true;
    }
    assert(threw, 'send_push_notification requires non-empty title and message');

    const disabledResult = await tool.handler({ title: 't', message: 'm' }, { userId: 'user-a', db: session });
    assert(disabledResult.sent === false, 'a call while notifications_enabled is not "true" is suppressed, not sent');
    assert(fakePool.logs.some((l) => l.status === 'disabled'), 'a suppressed-by-kill-switch call still writes an audit log row');
  });

  enabled = true;
  serverUrl = undefined;
  await db.withUserScope('user-a', async (session) => {
    const noUrlResult = await tool.handler({ title: 't', message: 'm' }, { userId: 'user-a', db: session });
    assert(noUrlResult.sent === false && /ntfy_server_url/.test(noUrlResult.reason), 'a call with no ntfy_server_url configured is suppressed with a clear reason, not a crash');
  });

  serverUrl = 'https://ntfy.example.com';
  await db.withUserScope('user-a', async (session) => {
    const sentResult = await tool.handler({ title: 't', message: 'm' }, { userId: 'user-a', db: session });
    assert(sentResult.sent === true, 'a call while enabled and under the rate cap sends successfully');
    assert(fakePool.logs.some((l) => l.status === 'sent'), 'a successful send writes an audit log row with status "sent"');
  });

  // Push the fake log past MAX_SENDS_PER_HOUR (10) sent entries for user-a directly, then confirm the next call is rate-limited.
  for (let i = 0; i < 10; i++) {
    fakePool.logs.push({ user_id: 'user-a', status: 'sent' });
  }
  await db.withUserScope('user-a', async (session) => {
    const limitedResult = await tool.handler({ title: 't', message: 'm' }, { userId: 'user-a', db: session });
    assert(limitedResult.sent === false && /rate limit/.test(limitedResult.reason), 'a call past the hourly cap is rate-limited, not sent');
    assert(fakePool.logs.some((l) => l.status === 'rate_limited'), 'a rate-limited call still writes an audit log row');
  });

  // A different user is unaffected by user-a's rate limit (RLS-equivalent scoping in the fake pool).
  await db.withUserScope('user-b', async (session) => {
    const otherUserResult = await tool.handler({ title: 't', message: 'm' }, { userId: 'user-b', db: session });
    assert(otherUserResult.sent === true, "user-b's send is unaffected by user-a's rate limit");
  });

  // A provider failure is logged as 'failed' and thrown, not swallowed.
  const failingProvider = { async send() { return { ok: false, error: 'ntfy returned HTTP 500' }; } };
  const failingTool = createSendPushNotificationTool(failingProvider, settingsFlag);
  await db.withUserScope('user-c', async (session) => {
    let threw = false;
    try {
      await failingTool.handler({ title: 't', message: 'm' }, { userId: 'user-c', db: session });
    } catch {
      threw = true;
    }
    assert(threw, 'a genuine provider failure throws rather than returning a soft result');
    assert(fakePool.logs.some((l) => l.user_id === 'user-c' && l.status === 'failed'), 'a provider failure still writes an audit log row with status "failed"');
  });
}
