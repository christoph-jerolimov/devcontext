import { defineHastPlugin } from 'satteri';

/**
 * Wraps every table in its own horizontal scroll container.
 *
 * The reference pages are mostly wide tables, and without this they push the
 * whole page sideways on a phone — the body scrolls, the heading drifts off
 * screen, and the layout looks broken. A table should scroll inside itself.
 */
export function tableScroll() {
  return defineHastPlugin({
    name: 'devcontext-table-scroll',
    element: {
      filter: ['table'],
      visit(node, ctx) {
        const parent = ctx.parent(node);
        // Idempotent: a second pass must not nest another wrapper.
        if (
          parent &&
          'tagName' in parent &&
          parent.tagName === 'div' &&
          String(parent.properties?.['className'] ?? '').includes('table-wrap')
        ) {
          return;
        }

        ctx.wrapNode(node, {
          type: 'element',
          tagName: 'div',
          properties: { className: ['table-wrap'] },
          children: [],
        });
      },
    },
  });
}
