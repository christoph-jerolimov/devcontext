/**
 * Runs a real sync before the browser tests start.
 *
 * The CLI is invoked as a child process, exactly as somebody would run it, so
 * what the screenshots show is what the built binary produces: real HTTP, real
 * rate limiting, a real SQLite database on disk. Only the API at the far end is
 * a fixture, because screenshots of live data could never be compared.
 *
 * The fixture API is stopped again afterwards — `devcontext serve` reads the
 * database and never calls out.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFixtureApi } from './fixtures/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = resolve(here, '.tmp');
export const CONFIG_PATH = join(WORKSPACE, 'devcontext.yaml');
const CLI = resolve(here, '../cli/dist/main.js');
const PORT = Number(process.env['DEVCONTEXT_E2E_PORT'] ?? 4319);

function configFor(apiUrl: string): string {
  return `version: 1

database:
  path: ${join(WORKSPACE, 'devcontext.db')}

sync:
  minDelayMs: 0
  progress: false

outputs:
  yaml:
    enabled: false
  markdown:
    enabled: false

github:
  hosts:
    - name: github.com
      apiUrl: ${apiUrl}
      webUrl: https://github.com
      token: fixture-token

jira:
  sites:
    - name: acme
      baseUrl: ${apiUrl}
      email: dev@example.com
      token: fixture-token
      fields:
        customfield_10016: storyPoints
        # Without this the work items have no sprint_id, so nothing is ever a
        # member of a sprint and the burndown draws an empty one. Mapping it is
        # what the sprint reports need; see docs/sprints.md.
        customfield_10020: sprint

projects:
  - key: platform
    name: Platform
    github:
      - repo: acme/platform
        maxWorkflowRuns: 50
    jira:
      - project: PLAT
`;
}

/**
 * Runs the CLI and waits for it, without blocking this process.
 *
 * It has to be the async form. `execFileSync` blocks the event loop, and the
 * fixture API is served from *this* process — so a synchronous child would sit
 * there making requests that nothing was ever going to answer.
 */
function run(script: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: 'inherit',
      env: { ...process.env, NO_COLOR: '1' },
    });
    child.on('error', fail);
    child.on('close', (code) => {
      if (code === 0) done();
      else fail(new Error(`${script} ${args.join(' ')} exited with ${String(code)}`));
    });
  });
}

/** Waits for `devcontext serve` to answer, so the first test does not race it. */
async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`${url} did not come up within 30s.`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

/**
 * Returns the teardown, which Playwright runs after the last test.
 *
 * The server is started here rather than through `webServer` because that is
 * launched before `globalSetup`, and there is nothing for it to serve until
 * the sync below has run.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(CLI)) {
    throw new Error(
      `The CLI has not been built: ${CLI} is missing. Run "npm run build" in the repository root.`,
    );
  }

  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });

  // --- a real sync, against a fixed API ---------------------------------
  const api = await startFixtureApi();
  try {
    writeFileSync(CONFIG_PATH, configFor(api.url));
    await run(CLI, ['sync', '--config', CONFIG_PATH, '--no-progress']);
  } finally {
    // Nothing else calls out: `serve` only reads the database.
    await api.close();
  }

  // --- the real server, on what the sync wrote --------------------------
  const server = spawn(
    process.execPath,
    [CLI, 'serve', '--config', CONFIG_PATH, '--port', String(PORT)],
    { stdio: 'inherit', env: { ...process.env, NO_COLOR: '1' } },
  );
  server.on('error', (error) => {
    throw error;
  });

  await waitForServer(`http://127.0.0.1:${String(PORT)}/api/status`);

  return async () => {
    server.kill();
  };
}
