/**
 * Checks that both syntax themes actually reach the page.
 *
 * Shiki writes every token twice — `--shiki-light` and `--shiki-dark` — and
 * something has to turn those variables into a colour. If nothing does, the
 * build still succeeds, the page still looks styled, and one of the two themes
 * is silently wrong: that is how dark mode ended up rendering the light
 * palette's navy strings on a near-black background at 1.4:1.
 *
 * Nothing in a build log would have shown that, which is why it is checked
 * here rather than left to a reader to notice.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../dist');

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(dist);
const pages = files.filter((file) => file.endsWith('.html'));
const stylesheets = new Map(
  files.filter((file) => file.endsWith('.css')).map((file) => [file, readFileSync(file, 'utf8')]),
);

/** Every stylesheet the page pulls in, plus the styles Astro inlined into it. */
function cssFor(html) {
  const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const linked = [...html.matchAll(/href="([^"]+\.css)"/g)].flatMap((m) => {
    const name = m[1].split('/').pop();
    return [...stylesheets].filter(([file]) => file.endsWith(`/${name}`)).map(([, css]) => css);
  });
  return [...inline, ...linked].join('\n');
}

const problems = [];
let withCode = 0;

for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  if (!html.includes('astro-code')) continue;
  withCode += 1;

  const name = page.slice(dist.length);
  const css = cssFor(html);

  for (const variable of ['--shiki-light', '--shiki-dark']) {
    if (!html.includes(`${variable}:`)) {
      problems.push(`${name}: no ${variable} on any token — is defaultColor still false?`);
    }
    if (!css.includes(`var(${variable})`)) {
      problems.push(`${name}: nothing reads var(${variable}), so that theme never applies`);
    }
  }

  /*
   * A baked in `color:#rrggbb` on a token beats both variables and cannot be
   * overridden per scheme, so one theme would be stuck. It reappears the
   * moment `defaultColor` stops being false.
   */
  const baked = [...html.matchAll(/<span style="(color:#[0-9a-fA-F]{3,8}[^"]*)"/g)].filter(
    (match) => !match[1].includes('--shiki-'),
  );
  if (baked.length > 0) {
    problems.push(`${name}: ${baked.length} token(s) with a baked in colour, e.g. ${baked[0][1]}`);
  }
}

process.stdout.write(`${withCode} pages with code blocks checked\n`);

const unique = [...new Set(problems)];
if (unique.length > 0) {
  process.stdout.write(
    `\n${unique.length} problem(s):\n${unique.map((l) => `  ${l}`).join('\n')}\n`,
  );
  process.exit(1);
}

process.stdout.write('Both syntax themes are wired up.\n');
