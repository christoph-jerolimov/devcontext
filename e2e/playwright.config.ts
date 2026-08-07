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
      // Font rasterisation differs a little between machines; this is small
      // enough to catch a moved element and large enough to survive that.
      maxDiffPixelRatio: 0.02,
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
