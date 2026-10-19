// Builds a single-file, shareable demo of the dashboard: the real UI (public/) and the real state model
// (src/core) with tools/demo/mock-api.js in place of the server. No login, no backend, example data only.
//   node tools/build-demo.ts [out.html]
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { basename } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const read = (p: string) => readFileSync(root + p, 'utf8');
const out = process.argv[2] ?? root + 'demo.html';

// Dependency order. Each module becomes a scope that returns its exports; the last one (the app) runs at top level.
const MODULES: [key: string, path: string][] = [
  ['types', 'src/core/types.ts'],
  ['state', 'src/core/state.ts'],
  ['ingest', 'src/core/ingest.ts'],
  ['dom', 'public/dom.js'],
  ['format', 'public/format.js'],
  ['cards', 'public/cards.js'],
  ['api', 'tools/demo/mock-api.js'],
  ['app', 'public/app.js'],
];

const keyOf = (spec: string) => basename(spec).replace(/\.(ts|js|json)$/, '');

function transform(source: string): { code: string; exports: string[] } {
  const exports: string[] = [];
  let code = source
    .replace(/^import\s+type\s[^;]+;/gm, '')
    .replace(/import\s+(?:\*\s+as\s+(\w+)|(\w+)|\{([^}]*)\})\s+from\s+['"]([^'"]+)['"];?/g, (_m, ns, def, named, spec) => {
      const mod = `__m[${JSON.stringify(keyOf(spec))}]`;
      if (ns) return `const ${ns} = ${mod};`;
      if (def) return `const ${def} = ${mod}.default;`;
      const names = (named as string)
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n && !n.startsWith('type '))
        .map((n) => n.replace(/\s+as\s+/, ': '));
      return `const { ${names.join(', ')} } = ${mod};`;
    })
    .replace(/^export\s+(async\s+function|function|const|let|class)\s+(\w+)/gm, (_m, kind, name) => {
      exports.push(name);
      return `${kind} ${name}`;
    })
    .replace(/^export\s+(interface|type)\s/gm, '$1 ');
  code = stripTypeScriptTypes(code);
  return { code, exports };
}

let bundle = 'const __m = {};\n';
bundle += `__m["scenario-demo"] = { default: ${read('tests/fixtures/scenario-demo.json').trim()} };\n`;
for (const [key, path] of MODULES) {
  const { code, exports } = transform(read(path));
  if (key === 'app') {
    bundle += `// ---- ${path}\n${code.replace(/if \('serviceWorker' in navigator[\s\S]*?\n\}\n/, '')}\n`;
  } else {
    bundle += `// ---- ${path}\n__m[${JSON.stringify(key)}] = (() => {\n${code}\nreturn { ${exports.join(', ')} };\n})();\n`;
  }
}
bundle += `
document.getElementById('demo-restart').addEventListener('click', () => {
  __m.api.resetDemo();
  window.dispatchEvent(new Event('focus'));
});
// Example sessions do not exist on claude.ai: explain the button instead of opening a dead link.
const demoNote = document.getElementById('demo-note');
const demoNoteText = demoNote.textContent;
let demoNoteTimer;
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href^="https://claude.ai/code/session_01Demo"]');
  if (!link) return;
  e.preventDefault();
  demoNote.textContent = 'Nella versione reale, "Apri in Claude" porta direttamente a quella sessione su claude.ai.';
  clearTimeout(demoNoteTimer);
  demoNoteTimer = setTimeout(() => (demoNote.textContent = demoNoteText), 5000);
}, true);
`;

// The Artifact page contract: tokens on :root, dark values for both the system setting and an explicit choice.
let css = read('public/app.css');
const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n  \}\n\}/.exec(css);
if (!dark) throw new Error('dark token block not found in app.css');
css = css.replace(
  dark[0],
  `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {${dark[1]}\n    color-scheme: dark;\n  }\n}\n` +
    `:root[data-theme="dark"] {${dark[1]}\n  color-scheme: dark;\n}`,
);
css += `
/* ---------- demo build ---------- */
body { min-height: 0; }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--bg); }
.topbar { top: env(safe-area-inset-top, 0px); padding-top: 0; }
.demo-banner { background: var(--surface-2); border-bottom: 1px solid var(--line); color: var(--ink-2); font-size: 0.875rem; }
.demo-banner-inner { max-width: 1200px; margin: 0 auto; padding-block: 10px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; justify-content: space-between; }
.demo-banner strong { color: var(--ink); }
.demo-banner button { font: inherit; font-weight: 600; color: var(--ink); background: var(--surface); border: 1px solid var(--line-strong); border-radius: 999px; padding: 8px 14px; min-height: 36px; cursor: pointer; }
.demo-banner button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
`;

const iconUri = `data:image/svg+xml;base64,${Buffer.from(read('public/icon.svg')).toString('base64')}`;
const html = read('public/index.html');
const body = /<body>([\s\S]*)<\/body>/.exec(html)![1].replaceAll('src="icon.svg"', `src="${iconUri}"`);

const banner = `<div class="demo-banner" role="note"><div class="demo-banner-inner">
  <span id="demo-note" aria-live="polite">Demo con dati di esempio. Nel primo minuto gli agenti cambiano stato da soli, come farebbero quelli veri.</span>
  <button type="button" id="demo-restart">Ricomincia la demo</button>
</div></div>`;

const page = `<title>EvoFlow</title>
<meta name="description" content="Demo di EvoFlow: le sessioni Claude Code in parallelo, chi ti aspetta adesso e perché.">
<style>
${css}
</style>
${banner}
${body.trim()}
<script type="module">
${bundle.replaceAll('</script', '<\\/script')}
</script>
`;
writeFileSync(out, page);
console.log(`demo: ${out} (${(page.length / 1024).toFixed(0)} KB)`);
