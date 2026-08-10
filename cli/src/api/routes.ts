/**
 * The JSON API as a table: every capability's URL pattern and the query
 * parameters it reads, in one place.
 *
 * The server used to be a hand-written chain of ifs, which meant the API
 * existed only as the union of its branches — nothing could enumerate it, and
 * every consumer (the router, the viewer, a future MCP binding or remote
 * client) had to restate its own partial copy. This table is the enumeration.
 * The router derives its matching from `path`, the query decoding from
 * `query`, and the zod schema from both, so they cannot disagree.
 *
 * Patterns are the path after `/api/`: static segments, `:name` for a required
 * parameter, `:name?` for an optional one (last position only), and `*name`
 * for a trailing rest parameter that swallows the remaining segments — needed
 * by `/api/links/:ref`, where a GitHub reference like `acme/platform#42`
 * arrives as two segments.
 *
 * Query parameter kinds mirror what the handlers always did: `string` is the
 * raw value, `number` parses and drops anything non-finite, `list` collects
 * repeated parameters and splits on commas. Values are optional across the
 * board and handlers apply their own defaults, because several defaults are
 * computed per request ("14 days before now") and belong where the clock is.
 */

import { z } from 'zod';

export type ParamKind = 'string' | 'number' | 'list';

export interface RouteDef {
  /** Pattern after `/api/`, e.g. `github/issues/:owner/:name/:number`. */
  path: string;
  query: Record<string, ParamKind>;
}

const activityQuery = {
  since: 'string',
  until: 'string',
  source: 'list',
  container: 'list',
  kind: 'list',
  bots: 'string',
  person: 'list',
  team: 'list',
  limit: 'number',
  offset: 'number',
} as const;

const ticketsQuery = {
  source: 'list',
  container: 'list',
  type: 'list',
  state: 'string',
  assignee: 'string',
  search: 'string',
  person: 'list',
  team: 'list',
  limit: 'number',
  offset: 'number',
} as const;

