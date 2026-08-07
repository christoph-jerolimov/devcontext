// @ts-check
import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';

import { docsLinks } from './src/plugins/docs-links.ts';
import { tableScroll } from './src/plugins/table-scroll.ts';

// GitHub Pages serves the repository under a sub path; override with SITE_BASE
// to publish at a root (a custom domain, or a local preview).
const base = process.env.SITE_BASE ?? '/devcontext';

// A static site: there is nothing dynamic to serve, and the output drops
// straight onto GitHub Pages or any bucket.
export default defineConfig({
  site: 'https://christoph-jerolimov.github.io',
  base,
  trailingSlash: 'never',
  build: { format: 'directory' },
  markdown: {
    // Sätteri is Astro's default processor; extending it with a hast plugin
    // keeps `unified` out of the dependency tree entirely.
    processor: satteri({ hastPlugins: [docsLinks(base), tableScroll()] }),
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      wrap: false,
    },
  },
});
