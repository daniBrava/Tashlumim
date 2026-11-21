// Builds dist/: one self-contained index.html (CSS + JS inlined, so caching "/" is enough offline),
// sw.js, manifest, icons and version.json carrying the build id.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const BUILD = process.env.BUILD_ID || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const out = 'dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const js = await build({
  entryPoints: ['src/app.ts'], bundle: true, minify: true, format: 'iife', target: ['safari15'],
  write: false, legalComments: 'none',
});
const css = readFileSync('src/styles.css', 'utf8');
const html = readFileSync('src/index.html', 'utf8')
  .replace('{{CSS}}', () => css)
  .replace('{{BUILD}}', BUILD)
  .replace('{{JS}}', () => js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
writeFileSync(`${out}/index.html`, html);

cpSync('public', out, { recursive: true });
writeFileSync(`${out}/sw.js`, readFileSync('public/sw.js', 'utf8').replace('__BUILD__', BUILD));
writeFileSync(`${out}/version.json`, JSON.stringify({ build: BUILD }));
// Hosting hints: never cache version.json / sw.js / index.html at the edge (Netlify & Cloudflare Pages).
writeFileSync(`${out}/_headers`, `/version.json\n  Cache-Control: no-store\n/sw.js\n  Cache-Control: no-cache\n/\n  Cache-Control: no-cache\n/index.html\n  Cache-Control: no-cache\n/manifest.webmanifest\n  Content-Type: application/manifest+json\n`);
console.log(`built ${out}/ · build ${BUILD} · ${(html.length / 1024).toFixed(0)} KB`);
