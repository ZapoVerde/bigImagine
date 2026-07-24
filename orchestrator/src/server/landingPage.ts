/**
 * @file orchestrator/src/server/landingPage.ts
 * @stamp 2026-07-24
 * @architectural-role Pure Function — deterministic, input-free HTML/JS string
 * @description
 * The root page at bigbrain.your-domain.example. Dependency-free, no framework, no build step, same
 * precedent as adminPage.ts. Just a title and a hamburger menu linking to Settings (/v1/admin)
 * for now — the planned data verification/visualization surface (docs/spec.md §7 Correction 6)
 * gets its own menu entry here once it exists, rather than this page growing real content early.
 *
 * @api-declaration
 * renderLandingPage() — the full HTML document as a string
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export function renderLandingPage(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>bigBrain</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.5rem; border-bottom: 1px solid #ddd; }
  header h1 { font-size: 1.3rem; margin: 0; }
  .menu-btn { font-size: 1.5rem; background: none; border: none; cursor: pointer; padding: 0.2rem 0.6rem; }
  .menu { position: absolute; top: 3.5rem; right: 1rem; background: #fff; border: 1px solid #ccc; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); display: none; min-width: 10rem; overflow: hidden; }
  .menu.open { display: block; }
  .menu a { display: block; padding: 0.7rem 1rem; text-decoration: none; color: #222; }
  .menu a:hover { background: #f2f2f2; }
  main { max-width: 40rem; margin: 3rem auto; padding: 0 1rem; text-align: center; }
  main p { color: #555; }
</style>
</head>
<body>
<header>
  <h1>bigBrain</h1>
  <button class="menu-btn" id="menuBtn" aria-label="menu">&#9776;</button>
</header>
<nav class="menu" id="menu">
  <a href="/v1/admin">Settings</a>
</nav>
<main>
  <p>Your household's Second Brain.</p>
</main>
<script>
  const btn = document.getElementById('menuBtn');
  const menu = document.getElementById('menu');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', () => menu.classList.remove('open'));
</script>
</body>
</html>
`;
}
