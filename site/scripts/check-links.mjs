/**
 * Walks the built site and reports internal links that do not resolve.
 *
 * The documentation is written for GitHub, so every cross reference in it is
 * rewritten at build time. This is the check that the rewriting is right —
 * without it a renamed page silently produces a site full of 404s.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');
const base = (process.env.SITE_BASE ?? '/devcontext').replace(/\/$/, '');

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const pages = walk(dist).filter((file) => file.endsWith('.html'));
const assets = new Set(walk(dist).map((file) => file.slice(dist.length)));

/** `/devcontext/docs/sync` is served from `docs/sync/index.html`. */
function resolves(href) {
  const path = href.split('#')[0].split('?')[0].replace(/\/$/, '');
  if (path === base || path === '') return true;
  const relative = path.startsWith(base) ? path.slice(base.length) : path;
  return (
    assets.has(relative) || assets.has(`${relative}/index.html`) || assets.has(`${relative}.html`)
  );
}

const broken = [];
let checked = 0;

for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = match[1];
    if (/^(https?:|mailto:|data:|#)/.test(href)) continue;
    checked += 1;
    if (!resolves(href)) broken.push(`${page.slice(dist.length)} -> ${href}`);
  }
}

const unique = [...new Set(broken)];
process.stdout.write(`${pages.length} pages, ${checked} internal links checked\n`);

if (unique.length > 0) {
  process.stdout.write(`\n${unique.length} broken:\n${unique.map((l) => `  ${l}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write('No broken internal links.\n');
