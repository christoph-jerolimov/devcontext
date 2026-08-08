import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.DEVCONTEXT_E2E_PORT ?? 4319);

/**
 * The browser end of the end to end test.
 *
 * `globalSetup` runs a real sync into a throwaway database; `webServer` then
 * starts the real `devcontext serve` on top of it. Nothing here stubs the
 * application — only the API the sync talked to was a fixture.
 *
 * The two projects are the point of the light/dark split: the same pages are
 * captured twice, so a change that only breaks one theme cannot slip past.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  // Screenshots live next to the tests rather than in a hashed directory, so a
  // reviewer can open the folder and see what the viewer looks like.
  snapshotPathTemplate: '{testDir}/screenshots/{projectName}/{arg}{ext}',

  expect: {
    toHaveScreenshot: {
      /*
       * An absolute count, not a ratio, and a small one.
       *
       * A ratio scales with the page while the signal does not: most of a
       * table row is background, so a whole extra row of text moves only the
       * pixels its glyphs cover. At 2% this check accepted a pull request
       * list that had gained a row; at 0.1% — about 900 pixels on a 1280x720
       * page — it still accepted a workflow run list that had gained one,
       * because that row sorted to the bottom and nothing else moved.
       *
       * Rendering is deterministic on a given machine, so the real noise
       * floor is zero; 50 leaves room for a stray edge pixel without leaving
       * room for a line of text. CI does not compare at all (see the workflow),
       * so this only has to hold where the environment is fixed.
       */
      maxDiffPixels: 50,
      animations: 'disabled',
    },
  },

  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: 'retain-on-failure',
    launchOptions: {
      // Hinting is the one font setting that differs noticeably between
      // machines; turning it off makes the screenshots travel better.
      args: ['--font-render-hinting=none'],
      /*
       * For environments that already carry a Chromium which is not the build
       * this Playwright expects — a dev container, usually. Unset everywhere
       * else, including CI, where Playwright installs its own.
       */
      ...(process.env.DEVCONTEXT_E2E_CHROMIUM
        ? { executablePath: process.env.DEVCONTEXT_E2E_CHROMIUM }
        : {}),
    },
  },

  projects: [
    {
      name: 'light',
      use: { ...devices['Desktop Chrome'], colorScheme: 'light' },
    },
    {
      name: 'dark',
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark' },
    },
  ],
});
