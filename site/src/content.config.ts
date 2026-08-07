import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * The documentation is not duplicated here — it is read straight out of
 * `docs/`, which stays the single copy that is also correct on GitHub and on
 * disk. Adding a page there publishes it; there is no list to keep in step.
 */
export const collections = {
  docs: defineCollection({
    loader: glob({ base: '../docs', pattern: '**/*.md' }),
    // The pages carry no frontmatter, so the title comes from the first
    // heading. Anything a page does declare is still honoured.
    schema: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
    }),
  }),
};
