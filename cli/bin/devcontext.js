#!/usr/bin/env node
// Thin launcher so the package can be installed globally and run as `devcontext`.
// The real entry point lives in ../dist/main.js (built from ../src/main.ts).
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const built = resolve(here, '../dist/main.js');

if (!existsSync(built)) {
  process.stderr.write(
    'devcontext: the CLI has not been built yet.\n' +
      'Run "npm run build:cli" in the repository root (or "npm start" inside cli/ for a dev run).\n',
  );
  process.exit(1);
}

await import(pathToFileURL(built).href);
