import { defineHastPlugin } from 'satteri';

/**
 * Rewrites the links between the documentation pages.
 *
 * The files in `docs/` are written to be read on disk and on GitHub, so they
 * link to each other as `sync.md` and out to the repository as `../README.md`.
 * Rendered as a site those have to become routes, and anything pointing back
 * into the repository has to become a GitHub URL — otherwise every page is
 * full of links that 404.
 *
 * This is a Sätteri hast plugin rather than a rehype one: rehype plugins would
 * pull the whole `unified` pipeline back in as a dependency, and the only thing
 * needed here is "visit the anchors".
 */

const REPO = 'https://github.com/christoph-jerolimov/devcontext';

export function docsLinks(base: string) {
  const prefix = base.replace(/\/$/, '');

  return defineHastPlugin({
    name: 'devcontext-docs-links',
    element: {
      filter: ['a'],
      visit(node, ctx) {
        const href = node.properties?.['href'];
        if (typeof href !== 'string') return;

        const rewritten = rewriteHref(href, prefix);
        if (rewritten !== href) ctx.setProperty(node, 'href', rewritten);
      },
    },
  });
}

/** Exported so the rewriting rules can be tested without building the site. */
export function rewriteHref(href: string, base = ''): string {
  if (/^(https?:|mailto:|#|\/)/.test(href)) return href;

  const hash = href.indexOf('#');
  const path = hash === -1 ? href : href.slice(0, hash);
  const fragment = hash === -1 ? '' : href.slice(hash);

  // `README.md` is the index of the documentation.
  if (path === 'README.md' || path === './README.md') return `${base}/docs${fragment}`;

  // Anything climbing out of docs/ belongs to the repository, not the site.
  if (path.startsWith('../')) {
    const target = path.replace(/^(\.\.\/)+/, '');
    const kind = target.includes('.') ? 'blob' : 'tree';
    return `${REPO}/${kind}/main/${target}${fragment}`;
  }

  // A sibling page: `sync.md` -> `/docs/sync`.
  if (path.endsWith('.md')) {
    return `${base}/docs/${path.replace(/^\.\//, '').replace(/\.md$/, '')}${fragment}`;
  }

  // A relative path into the repository that is not a document, e.g. `cli`.
  if (path !== '') return `${REPO}/tree/main/${path}${fragment}`;

  return href;
}
