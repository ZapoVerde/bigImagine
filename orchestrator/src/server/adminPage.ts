/**
 * @file orchestrator/src/server/adminPage.ts
 * @stamp 2026-07-24
 * @architectural-role Pure Function — deterministic, input-free HTML/JS string
 * @description
 * The one admin page bigBrain has: rotate a provider credential (io/providerCredentials.ts)
 * without a rebuild. Deliberately dependency-free, no framework, no build step — matching this
 * codebase's existing style everywhere else (hand-rolled node:http, no Express). Served
 * unauthenticated at GET /v1/admin (httpServer.ts) since the markup itself carries no secret;
 * the admin key is pasted client-side into a page-scoped JS variable — never localStorage — and
 * sent as a Bearer header only on the two calls this page makes. Never re-displays a saved
 * value: the API this page talks to (adminServer.ts) doesn't return one either.
 *
 * @api-declaration
 * renderAdminPage() — the full HTML document as a string
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export function renderAdminPage(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>bigBrain admin — provider credentials</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  td, th { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #ccc; }
  input, select, button { font-size: 1rem; padding: 0.4rem; margin: 0.2rem 0; }
  input[type=password] { width: 100%; box-sizing: border-box; }
  .badge-yes { color: #0a7a0a; }
  .badge-no { color: #999; }
  .error { color: #b00; }
  fieldset { margin-top: 1.5rem; }
</style>
</head>
<body>
<p><a href="/">&larr; bigBrain</a></p>
<h1>bigBrain — provider credentials</h1>

<div id="unlock">
  <label>Admin API key<br><input type="password" id="adminKey"></label><br>
  <button id="loadBtn">Load</button>
  <div class="error" id="loadError"></div>
</div>

<div id="app" style="display:none">
  <table>
    <thead><tr><th>Name</th><th>Configured</th><th>Last updated</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>

  <fieldset>
    <legend>Set / rotate a credential</legend>
    <select id="name"></select><br>
    <input type="password" id="value" placeholder="new value"><br>
    <button id="saveBtn">Save &amp; Restart</button>
  </fieldset>

  <div id="status"></div>
</div>

<script>
let adminKey = '';

function authHeaders() {
  return { authorization: 'Bearer ' + adminKey, 'content-type': 'application/json' };
}

async function loadCredentials() {
  const res = await fetch('/v1/admin/credentials', { headers: authHeaders() });
  if (!res.ok) {
    document.getElementById('loadError').textContent = res.status === 401 ? 'invalid admin key' : ('error: ' + res.status);
    return;
  }
  const body = await res.json();
  const rows = document.getElementById('rows');
  const select = document.getElementById('name');
  rows.innerHTML = '';
  select.innerHTML = '';
  for (const cred of body.credentials) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + cred.name + '</td>' +
      '<td class="' + (cred.configured ? 'badge-yes' : 'badge-no') + '">' + (cred.configured ? 'configured' : 'not set') + '</td>' +
      '<td>' + (cred.updatedAt || '—') + '</td>';
    rows.appendChild(tr);
    const opt = document.createElement('option');
    opt.value = cred.name;
    opt.textContent = cred.name;
    select.appendChild(opt);
  }
  document.getElementById('unlock').style.display = 'none';
  document.getElementById('app').style.display = 'block';
}

document.getElementById('loadBtn').addEventListener('click', () => {
  adminKey = document.getElementById('adminKey').value;
  document.getElementById('loadError').textContent = '';
  loadCredentials();
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  const name = document.getElementById('name').value;
  const value = document.getElementById('value').value;
  const status = document.getElementById('status');
  status.textContent = '';
  if (!value) { status.textContent = 'enter a value first'; return; }

  const res = await fetch('/v1/admin/credentials', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, value }),
  });
  if (res.status !== 202) {
    status.textContent = 'error: ' + res.status + ' ' + (await res.text());
    return;
  }
  document.getElementById('value').value = '';
  status.textContent = 'Saved. The orchestrator is restarting — this will take a few seconds.';

  const poll = setInterval(async () => {
    try {
      const health = await fetch('/healthz');
      if (health.ok) {
        clearInterval(poll);
        status.textContent = 'Back up — reload to confirm.';
      }
    } catch {
      // still restarting, keep polling
    }
  }, 2000);
});
</script>
</body>
</html>
`;
}