export const routes = {
  'people.list': { path: 'people', query: {} },
  'people.teams': { path: 'people/teams', query: {} },
  'people.unmapped': { path: 'people/unmapped', query: { limit: 'number' } },

  'activity.list': { path: 'activity', query: activityQuery },
  'activity.people': { path: 'activity/people', query: activityQuery },

  status: { path: 'status', query: {} },

  'insights.summary': {
    path: 'insights',
    query: {
      since: 'string',
      staleAfter: 'string',
      repo: 'list',
      project: 'list',
      limit: 'number',
    },
  },
  'insights.cycleTime': {
    path: 'insights/cycle-time',
    query: { since: 'string', repo: 'list', project: 'list', limit: 'number' },
  },
  'insights.reviewLatency': {
    path: 'insights/review-latency',
    query: { since: 'string', repo: 'list', project: 'list', limit: 'number' },
  },
  'insights.wip': {
    path: 'insights/wip',
    query: { since: 'string', repo: 'list', project: 'list', limit: 'number' },
  },
  'insights.stale': {
    path: 'insights/stale',
    query: {
      since: 'string',
      staleAfter: 'string',
      repo: 'list',
      project: 'list',
      limit: 'number',
    },
  },
  'insights.flaky': {
    path: 'insights/flaky',
    query: { since: 'string', repo: 'list', limit: 'number' },
  },
  'insights.sprint': { path: 'insights/sprint/:sprint?', query: { id: 'number' } },
  'insights.burndown': { path: 'insights/burndown/:id?', query: { sprint: 'number' } },
  'insights.flow': {
    path: 'insights/flow',
    query: { since: 'string', until: 'string', project: 'list' },
  },
  'insights.statusTime': {
    path: 'insights/status-time',
    query: { since: 'string', until: 'string', project: 'list', limit: 'number' },
  },
  'insights.velocity': { path: 'insights/velocity', query: { limit: 'number', board: 'number' } },

  'history.open': {
    path: 'history',
    query: {
      from: 'string',
      to: 'string',
      source: 'string',
      container: 'string',
      kind: 'string',
      assignee: 'string',
      sprint: 'string',
    },
  },
  'history.closed': {
    path: 'history/closed',
    query: {
      from: 'string',
      to: 'string',
      container: 'list',
      person: 'list',
      team: 'list',
      bots: 'string',
    },
  },
  'history.runs': {
    path: 'history/runs',
    query: { from: 'string', to: 'string', container: 'list' },
  },

  'tickets.list': { path: 'tickets', query: ticketsQuery },
  'tickets.types': { path: 'tickets/types', query: ticketsQuery },
  'tickets.containers': { path: 'tickets/containers', query: ticketsQuery },

  search: {
    path: 'search',
    query: {
      q: 'string',
      search: 'string',
      kind: 'list',
      repo: 'list',
      project: 'list',
      exact: 'string',
      limit: 'number',
      offset: 'number',
    },
  },

  digest: {
    path: 'digest',
    query: {
      since: 'string',
      until: 'string',
      staleAfter: 'string',
      repo: 'list',
      project: 'list',
      person: 'list',
      limit: 'number',
    },
  },

  links: { path: 'links/*ref', query: { ref: 'string', limit: 'number', offset: 'number' } },

  'github.repos': {
    path: 'github/repos',
    query: { search: 'string', limit: 'number', offset: 'number' },
  },
  'github.issues.list': {
    path: 'github/issues',
    query: {
      repo: 'list',
      state: 'string',
      label: 'list',
      author: 'string',
      assignee: 'string',
      person: 'list',
      team: 'list',
      bots: 'string',
      search: 'string',
      updatedBefore: 'string',
      updatedSince: 'string',
      limit: 'number',
      offset: 'number',
    },
  },
  'github.issues.get': { path: 'github/issues/:owner/:name/:number', query: {} },
  'github.pulls.list': {
    path: 'github/pulls',
    query: {
      repo: 'list',
      state: 'string',
      label: 'list',
      author: 'string',
      person: 'list',
      team: 'list',
      bots: 'string',
      search: 'string',
      limit: 'number',
      offset: 'number',
    },
  },
  'github.pulls.get': { path: 'github/pulls/:owner/:name/:number', query: {} },
  'github.workflows': {
    path: 'github/workflows',
    query: { repo: 'list', search: 'string', limit: 'number', offset: 'number' },
  },
  'github.runs.list': {
    path: 'github/runs',
    query: {
      repo: 'list',
      workflow: 'string',
      status: 'string',
      conclusion: 'string',
      branch: 'string',
      search: 'string',
      limit: 'number',
      offset: 'number',
    },
  },
  'github.runs.get': { path: 'github/runs/:id', query: {} },
  'github.jobs': {
    path: 'github/jobs',
    query: {
      repo: 'list',
      run: 'number',
      conclusion: 'string',
      search: 'string',
      limit: 'number',
      offset: 'number',
    },
  },
  'github.steps': {
    path: 'github/steps',
    query: { job: 'number', run: 'number', search: 'string', limit: 'number', offset: 'number' },
  },
  'github.logs': { path: 'github/logs/:id', query: {} },

  'jira.projects': { path: 'jira/projects', query: {} },
  'jira.fields': { path: 'jira/fields', query: { search: 'string' } },
  'jira.workitems.list': {
    path: 'jira/workitems',
    query: {
      project: 'list',
      type: 'list',
      status: 'list',
      category: 'list',
      label: 'list',
      assignee: 'string',
      sprint: 'string',
      epic: 'string',
      updatedBefore: 'string',
      updatedSince: 'string',
      search: 'string',
      q: 'string',
      limit: 'number',
      offset: 'number',
    },
  },
  'jira.workitems.get': { path: 'jira/workitems/:key', query: {} },
  'jira.tree': {
    path: 'jira/tree/:key',
    query: { depth: 'number', ancestors: 'string', links: 'string' },
  },
  'jira.sprints.list': {
    path: 'jira/sprints',
    query: { state: 'list', search: 'string', limit: 'number', offset: 'number' },
  },
  'jira.sprints.get': { path: 'jira/sprints/:id', query: {} },
} as const satisfies Record<string, RouteDef>;

export type CapabilityName = keyof typeof routes;

/* ------------------------------------------------------------------------- *
 * The input each capability receives, derived from its table entry.
 * ------------------------------------------------------------------------- */

type KindValue<K extends ParamKind> = K extends 'list'
  ? string[]
  : K extends 'number'
    ? number
    : string;

type QueryInput<Q extends Record<string, ParamKind>> = { [K in keyof Q]?: KindValue<Q[K]> };

type Segment<P extends string> = P extends `${infer Head}/${infer Tail}` ? Head | Segment<Tail> : P;
type RequiredParam<S extends string> = S extends `:${string}?`
  ? never
  : S extends `:${infer Name}`
    ? Name
    : never;
type OptionalParam<S extends string> = S extends `:${infer Name}?`
  ? Name
  : S extends `*${infer Name}`
    ? Name
    : never;

/** Query parameters by kind, plus the path parameters the pattern names. */
export type InputOf<R extends RouteDef> = QueryInput<R['query']> & {
  [K in RequiredParam<Segment<R['path']>>]: string;
} & { [K in OptionalParam<Segment<R['path']>>]?: string };

/* ------------------------------------------------------------------------- *
 * Pattern compilation, matching and decoding.
 * ------------------------------------------------------------------------- */

