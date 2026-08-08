/**
 * docs/configuration-reference.md claims to show every key at its default.
 *
 * A claim like that decays the moment somebody changes a default, and nobody
 * notices until a reader trusts the page and is wrong. So the page is checked
 * rather than trusted: the yaml block is parsed and resolved, the result is
 * compared against the defaults the resolver actually applies, and the schema
 * is walked to make sure no key was added without being documented.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import { parseConfig } from './load.js';
import { DEFAULT_GITHUB_SYNC, DEFAULT_JIRA_SYNC, DEFAULT_SYNC_SETTINGS } from './resolve.js';
import { configSchema } from './schema.js';

const PAGE = resolvePath(import.meta.dirname, '../../../docs/configuration-reference.md');
const CONFIG_PATH = '/workspace/devcontext.yaml';

/**
 * Deliberately absent from the page: a token belongs in the environment, and a
 * reference file that shows one teaches the opposite. The page says so in
 * prose; this list is the machine-readable half of that decision.
 */
const UNDOCUMENTED_ON_PURPOSE = new Set(['github.hosts.token', 'jira.sites.token']);

function referenceYaml(): string {
  const page = readFileSync(PAGE, 'utf8');
  const block = /```yaml\n([\s\S]*?)```/.exec(page);
  if (!block?.[1]) throw new Error(`No yaml block found in ${PAGE}`);
  return block[1];
}

/**
 * Looks through optional/nullable/array wrappers to the type underneath.
 *
 * `_zod` is zod's internal shape. Reaching into it is the price of asking the
 * schema what it accepts instead of keeping a second hand written list, which
 * is the exact kind of list this file exists to avoid.
 */
// oxlint-disable-next-line no-underscore-dangle
function inner(schema: unknown): Record<string, unknown> | undefined {
  let current = schema;
  for (let depth = 0; depth < 20; depth += 1) {
    // oxlint-disable-next-line no-underscore-dangle
    const def = (current as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
    if (!def) return undefined;
    if (def['type'] === 'optional' || def['type'] === 'nullable' || def['type'] === 'default') {
      current = def['innerType'];
    } else if (def['type'] === 'array') {
      current = def['element'];
    } else {
      return def;
    }
  }
  return undefined;
}

/** Every path the schema accepts, `a.b.c`, with array levels collapsed. */
function schemaKeys(schema: ZodType, prefix = '', found = new Set<string>()): Set<string> {
  const def = inner(schema);
  if (def?.['type'] === 'object') {
    for (const [key, child] of Object.entries(def['shape'] as Record<string, ZodType>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      found.add(path);
      schemaKeys(child, path, found);
    }
  } else if (def?.['type'] === 'union') {
    for (const option of def['options'] as ZodType[]) schemaKeys(option, prefix, found);
  }
  return found;
}

/** The same paths, read off a parsed yaml document. */
function documentKeys(value: unknown, prefix = '', found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) documentKeys(entry, prefix, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      found.add(path);
      documentKeys(child, path, found);
    }
  }
  return found;
}

describe('the configuration reference', () => {
  const config = parseConfig(referenceYaml(), { configPath: CONFIG_PATH });

  it('mentions every key the schema accepts', async () => {
    const { parse } = await import('yaml');
    const documented = documentKeys(parse(referenceYaml()));
    const missing = [...schemaKeys(configSchema)]
      .filter((key) => !documented.has(key))
      .filter((key) => !UNDOCUMENTED_ON_PURPOSE.has(key));

    expect(missing).toEqual([]);
  });

  it('spells the sync settings exactly as the resolver defaults them', () => {
    expect(config.sync).toEqual(DEFAULT_SYNC_SETTINGS);
  });

  it('spells the GitHub and Jira sync flags exactly as they default', () => {
    // Written out per repository *and* globally on the page; the resolver
    // merges both, so a wrong value in either place fails here.
    expect(config.projects[0]?.github[0]?.sync).toEqual(DEFAULT_GITHUB_SYNC);
    expect(config.projects[0]?.jira[0]?.sync).toEqual(DEFAULT_JIRA_SYNC);
  });

  it('spells the paths, host and viewer defaults correctly', () => {
    expect(config.databasePath).toBe('/workspace/.devcontext/devcontext.db');
    expect(config.outputs).toEqual({
      yaml: { enabled: true, path: '/workspace/.devcontext/yaml' },
      markdown: { enabled: true, path: '/workspace/.devcontext/markdown' },
      json: { enabled: false, path: '/workspace/.devcontext/json' },
    });
    expect(config.web).toEqual({ port: 4173, host: '127.0.0.1', open: false });
  });

  it('spells the per target defaults correctly', () => {
    const repo = config.projects[0]?.github[0];
    expect(repo?.host.apiUrl).toBe('https://api.github.com');
    expect(repo?.host.webUrl).toBe('https://github.com');
    expect(repo?.host.tokenEnv).toBe('GITHUB_TOKEN');
    expect(repo?.maxWorkflowRuns).toBe(250);
    expect(repo?.maxLogBytes).toBe(2_000_000);

    const jira = config.projects[0]?.jira[0];
    expect(jira?.site.apiVersion).toBe('3');
    expect(jira?.site.auth).toBe('basic');
    expect(jira?.site.tokenEnv).toBe('JIRA_API_TOKEN');
    expect(jira?.boardIds).toEqual([]);
    expect(jira?.fields).toEqual({});
  });
});
