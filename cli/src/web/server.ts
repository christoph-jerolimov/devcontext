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
import { buildWorkitemTree, summariseTree } from '../db/queries/tree.js';
import { buildDigest } from '../insights/digest.js';
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
  const segments = url.pathname
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean);
  const query = url.searchParams;

  const limit = numberParam(query, 'limit') ?? 100;
  const offset = numberParam(query, 'offset');
  const repos = listParam(query, 'repo');
  const search = query.get('search') ?? undefined;

  const [area, resource, ...rest] = segments;

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
      links: crossLinks.linkStats(db),
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
          state: (query.get('state') as 'open' | 'closed' | 'all') ?? 'open',
          labels: listParam(query, 'label'),
          author: query.get('author') ?? undefined,
          assignee: query.get('assignee') ?? undefined,
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
          state: (query.get('state') as 'open' | 'closed' | 'all') ?? 'open',
          labels: listParam(query, 'label'),
          author: query.get('author') ?? undefined,
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
