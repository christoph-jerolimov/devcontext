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
      themes: { light: 'github-light-high-contrast', dark: 'github-dark-high-contrast' },
      /*
       * Emit both themes as custom properties and bake neither in.
       *
       * With a default colour, Shiki writes one theme into an inline `color`
       * and leaves the other in `--shiki-dark` — and if no CSS ever reads that
       * variable, the page silently shows the light palette on both grounds.
       * That is what was happening here: dark mode rendered github-light's
       * navy strings on a near-black background at 1.4:1.
       *
       * With `defaultColor: false` there is no inline colour to forget about,
       * so the stylesheet in docs.css has to choose, and dark cannot fall back
       * to the wrong palette by omission.
       */
      defaultColor: false,
      wrap: false,
    },
  },
});