export type CompiledSegment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string; optional: boolean }
  | { kind: 'rest'; name: string };

export function compilePath(path: string): CompiledSegment[] {
  const segments = path.split('/');
  return segments.map((segment, index): CompiledSegment => {
    const last = index === segments.length - 1;
    if (segment.startsWith('*')) {
      if (!last) throw new Error(`Rest parameter must be last in route pattern "${path}".`);
      return { kind: 'rest', name: segment.slice(1) };
    }
    if (segment.startsWith(':')) {
      const optional = segment.endsWith('?');
      if (optional && !last) {
        throw new Error(`Optional parameter must be last in route pattern "${path}".`);
      }
      return { kind: 'param', name: optional ? segment.slice(1, -1) : segment.slice(1), optional };
    }
    return { kind: 'static', value: segment };
  });
}

const compiled = Object.entries(routes).map(([name, route]) => ({
  name: name as CapabilityName,
  segments: compilePath(route.path),
}));

export interface RouteMatch {
  name: CapabilityName;
  /** Path parameter values; rest parameters join their segments with `/`. */
  params: Record<string, string>;
}

/**
 * The capability a decoded path addresses, or undefined for a 404.
 *
 * All patterns are tried and the most specific match wins — static segments
 * count for more than parameters — so `people/teams` can never be swallowed
 * by a parameter and the result does not depend on table order.
 */
export function matchRoute(segments: string[]): RouteMatch | undefined {
  let best: { match: RouteMatch; score: number } | undefined;

  for (const route of compiled) {
    const result = matchOne(route.segments, segments);
    if (result && (best === undefined || result.score > best.score)) {
      best = { match: { name: route.name, params: result.params }, score: result.score };
    }
  }
  return best?.match;
}

function matchOne(
  pattern: CompiledSegment[],
  segments: string[],
): { params: Record<string, string>; score: number } | undefined {
  const params: Record<string, string> = {};
  let score = 0;
  let index = 0;

  for (const part of pattern) {
    if (part.kind === 'rest') {
      const remainder = segments.slice(index);
      if (remainder.length > 0) params[part.name] = remainder.join('/');
      index = segments.length;
      continue;
    }
    const value = segments[index];
    if (value === undefined) {
      if (part.kind === 'param' && part.optional) continue;
      return undefined;
    }
    if (part.kind === 'static') {
      if (value !== part.value) return undefined;
      score += 2;
    } else {
      params[part.name] = value;
      score += 1;
    }
    index += 1;
  }

  return index === segments.length ? { params, score } : undefined;
}

/**
 * Reads the declared query parameters off the request, by kind.
 *
 * The semantics are the ones the handlers always had: a `number` that does not
 * parse is treated as absent rather than an error, a `list` collects repeated
 * parameters and splits each on commas, and a `string` keeps an empty value —
 * `?since=` means an empty string to the handler, not the default.
 */
export function decodeQuery(route: RouteDef, query: URLSearchParams): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(route.query)) {
    if (kind === 'list') {
      const values = query
        .getAll(key)
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter(Boolean);
      if (values.length > 0) input[key] = values;
    } else if (kind === 'number') {
      const raw = query.get(key);
      if (raw === null || raw === '') continue;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) input[key] = parsed;
    } else {
      const value = query.get(key);
      if (value !== null) input[key] = value;
    }
  }
  return input;
}

/* ------------------------------------------------------------------------- *
 * The zod schema each capability's input satisfies.
 * ------------------------------------------------------------------------- */

const KIND_SCHEMAS: Record<ParamKind, z.ZodType> = {
  string: z.string(),
  number: z.number(),
  list: z.array(z.string()),
};

const schemaCache = new Map<CapabilityName, z.ZodType>();

/**
 * Built from the same table entry the decoder reads, so the two cannot drift.
 * The router runs every decoded input through it — a mismatch is a programming
 * error surfacing as a 500, not a silently wrong shape — and a future remote
 * transport or MCP binding validates through the identical schema.
 */
export function inputSchema(name: CapabilityName): z.ZodType {
  const cached = schemaCache.get(name);
  if (cached) return cached;

  const route: RouteDef = routes[name];
  const shape: Record<string, z.ZodType> = {};
  for (const [key, kind] of Object.entries(route.query)) {
    shape[key] = KIND_SCHEMAS[kind].optional();
  }
  for (const segment of compilePath(route.path)) {
    if (segment.kind === 'param') {
      shape[segment.name] = segment.optional ? z.string().optional() : z.string();
    }
    if (segment.kind === 'rest') shape[segment.name] = z.string().optional();
  }

  const schema = z.object(shape);
  schemaCache.set(name, schema);
  return schema;
}
