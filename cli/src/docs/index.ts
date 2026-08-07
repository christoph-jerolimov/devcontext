import { resolve } from 'node:path';

export { renderCliReference } from './reference.js';

/** Where the generated command reference lives, relative to this module. */
export const REFERENCE_PATH = resolve(import.meta.dirname, '../../../docs/commands.md');
