import { writeFileSync } from 'node:fs';

import { createProgram } from '../cli.js';
import { renderCliReference, REFERENCE_PATH } from './index.js';

/** `npm run docs` — rewrites the generated command reference. */
writeFileSync(REFERENCE_PATH, renderCliReference(createProgram()), 'utf8');
process.stdout.write(`Wrote ${REFERENCE_PATH}\n`);
