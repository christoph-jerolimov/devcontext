import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ResolvedConfig } from '../config/types.js';
import { Database } from '../db/database.js';
import { SyncJournal } from '../db/journal.js';
import * as gh from '../db/queries/github.js';
import * as jira from '../db/queries/jira.js';
import * as crossLinks from '../db/queries/links.js';
import * as historyQueries from '../db/queries/history.js';
import * as ticketQueries from '../db/queries/tickets.js';
import * as peopleQueries from '../db/queries/people.js';
import * as activityQueries from '../db/queries/activity.js';
import { buildWorkitemTree, summariseTree } from '../db/queries/tree.js';
import { buildDigest } from '../insights/digest.js';
import { Directory } from '../people/directory.js';
import { searchAll } from '../search/index.js';
import * as insights from '../insights/index.js';
import {
  buildIssueDocument,
  buildPullRequestDocument,
  buildWorkflowRunDocument,
} from '../documents/github.js';
import { buildSprintDocument, buildWorkitemDocument } from '../documents/jira.js';
import { CliError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface WebServerOptions {
  config: ResolvedConfig;
  logger: Logger;
  port: number;
  host: string;
  databasePath: string;
}

/** Finds the built React app that `devcontext web` serves. */
export function findWebAssets(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../web/dist'), // monorepo: cli/{src,dist}/web -> web/dist
    resolve(here, '../../web/dist'),
    resolve(here, '../web'),
    resolve(here, '../../node_modules/@devcontext/web/dist'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? null;
}

export function startWebServer(options: WebServerOptions): Promise<Server> {
  const { config, logger } = options;
  const assets = findWebAssets();

  if (!assets) {
    logger.warn(
      'The web viewer has not been built yet; only the JSON API under /api is available. ' +
        'Run "npm run build:web" in the repository root.',
    );
  }

  const db = Database.open(options.databasePath, { create: false, readOnly: true });
  const journal = new SyncJournal(db);

  const server = createServer((request, response) => {
    handleRequest(request, response, { db, journal, config, assets, logger }).catch((error) => {
      logger.error(`Request failed: ${(error as Error).message}`);
      sendJson(response, 500, { error: (error as Error).message });
    });
  });

  server.on('close', () => db.close());

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolvePromise(server));
  });
}

interface RequestContext {
  db: Database;
  journal: SyncJournal;
  config: ResolvedConfig;
  assets: string | null;
  logger: Logger;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  ctx.logger.debug(`${request.method} ${url.pathname}${url.search}`);

  if (url.pathname.startsWith('/api/')) {
    const payload = handleApi(url, ctx);
    if (payload === undefined) {
      sendJson(response, 404, { error: `Unknown endpoint ${url.pathname}` });
      return;
    }
    sendJson(response, 200, payload);
    return;
  }

  if (!ctx.assets) {
    sendJson(response, 404, {
      error: 'The web viewer is not built. Run "npm run build:web" in the repository root.',
    });
    return;
  }

  serveStatic(url.pathname, response, ctx.assets);
}

