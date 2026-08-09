/**
 * The ceiling the GitHub API imposes on workflow runs.
 *
 * The failure this exists to prevent is the quiet one: a repository with more
 * runs than the API will paginate through syncs to the end of what it serves,
 * reports success, and leaves a database that answers every question about the
 * missing period with a confidently smaller number.
 */

import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../config/load.js';
import {
  MAX_REACHABLE_WORKFLOW_RUNS,
  RUN_PAGE_LIMIT,
  RUN_PAGE_SIZE,
  runCapTooLarge,
  runCeilingReached,
} from './limits.js';

function configWith(cap: string): string {
  return `
github:
  hosts:
    - name: github.com
      token: test
projects:
  - key: demo
    github:
      - repo: acme/platform
        maxWorkflowRuns: ${cap}
`;
}

function resolve(cap: string): ReturnType<typeof parseConfig> {
  return parseConfig(configWith(cap), { configPath: '/w/devcontext.yaml' });
}

function capOf(cap: string): number | null {
  return resolve(cap).projects[0]?.github[0]?.maxWorkflowRuns ?? null;
}

describe('the ceiling itself', () => {
  it('is the page limit times the page size', () => {
    // Stated rather than hardcoded, so the arithmetic is visible when either
    // half changes.
    expect(MAX_REACHABLE_WORKFLOW_RUNS).toBe(RUN_PAGE_LIMIT * RUN_PAGE_SIZE);
    expect(MAX_REACHABLE_WORKFLOW_RUNS).toBe(40_000);
  });

  it('says what it stopped at and that there is more', () => {
    /*
     * A sync that ends at exactly 40,000 with no explanation looks like a
     * repository that happens to have 40,000 runs. The message has to say
     * otherwise or it is not a warning at all.
     */
    const message = runCeilingReached('acme/platform');

    expect(message).toContain('acme/platform');
    expect(message).toContain('40,000');
    expect(message).toMatch(/were not fetched|Older runs exist/);
  });
});

describe('a configured cap', () => {
  it('is refused when it is larger than the API can serve', () => {
    /*
     * Clipping silently would run, finish, and leave somebody believing they
     * asked for 60,000 runs and got them. The number that cannot be honoured
     * is a mistake worth catching before the first request.
     */
    expect(() => resolve('60000')).toThrow(/GitHub stops paginating/);
    expect(() => resolve('60000')).toThrow(/acme\/platform/);
  });

  it('accepts exactly the ceiling', () => {
    // The boundary is reachable, so it is not an error — off by one here would
    // refuse a configuration that works.
    expect(capOf('40000')).toBe(MAX_REACHABLE_WORKFLOW_RUNS);
  });

  it('leaves "all" and null alone', () => {
    /*
     * They ask for as much as there is, which is a different request from
     * naming a number that does not exist. Refusing them would make the
     * ceiling impossible to opt into.
     */
    expect(capOf('"all"')).toBeNull();
    expect(capOf('null')).toBeNull();
  });

  it('still defaults when the key is absent', () => {
    const config = parseConfig(
      `
github:
  hosts:
    - name: github.com
      token: test
projects:
  - key: demo
    github:
      - repo: acme/platform
`,
      { configPath: '/w/devcontext.yaml' },
    );

    expect(config.projects[0]?.github[0]?.maxWorkflowRuns).toBe(250);
  });

  it('names the ceiling in the message rather than only complaining', () => {
    // Somebody reading this has to know what number to write instead.
    expect(runCapTooLarge(60_000)).toContain('40,000');
    expect(runCapTooLarge(60_000)).toContain('60,000');
  });
});
