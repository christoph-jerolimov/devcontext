/**
 * The reading order of the documentation.
 *
 * `docs/` is a flat folder, so the order has to come from somewhere — but a
 * hard list would silently drop a new page. Anything not named here is
 * appended under "More", so adding a file to `docs/` still publishes it.
 */

export interface NavGroup {
  title: string;
  ids: string[];
}

export const NAV: NavGroup[] = [
  {
    title: 'Start',
    ids: ['readme', 'getting-started', 'configuration', 'configuration-reference'],
  },
  { title: 'Using it', ids: ['sync', 'cli', 'commands', 'search', 'outputs'] },
  { title: 'Reading the data', ids: ['insights', 'digest', 'links', 'database'] },
  { title: 'Surfaces', ids: ['web', 'mcp', 'agent'] },
  { title: 'Operating it', ids: ['audit', 'troubleshooting', 'development'] },
];

const LABELS: Record<string, string> = {
  readme: 'Overview',
  'getting-started': 'Getting started',
  configuration: 'Configuration',
  'configuration-reference': 'Every setting',
  sync: 'Sync',
  cli: 'CLI guide',
  commands: 'Command reference',
  search: 'Search',
  outputs: 'Outputs',
  insights: 'Insights',
  digest: 'Digest',
  links: 'Cross links',
  database: 'Database',
  web: 'Web viewer',
  mcp: 'MCP server',
  agent: 'Agent (experimental)',
  audit: 'Audit',
  troubleshooting: 'Troubleshooting',
  development: 'Development',
};

export function labelFor(id: string, fallback?: string): string {
  return LABELS[id] ?? fallback ?? id.replaceAll('-', ' ');
}

/** `README.md` is the documentation index and lives at `/docs`. */
export function routeFor(id: string): string {
  return id === 'readme' ? 'docs' : `docs/${id}`;
}

/** Groups the pages for the sidebar, with anything unlisted appended. */
export function buildNav(ids: string[]): NavGroup[] {
  const known = new Set(NAV.flatMap((group) => group.ids));
  const groups = NAV.map((group) => ({
    title: group.title,
    ids: group.ids.filter((id) => ids.includes(id)),
  })).filter((group) => group.ids.length > 0);

  const extra = ids.filter((id) => !known.has(id)).toSorted();
  return extra.length > 0 ? [...groups, { title: 'More', ids: extra }] : groups;
}

/** Previous and next page in reading order, for the footer links. */
export function neighbours(
  groups: NavGroup[],
  id: string,
): { previous: string | null; next: string | null } {
  const flat = groups.flatMap((group) => group.ids);
  const index = flat.indexOf(id);
  if (index === -1) return { previous: null, next: null };
  return {
    previous: index > 0 ? (flat[index - 1] ?? null) : null,
    next: index < flat.length - 1 ? (flat[index + 1] ?? null) : null,
  };
}