function handleApi(url: URL, ctx: RequestContext): unknown {
  const { db } = ctx;
  // Split first, then decode: a segment may legitimately contain an encoded
  // slash, and decoding earlier would split it into two. This matters for
  // /api/links/:ref, where a GitHub reference arrives as acme/platform%2342 —
  // left encoded, the `#` never reappears and the whole thing gets uppercased
  // as if it were a Jira key.
  const segments = url.pathname
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeSegment);
  const query = url.searchParams;

  const limit = numberParam(query, 'limit') ?? 100;
  const offset = numberParam(query, 'offset');
  const repos = listParam(query, 'repo');
  const search = query.get('search') ?? undefined;

  const [area, resource, ...rest] = segments;

  /*
   * `?person=` and `?team=` on any list that has an author.
   *
   * Resolved from the configuration on every request rather than cached with
   * the server, so editing devcontext.yaml and reloading the page is enough —
   * the viewer never shows a mapping the file no longer contains.
   */
  const directory = Directory.from(ctx.config);
  const selection = directory.select({
    people: listParam(query, 'person'),
    teams: listParam(query, 'team'),
  });

  if (area === 'people') {
    if (resource === 'teams') {
      return directory.teams.map((team) => ({
        ...team,
        people: directory.membersOf(team).map((person) => person.id),
      }));
    }
    if (resource === 'unmapped') {
      const mapped = new Set<string>();
      for (const person of directory.people) {
        for (const login of person.github) mapped.add(`github:${login.trim().toLowerCase()}`);
        for (const name of person.jira) mapped.add(`jira:${name.trim().toLowerCase()}`);
      }
      return peopleQueries.unmappedIdentities(db, mapped, { limit });
    }
    if (resource !== undefined) return undefined;
    return { people: directory.people, teams: directory.teams };
  }

  if (area === 'activity') {
    /*
     * What people did, as opposed to what the state of things is. The two
     * cannot be derived from each other: an issue opened, argued over and
     * closed looks, in the issue list, exactly like one nobody touched.
     */
    const filter: activityQueries.ActivityFilter = {
      since: query.get('since') ?? new Date(Date.now() - 14 * 86_400_000).toISOString(),
      until: query.get('until') ?? undefined,
      sources: listParam(query, 'source'),
      containers: listParam(query, 'container'),
      kinds: listParam(query, 'kind'),
      excludeBots: query.get('bots') === 'false',
      onlyBots: query.get('bots') === 'only',
      bots: directory.botIdentities(),
      limit,
      offset,
      ...(selection ? { people: { github: selection.github, jira: selection.jira } } : {}),
    };

    if (resource === 'people') return activityQueries.activityByActor(db, filter);
    if (resource !== undefined) return undefined;

    return {
      // The person is resolved here rather than in the viewer, which has the
      // names but not the identities behind them.
      events: activityQueries.listActivity(db, filter).map((event) => {
        const person = directory.identify(event.source, event.actor);
        return Object.assign(event, {
          person: person ? { id: person.id, name: person.name, kind: person.kind } : null,
        });
      }),
      total: activityQueries.countActivity(db, filter),
      kinds: [...activityQueries.ACTIVITY_KINDS],
    };
  }

  if (area === 'status') {
    return {
      config: {
        path: ctx.config.configPath,
        database: ctx.config.databasePath,
        projects: ctx.config.projects.map((project) => ({
          key: project.key,
          name: project.name,
          description: project.description,
          github: project.github.map((repo) => repo.fullName),
          jira: project.jira.map((entry) => `${entry.site.name}/${entry.projectKey}`),
        })),
      },
      github: gh.githubStats(db),
      jira: jira.jiraStats(db),
      // The same totals broken down, so the Overview can say which repository
      // or project the rows came from rather than only how many there are.
      githubByRepository: gh.githubStatsByRepository(db),
      jiraByProject: jira.jiraStatsByProject(db),
      links: crossLinks.linkStats(db),
      // Served rather than duplicated in the viewer, so the dropdown and the
      // grouping that backs it cannot drift apart.
      filters: {
        workitemTypes: [...jira.WORKITEM_TYPES],
        // Sent with the status the viewer already fetches, so a person or team
        // dropdown costs no extra request. Only what a dropdown needs — the
        // identities behind each entry are the server's business.
        people: directory.people.map((person) => ({
          id: person.id,
          name: person.name,
          kind: person.kind,
        })),
        teams: directory.teams.map((team) => ({ id: team.id, name: team.name })),
      },
      runs: ctx.journal.listRuns({ limit: 20 }),
      state: ctx.journal.listState(),
    };
  }

  if (area === 'insights') {
    const since = query.get('since') ?? new Date(Date.now() - 90 * 86_400_000).toISOString();
    const staleThreshold =
      query.get('staleAfter') ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
    const filter = {
      since,
      repos: listParam(query, 'repo'),
      projects: listParam(query, 'project'),
      limit,
    };

    switch (resource) {
      case 'cycle-time':
        return insights.cycleTime(db, filter);
      case 'review-latency':
        return insights.reviewLatency(db, filter);
      case 'wip':
        return insights.wip(db, filter);
      case 'stale':
        return insights.staleItems(db, staleThreshold, filter);
      case 'flaky':
        return insights.flakySteps(db, { since, repos: filter.repos, limit });
      case 'sprint': {
        const id = rest[0] ? Number(rest[0]) : numberParam(query, 'id');
        return id === undefined || Number.isNaN(id) ? undefined : insights.sprintReport(db, id);
      }
      /*
       * The two reports that read `state_changes` rather than the current
       * tables — the shape a sprint took, not the shape it is in. See
       * docs/sprints.md.
       */
      case 'burndown': {
        const id = rest[0] ? Number(rest[0]) : numberParam(query, 'sprint');
        return id === undefined || Number.isNaN(id) ? undefined : insights.sprintBurndown(db, id);
      }
      case 'velocity': {
        const board = numberParam(query, 'board');
        return insights.sprintVelocity(db, {
          limit,
          ...(board === undefined || Number.isNaN(board) ? {} : { board }),
        });
      }
      case undefined:
        return {
          cycleTime: insights.cycleTime(db, filter),
          reviewLatency: insights.reviewLatency(db, filter),
          wip: insights.wip(db, filter),
          stale: insights.staleItems(db, staleThreshold, filter),
          flaky: insights.flakySteps(db, { since, repos: filter.repos, limit }),
        };
      default:
        return undefined;
    }
  }

  if (area === 'history') {
    /*
     * How many items were open per day, which no other endpoint can answer:
     * the current tables know where an item ended up, not the shape it took
     * getting there. See docs/history.md.
     */
    const to = query.get('to') ?? new Date().toISOString();
    const from = query.get('from') ?? new Date(Date.now() - 29 * 86_400_000).toISOString();

    return {
      from,
      to,
      days: historyQueries.openByDay(db, {
        from,
        to,
        source: query.get('source') ?? undefined,
        container: query.get('container') ?? undefined,
        kind: query.get('kind') ?? undefined,
        assignee: query.get('assignee') ?? undefined,
        sprint: query.get('sprint') ?? undefined,
      }),
      byAssignee: historyQueries.openByAssignee(db, {
        at: to,
        source: query.get('source') ?? undefined,
        container: query.get('container') ?? undefined,
        kind: query.get('kind') ?? undefined,
      }),
    };
  }

  if (area === 'tickets') {
    /*
     * GitHub issues and Jira work items as one list, plus the two things a
     * filter bar needs to describe itself: which types exist and which
     * repositories and projects exist. Both are read off the data, so a
     * project that invents a type gets a filter entry without a redeploy.
     */
    const filter: ticketQueries.TicketFilter = {
      sources: listParam(query, 'source'),
      containers: listParam(query, 'container'),
      types: listParam(query, 'type'),
      state: (query.get('state') as 'open' | 'closed' | 'all') ?? 'all',
      assignee: query.get('assignee') ?? undefined,
      search,
      limit,
      offset,
      ...(selection ? { people: { github: selection.github, jira: selection.jira } } : {}),
    };

    if (resource === 'types') return ticketQueries.ticketTypes(db, filter);
    if (resource === 'containers') return ticketQueries.ticketContainers(db, filter);
    if (resource !== undefined) return undefined;

    return {
      tickets: ticketQueries.listTickets(db, filter),
      // So the viewer can say "showing 100 of 4,312" rather than implying the
      // page it got is everything there is.
      total: ticketQueries.countTickets(db, filter),
    };
  }

  if (area === 'search') {
    const text = query.get('q') ?? search ?? '';
    if (text.trim() === '') return [];
    return searchAll(db, text, {
      kinds: listParam(query, 'kind') as Array<'issue' | 'pull-request' | 'workitem'> | undefined,
      containers: [...(repos ?? []), ...(listParam(query, 'project') ?? [])],
      limit,
      offset,
      prefix: query.get('exact') !== 'true',
    });
  }

  if (area === 'digest') {
    return buildDigest(db, {
      since: query.get('since') ?? new Date(Date.now() - 7 * 86_400_000).toISOString(),
      until: query.get('until') ?? undefined,
      repos: listParam(query, 'repo'),
      projects: listParam(query, 'project'),
      people: listParam(query, 'person'),
      staleAfter: query.get('staleAfter') ?? new Date(Date.now() - 30 * 86_400_000).toISOString(),
      limit,
    });
  }

  if (area === 'links') {
    const ref = resource ? [resource, ...rest].join('/') : (query.get('ref') ?? undefined);
    if (ref) return { ref: crossLinks.normaliseRef(ref), links: crossLinks.linksFor(db, ref) };
    return crossLinks.listLinks(db, { limit, offset });
  }

  if (area === 'github') {
    switch (resource) {
      case 'repos':
        return gh.listRepositories(db, { search, limit, offset });
      case 'issues': {
        if (rest.length >= 3) {
          const [owner, name, number] = rest as [string, string, string];
          const issue = gh.getIssue(db, `${owner}/${name}`, Number(number));
          return issue ? buildIssueDocument(db, issue).data : undefined;
        }
        return gh.listIssues(db, {
          repos,
          // Every state by default, as pull requests do: see the `issues`
          // command for why.
          state: (query.get('state') as 'open' | 'closed' | 'all') ?? 'all',
          labels: listParam(query, 'label'),
          author: query.get('author') ?? undefined,
          assignee: query.get('assignee') ?? undefined,
          people: selection?.github,
          excludeBots: query.get('bots') === 'false',
          onlyBots: query.get('bots') === 'only',
          bots: directory.botIdentities('github'),
          search,
          updatedBefore: query.get('updatedBefore') ?? undefined,
          updatedSince: query.get('updatedSince') ?? undefined,
          limit,
          offset,
        });
      }
      case 'pulls': {
        if (rest.length >= 3) {
          const [owner, name, number] = rest as [string, string, string];
          const pr = gh.getPullRequest(db, `${owner}/${name}`, Number(number));
          return pr ? buildPullRequestDocument(db, pr).data : undefined;
        }
        return gh.listPullRequests(db, {
          repos,
          // All states by default: see the `prs` command.
          state: (query.get('state') as 'open' | 'closed' | 'all') ?? 'all',
          labels: listParam(query, 'label'),
          author: query.get('author') ?? undefined,
          people: selection?.github,
          excludeBots: query.get('bots') === 'false',
          onlyBots: query.get('bots') === 'only',
          bots: directory.botIdentities('github'),
          search,
          limit,
          offset,
        });
      }
      case 'workflows':
        return gh.listWorkflows(db, { repos, search, limit, offset });
      case 'runs': {
        if (rest.length >= 1) {
          const run = db.get<gh.WorkflowRunRow>('SELECT * FROM gh_workflow_runs WHERE id = ?', [
            Number(rest[0]),
          ]);
          return run ? buildWorkflowRunDocument(db, run).data : undefined;
        }
        return gh.listWorkflowRuns(db, {
          repos,
          workflow: query.get('workflow') ?? undefined,
          status: query.get('status') ?? undefined,
          conclusion: query.get('conclusion') ?? undefined,
          branch: query.get('branch') ?? undefined,
          search,
          limit,
          offset,
        });
      }
      case 'jobs':
        return gh.listWorkflowJobs(db, {
          repos,
          runId: numberParam(query, 'run'),
          conclusion: query.get('conclusion') ?? undefined,
          search,
          limit,
          offset,
        });
      case 'steps':
        return gh.listWorkflowSteps(db, {
          jobId: numberParam(query, 'job'),
          runId: numberParam(query, 'run'),
          search,
          limit,
          offset,
        });
      case 'logs':
        return rest[0] ? gh.getJobLog(db, Number(rest[0])) : undefined;
      default:
        return undefined;
    }
  }

  if (area === 'jira') {
    switch (resource) {
      case 'projects':
        return jira.listJiraProjects(db);
      case 'fields':
        return jira.listJiraFields(db, { search });
      case 'workitems': {
        if (rest.length >= 1) {
          const workitem = jira.getWorkitem(db, rest[0] as string);
          return workitem ? buildWorkitemDocument(db, workitem).data : undefined;
        }
        const filter = {
          projects: listParam(query, 'project'),
          types: listParam(query, 'type'),
          statuses: listParam(query, 'status'),
          statusCategories: listParam(query, 'category'),
          labels: listParam(query, 'label'),
          assignee: query.get('assignee') ?? undefined,
          sprint: query.get('sprint') ?? undefined,
          epic: query.get('epic') ?? undefined,
          updatedBefore: query.get('updatedBefore') ?? undefined,
          updatedSince: query.get('updatedSince') ?? undefined,
          search,
          limit,
          offset,
        };
        const text = query.get('q');
        return text ? jira.searchWorkitems(db, text, filter) : jira.listWorkitems(db, filter);
      }
      case 'tree': {
        const key = rest[0];
        if (!key) return undefined;

        const depth = numberParam(query, 'depth');
        const tree = buildWorkitemTree(db, key, {
          maxDepth: depth !== undefined && depth > 0 ? Math.floor(depth) : undefined,
          // Ancestors are context you always want when looking at one item.
          // Links cost a query per node, so they stay opt in, as in the CLI.
          ancestors: query.get('ancestors') !== 'false',
          withLinks: query.get('links') === 'true',
        });
        return tree ? { ...tree, summary: summariseTree(tree) } : undefined;
      }
      case 'sprints': {
        if (rest.length >= 1) {
          const sprint = db.get<jira.SprintRow>('SELECT * FROM jira_sprints WHERE id = ?', [
            Number(rest[0]),
          ]);
          return sprint ? buildSprintDocument(db, sprint).data : undefined;
        }
        return jira.listSprints(db, {
          states: listParam(query, 'state'),
          search,
          limit,
          offset,
        });
      }
      default:
        return undefined;
    }
  }

  return undefined;
}

function serveStatic(pathname: string, response: ServerResponse, assets: string): void {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(assets, relative);

  if (!filePath.startsWith(assets)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // Single page app: unknown routes fall back to index.html.
    filePath = join(assets, 'index.html');
  }

  response.writeHead(200, {
    'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(filePath).pipe(response);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload ?? null, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * Percent-decodes one path segment, leaving it as it came if it cannot be
 * decoded. A malformed escape like `%zz` is somebody's typo, and it should
 * reach a 404 rather than a 500.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function numberParam(query: URLSearchParams, name: string): number | undefined {
  const value = query.get(name);
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function listParam(query: URLSearchParams, name: string): string[] | undefined {
  const values = query.getAll(name).flatMap((value) => value.split(','));
  const filtered = values.map((value) => value.trim()).filter(Boolean);
  return filtered.length > 0 ? filtered : undefined;
}

export function ensureDatabase(path: string): void {
  if (!existsSync(path)) {
    throw new CliError(`No devcontext database at ${path}.`, {
      hint: 'Run "devcontext sync" first.',
    });
  }
}
