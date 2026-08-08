import type { ResolvedConfig } from '../config/types.js';
import type { Database } from '../db/database.js';
import { SyncJournal } from '../db/journal.js';
import * as gh from '../db/queries/github.js';
import * as jira from '../db/queries/jira.js';
import * as crossLinks from '../db/queries/links.js';
import * as ticketQueries from '../db/queries/tickets.js';
import * as activityQueries from '../db/queries/activity.js';
import * as contributorQueries from '../db/queries/contributors.js';
import * as historyQueries from '../db/queries/history.js';
import * as insights from '../insights/index.js';
import { buildDigest } from '../insights/digest.js';
import { ROLE_DESCRIPTIONS } from '../contributors/build.js';
import { Directory } from '../people/directory.js';
import {
  buildIssueDocument,
  buildPullRequestDocument,
  buildWorkflowRunDocument,
} from '../documents/github.js';
import { buildSprintDocument, buildWorkitemDocument } from '../documents/jira.js';
import { searchAll } from '../search/index.js';
import type { SearchHit } from '../search/index.js';
import { resolveTimeExpression } from '../util/time.js';
import type { ToolDefinition } from './protocol.js';

export interface ToolContext {
  db: Database;
  config: ResolvedConfig;
}

export interface Tool {
  definition: ToolDefinition;
  run(args: Record<string, unknown>, ctx: ToolContext): unknown;
}

/* -------------------------------------------------------------------------- */
/* Argument helpers                                                            */
/* -------------------------------------------------------------------------- */

class ArgumentError extends Error {}

function str(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ArgumentError(`"${name}" must be a string.`);
  return value;
}

function requiredStr(args: Record<string, unknown>, name: string): string {
  const value = str(args, name);
  if (value === undefined) throw new ArgumentError(`"${name}" is required.`);
  return value;
}

function num(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new ArgumentError(`"${name}" must be a number.`);
  return parsed;
}

function requiredNum(args: Record<string, unknown>, name: string): number {
  const value = num(args, name);
  if (value === undefined) throw new ArgumentError(`"${name}" is required.`);
  return value;
}

function list(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === '') return undefined;
  const entries = Array.isArray(value) ? value.map(String) : String(value).split(',');
  const cleaned = entries.map((entry) => entry.trim()).filter((entry) => entry !== '');
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Accepts `30d`, `2024-01-31` or an ISO timestamp. */
function time(args: Record<string, unknown>, name: string): string | undefined {
  const value = str(args, name);
  return value === undefined ? undefined : resolveTimeExpression(value);
}

function limit(args: Record<string, unknown>, fallback = 50): number {
  const value = num(args, 'limit');
  if (value === undefined) return fallback;
  return Math.max(1, Math.min(500, Math.floor(value)));
}

/**
 * The properties that are actually set, so an exactOptionalPropertyTypes filter
 * does not receive a key whose value is `undefined`.
 */
function defined<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

export function isArgumentError(error: unknown): error is Error {
  return error instanceof ArgumentError;
}

/* -------------------------------------------------------------------------- */
/* Shared schema fragments                                                     */
/* -------------------------------------------------------------------------- */

const LIMIT = { type: 'number', description: 'Maximum number of rows (default 50, max 500).' };
const SEARCH = { type: 'string', description: 'Substring match on the title/summary and body.' };
const TIME =
  'Relative (30d, 6w, 3mo) or absolute (2024-01-31, 2024-01-31T08:00:00Z) point in time.';

/**
 * Filtering by who, on every list that has an author.
 *
 * A person id rather than a login, because one colleague is often three logins
 * and an assistant has no way to know which. `list_people` is where the ids
 * come from; an unknown one is an error rather than an empty list, so a wrong
 * guess is visible instead of looking like a quiet week.
 */
const PEOPLE_FILTERS = {
  person: {
    type: 'array',
    items: { type: 'string' },
    description: 'Configured person ids, from list_people. "me" is whoever the config names.',
  },
  team: {
    type: 'array',
    items: { type: 'string' },
    description: 'Configured team ids, from list_people. Expands to every member.',
  },
};

const ISSUE_FILTERS = {
  repo: { type: 'string', description: 'Repository as owner/name. Omit for all repositories.' },
  state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default all.' },
  labels: { type: 'array', items: { type: 'string' }, description: 'All of these labels.' },
  author: { type: 'string' },
  assignee: { type: 'string' },
  search: SEARCH,
  updatedSince: { type: 'string', description: `Updated at or after. ${TIME}` },
  updatedBefore: { type: 'string', description: `Not updated since then (stale items). ${TIME}` },
  limit: LIMIT,
};

const WORKITEM_FILTERS = {
  project: { type: 'string', description: 'Jira project key, e.g. PLAT.' },
  type: { type: 'array', items: { type: 'string' }, description: 'Story, Bug, Epic, Task, ...' },
  status: { type: 'array', items: { type: 'string' } },
  category: {
    type: 'array',
    items: { type: 'string' },
    description: 'Status category: "To Do", "In Progress", "Done".',
  },
  assignee: { type: 'string', description: 'Display name, substring match.' },
  sprint: { type: 'string', description: 'Sprint name, substring match.' },
  epic: { type: 'string', description: 'Items belonging to this epic key.' },
  search: SEARCH,
  updatedSince: { type: 'string', description: `Updated at or after. ${TIME}` },
  updatedBefore: { type: 'string', description: `Not updated since then (stale items). ${TIME}` },
  limit: LIMIT,
};

function issueFilter(args: Record<string, unknown>): gh.IssueFilter {
  const repo = str(args, 'repo');
  return {
    repos: repo ? [repo] : undefined,
    // Every state by default, matching the CLI and the viewer. An assistant
    // asked "what did we ship" from a list that hides everything finished
    // gives a confidently wrong answer.
    state: (str(args, 'state') as 'open' | 'closed' | 'all' | undefined) ?? 'all',
    labels: list(args, 'labels'),
    author: str(args, 'author'),
    assignee: str(args, 'assignee'),
    search: str(args, 'search'),
    updatedSince: time(args, 'updatedSince'),
    updatedBefore: time(args, 'updatedBefore'),
    limit: limit(args),
  };
}

function workitemFilter(args: Record<string, unknown>): jira.WorkitemFilter {
  const project = str(args, 'project');
  return {
    projects: project ? [project] : undefined,
    types: list(args, 'type'),
    statuses: list(args, 'status'),
    statusCategories: list(args, 'category'),
    assignee: str(args, 'assignee'),
    sprint: str(args, 'sprint'),
    epic: str(args, 'epic'),
    search: str(args, 'search'),
    updatedSince: time(args, 'updatedSince'),
    updatedBefore: time(args, 'updatedBefore'),
    limit: limit(args),
  };
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The tools an assistant gets. They mirror the read commands of the CLI and go
 * through the same query layer, so what an agent sees and what a human sees
 * can never drift apart.
 */
/** `person` and `team` resolved through the directory, or nothing selected. */
function peopleSelection(args: Record<string, unknown>, ctx: ToolContext) {
  return Directory.from(ctx.config).select({
    ...defined({ people: list(args, 'person'), teams: list(args, 'team') }),
  });
}

function ticketFilter(args: Record<string, unknown>, ctx: ToolContext): ticketQueries.TicketFilter {
  const selection = peopleSelection(args, ctx);
  return {
    state: (str(args, 'state') as 'open' | 'closed' | 'all' | undefined) ?? 'all',
    limit: limit(args),
    ...defined({
      sources: list(args, 'source'),
      containers: list(args, 'container'),
      types: list(args, 'type'),
      search: str(args, 'search'),
    }),
    ...(selection ? { people: { github: selection.github, jira: selection.jira } } : {}),
  };
}

function activityFilter(
  args: Record<string, unknown>,
  ctx: ToolContext,
  directory: Directory,
): activityQueries.ActivityFilter {
  const selection = directory.select({
    ...defined({ people: list(args, 'person'), teams: list(args, 'team') }),
  });
  const bots = str(args, 'bots');

  return {
    since: time(args, 'since') ?? resolveTimeExpression('14d'),
    limit: limit(args),
    excludeBots: bots === 'exclude',
    onlyBots: bots === 'only',
    bots: directory.botIdentities(),
    ...defined({
      until: time(args, 'until'),
      sources: list(args, 'source'),
      containers: list(args, 'container'),
      kinds: list(args, 'kind'),
    }),
    ...(selection ? { people: { github: selection.github, jira: selection.jira } } : {}),
  };
}

export const TOOLS: Tool[] = [
  {
    definition: {
      name: 'devcontext_status',
      title: 'What is in the local database',
      description:
        'Row counts per source, the configured projects and the last sync runs. Use this first to find out which repositories and Jira projects are available and how fresh the data is.',
      inputSchema: { type: 'object', properties: {} },
    },
    run: (_args, { db, config }) => ({
      configPath: config.configPath,
      databasePath: config.databasePath,
      projects: config.projects.map((project) => ({
        key: project.key,
        name: project.name,
        github: project.github.map((entry) => entry.fullName),
        jira: project.jira.map((entry) => `${entry.site.name}/${entry.projectKey}`),
      })),
      github: gh.githubStats(db),
      jira: jira.jiraStats(db),
      lastRuns: new SyncJournal(db).listRuns({ limit: 5 }),
    }),
  },

  {
    definition: {
      name: 'list_repositories',
      title: 'Synced GitHub repositories',
      description: 'The GitHub repositories present in the local database.',
      inputSchema: { type: 'object', properties: { limit: LIMIT } },
    },
    run: (args, { db }) =>
      gh.listRepositories(db, { limit: limit(args) }).map((repository) => ({
        fullName: repository.full_name,
        description: repository.description,
        defaultBranch: repository.default_branch,
        openIssues: repository.open_issues,
        syncedAt: repository.synced_at,
      })),
  },

  {
    definition: {
      name: 'search',
      title: 'Search everything',
      description:
        'Search GitHub issues and pull requests and Jira work items, including their comments and reviews, ranked by relevance. Quote a phrase to match it exactly. Returns a compact list with the matching text; follow up with get_issue, get_pull_request or get_workitem for the full history.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to look for.' },
          sources: {
            type: 'array',
            items: { type: 'string', enum: ['github', 'jira'] },
            description: 'Defaults to both.',
          },
          kinds: {
            type: 'array',
            items: { type: 'string', enum: ['issue', 'pull-request', 'workitem'] },
            description: 'Defaults to all three.',
          },
          limit: LIMIT,
        },
        required: ['query'],
      },
    },
    run: (args, { db }) => {
      const query = requiredStr(args, 'query');
      const sources = list(args, 'sources') ?? ['github', 'jira'];
      const requested = list(args, 'kinds') as SearchHit['kind'][] | undefined;

      // `sources` is the older, coarser filter; both narrow the same set.
      const bySource: SearchHit['kind'][] = [
        ...(sources.includes('github') ? (['issue', 'pull-request'] as const) : []),
        ...(sources.includes('jira') ? (['workitem'] as const) : []),
      ];
      const kinds = requested?.length
        ? bySource.filter((kind) => requested.includes(kind))
        : bySource;

      // Reshaped so the fields an assistant needs for the follow up call —
      // repository + number, or key — are right there in the result.
      const results = searchAll(db, query, { kinds, limit: limit(args, 25) }).map((hit) => {
        if (hit.kind === 'workitem') {
          return {
            kind: 'jira-workitem',
            key: hit.ref,
            title: hit.title,
            state: hit.state,
            updatedAt: hit.updatedAt,
            url: hit.url,
            match: hit.snippet,
          };
        }
        const [repository, number] = hit.ref.split('#');
        return {
          kind: hit.kind === 'pull-request' ? 'github-pull-request' : 'github-issue',
          repository,
          number: Number(number),
          title: hit.title,
          state: hit.state,
          updatedAt: hit.updatedAt,
          url: hit.url,
          match: hit.snippet,
        };
      });

      return { query, count: results.length, results };
    },
  },

  {
    definition: {
      name: 'list_issues',
      title: 'List GitHub issues',
      description:
        'Filtered list of GitHub issues. Use updatedBefore to find stale ones, e.g. updatedBefore="90d".',
      inputSchema: { type: 'object', properties: ISSUE_FILTERS },
    },
    run: (args, { db }) =>
      gh.listIssues(db, issueFilter(args)).map((issue) => ({
        repository: issue.repo_full_name,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        author: issue.author,
        labels: JSON.parse(issue.labels ?? '[]') as string[],
        comments: issue.comment_count,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        url: issue.html_url,
      })),
  },

  {
    definition: {
      name: 'get_issue',
      title: 'One GitHub issue in full',
      description:
        'The complete issue: body, every comment and the full timeline (labels added and removed, assignments, closes, reopens, renames).',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository as owner/name.' },
          number: { type: 'number' },
        },
        required: ['repo', 'number'],
      },
    },
    run: (args, { db }) => {
      const repo = requiredStr(args, 'repo');
      const number = requiredNum(args, 'number');
      const issue = gh.getIssue(db, repo, number);
      if (!issue) throw new ArgumentError(`No issue ${repo}#${number} in the local database.`);
      return buildIssueDocument(db, issue).data;
    },
  },

  {
    definition: {
      name: 'list_pull_requests',
      title: 'List GitHub pull requests',
      description:
        'Filtered list of pull requests. Every state by default, not just the open ones GitHub shows.',
      inputSchema: {
        type: 'object',
        properties: {
          ...ISSUE_FILTERS,
          merged: { type: 'boolean', description: 'Only merged / only unmerged.' },
          baseRef: { type: 'string', description: 'Target branch.' },
          reviewer: { type: 'string', description: 'Reviewed by this login.' },
        },
      },
    },
    run: (args, { db }) => {
      const merged = typeof args['merged'] === 'boolean' ? (args['merged'] as boolean) : undefined;
      return gh
        .listPullRequests(db, {
          ...issueFilter(args),
          merged,
          baseRef: str(args, 'baseRef'),
          reviewer: str(args, 'reviewer'),
        })
        .map((pull) => ({
          repository: pull.repo_full_name,
          number: pull.number,
          title: pull.title,
          state: pull.merged ? 'merged' : pull.state,
          draft: Boolean(pull.draft),
          author: pull.author,
          head: pull.head_ref,
          base: pull.base_ref,
          additions: pull.additions,
          deletions: pull.deletions,
          createdAt: pull.created_at,
          updatedAt: pull.updated_at,
          mergedAt: pull.merged_at,
          url: pull.html_url,
        }));
    },
  },

  {
    definition: {
      name: 'get_pull_request',
      title: 'One pull request in full',
      description:
        'The complete pull request: body, commits, changed files, every review with its inline comments, the conversation and the timeline.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository as owner/name.' },
          number: { type: 'number' },
        },
        required: ['repo', 'number'],
      },
    },
    run: (args, { db }) => {
      const repo = requiredStr(args, 'repo');
      const number = requiredNum(args, 'number');
      const pull = gh.getPullRequest(db, repo, number);
      if (!pull)
        throw new ArgumentError(`No pull request ${repo}#${number} in the local database.`);
      return buildPullRequestDocument(db, pull).data;
    },
  },

  {
    definition: {
      name: 'list_workitems',
      title: 'List Jira work items',
      description:
        'Filtered list of Jira work items. Use updatedBefore for stale ones and category="In Progress" for work in flight.',
      inputSchema: { type: 'object', properties: WORKITEM_FILTERS },
    },
    run: (args, { db }) =>
      jira.listWorkitems(db, workitemFilter(args)).map((workitem) => ({
        key: workitem.key,
        summary: workitem.summary,
        type: workitem.type,
        status: workitem.status,
        statusCategory: workitem.status_category,
        assignee: workitem.assignee,
        storyPoints: workitem.story_points,
        sprint: workitem.sprint_name,
        epic: workitem.epic_key,
        updatedAt: workitem.updated_at,
        url: workitem.url,
      })),
  },

  {
    definition: {
      name: 'get_workitem',
      title: 'One Jira work item in full',
      description:
        'The complete work item: description, custom fields, links, every comment and the full field history (status changes, label changes, sprint moves).',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Work item key, e.g. PLAT-42.' } },
        required: ['key'],
      },
    },
    run: (args, { db }) => {
      const key = requiredStr(args, 'key');
      const workitem = jira.getWorkitem(db, key);
      if (!workitem) throw new ArgumentError(`No work item ${key.toUpperCase()} in the database.`);
      return buildWorkitemDocument(db, workitem).data;
    },
  },

  {
    definition: {
      name: 'list_sprints',
      title: 'List sprints',
      description:
        'Sprints with their work item counts, and the sprint ids get_sprint and sprint_burndown take.',
      inputSchema: {
        type: 'object',
        properties: {
          state: {
            type: 'array',
            items: { type: 'string', enum: ['future', 'active', 'closed'] },
          },
          limit: LIMIT,
        },
      },
    },
    run: (args, { db }) =>
      jira.listSprints(db, { states: list(args, 'state'), limit: limit(args) }).map((sprint) => ({
        id: sprint.id,
        name: sprint.name,
        state: sprint.state,
        goal: sprint.goal,
        startDate: sprint.start_date,
        endDate: sprint.end_date,
        workitems: sprint.workitem_count ?? 0,
      })),
  },

  {
    definition: {
      name: 'get_sprint',
      title: 'One sprint with its work items',
      description: 'A sprint including every work item, the story point sum and the done count.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
    run: (args, { db }) => {
      const id = requiredNum(args, 'id');
      const sprint = db.get<jira.SprintRow>('SELECT * FROM jira_sprints WHERE id = ?', [id]);
      if (!sprint) throw new ArgumentError(`No sprint ${id} in the local database.`);
      return buildSprintDocument(db, sprint).data;
    },
  },

  {
    definition: {
      name: 'get_links',
      title: 'Cross references between GitHub and Jira',
      description:
        'Everything linked to a reference: the Jira work items a pull request mentions (in its branch, title, body or commits) and the pull requests and issues that mention a work item. Give it "acme/platform#42" or "PLAT-7".',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'A GitHub reference (owner/repo#42) or a Jira key (PLAT-7).',
          },
        },
        required: ['ref'],
      },
    },
    run: (args, { db }) => {
      const ref = requiredStr(args, 'ref');
      return { ref: crossLinks.normaliseRef(ref), links: crossLinks.linksFor(db, ref) };
    },
  },

  {
    definition: {
      name: 'contributors',
      title: 'Who worked on an item, and in what capacity',
      description:
        'The people on one issue, pull request or work item, each with what they actually did — wrote it, reviewed it, committed to it, commented on it, merged it. The author field alone names the one person guaranteed not to have reviewed it. Use rollup on an epic: nobody contributes to a heading, so without it the answer is whoever created the heading.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'A GitHub reference (owner/repo#42) or a Jira key (PLAT-7).',
          },
          rollup: {
            type: 'boolean',
            description:
              'Include everything beneath it: child work items, and the pull requests linked to any of them. The only route from a Jira key to the people who wrote the code.',
          },
          role: { type: 'string', description: 'Only this capacity.' },
        },
        required: ['ref'],
      },
    },
    run: (args, ctx) => {
      const ref = requiredStr(args, 'ref');
      const refs = args['rollup'] === true ? contributorQueries.descendantsOf(ctx.db, ref) : [ref];
      const role = str(args, 'role');
      const directory = Directory.from(ctx.config);

      return {
        ref,
        covers: refs,
        people: contributorQueries
          .contributorsOf(ctx.db, refs)
          .filter((person) => role === undefined || person.roles.includes(role))
          .map((person) =>
            Object.assign(person, {
              person: directory.identify(person.source, person.identity)?.name ?? null,
            }),
          ),
        roles: ROLE_DESCRIPTIONS,
      };
    },
  },

  {
    definition: {
      name: 'list_workflow_runs',
      title: 'List GitHub Actions runs',
      description: 'Filtered list of workflow runs, newest first.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository as owner/name.' },
          workflow: { type: 'string', description: 'Workflow name or file path.' },
          conclusion: {
            type: 'string',
            description: 'success, failure, cancelled, skipped, ...',
          },
          branch: { type: 'string' },
          limit: LIMIT,
        },
      },
    },
    run: (args, { db }) => {
      const repo = str(args, 'repo');
      return gh
        .listWorkflowRuns(db, {
          repos: repo ? [repo] : undefined,
          workflow: str(args, 'workflow'),
          conclusion: str(args, 'conclusion'),
          branch: str(args, 'branch'),
          limit: limit(args),
        })
        .map((run) => ({
          id: run.id,
          repository: run.repo_full_name,
          workflow: run.workflow_name,
          runNumber: run.run_number,
          event: run.event,
          status: run.status,
          conclusion: run.conclusion,
          branch: run.head_branch,
          createdAt: run.created_at,
          url: run.html_url,
        }));
    },
  },

  {
    definition: {
      name: 'get_workflow_run',
      title: 'One workflow run with jobs and steps',
      description:
        'A workflow run including every job and every step with its conclusion and duration — the fastest way to find which step failed.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number', description: 'Workflow run id.' } },
        required: ['id'],
      },
    },
    run: (args, { db }) => {
      const id = requiredNum(args, 'id');
      const run = db.get<gh.WorkflowRunRow>('SELECT * FROM gh_workflow_runs WHERE id = ?', [id]);
      if (!run) throw new ArgumentError(`No workflow run ${id} in the local database.`);
      return buildWorkflowRunDocument(db, run).data;
    },
  },

  /* ------------------------------------------------------------------------ */
  /* Everything above answers "what is the state of things". The rest answer   */
  /* questions the current tables cannot: who did it, what shape it took, and  */
  /* which colleague the names belong to.                                      */
  /* ------------------------------------------------------------------------ */

  {
    definition: {
      name: 'list_tickets',
      title: 'GitHub issues and Jira work items as one list',
      description:
        'Both trackers in one list, with one vocabulary. Prefer this over list_issues + list_workitems when the question is about work rather than about a tool. Pull requests are deliberately not here — a pull request is a change, not a request for one.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['github', 'jira'], description: 'Both when omitted.' },
          container: {
            type: 'array',
            items: { type: 'string' },
            description: 'Repositories (acme/platform) and Jira project keys (PLAT), mixed.',
          },
          type: { type: 'array', items: { type: 'string' }, description: 'Bug, Story, Issue, ...' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default all.' },
          ...PEOPLE_FILTERS,
          search: SEARCH,
          limit: LIMIT,
        },
      },
    },
    run: (args, ctx) => {
      const filter = ticketFilter(args, ctx);
      return {
        tickets: ticketQueries.listTickets(ctx.db, filter),
        // So the answer can say "showing 50 of 900" rather than implying the
        // page it got is everything there is.
        total: ticketQueries.countTickets(ctx.db, filter),
      };
    },
  },

  {
    definition: {
      name: 'ticket_types',
      title: 'Which ticket types exist, and how many carry each',
      description:
        'The types actually present in the data, with counts. Use it before filtering by type: the vocabulary is whatever these projects use, not a fixed list.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['github', 'jira'] },
          container: { type: 'array', items: { type: 'string' } },
          state: { type: 'string', enum: ['open', 'closed', 'all'] },
          ...PEOPLE_FILTERS,
        },
      },
    },
    run: (args, ctx) => ticketQueries.ticketTypes(ctx.db, ticketFilter(args, ctx)),
  },

  {
    definition: {
      name: 'list_activity',
      title: 'What people did, newest first',
      description:
        'Status changes, comments and reviews across both platforms. This is the only tool that answers "what happened" — every list above answers "what is the state of things", and an item opened, argued over and closed looks there exactly like one nobody touched.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: `Default 14d. ${TIME}` },
          until: { type: 'string', description: TIME },
          source: { type: 'string', enum: ['github', 'jira'] },
          container: { type: 'array', items: { type: 'string' } },
          kind: {
            type: 'array',
            items: { type: 'string', enum: ['status', 'comment', 'review'] },
            description: 'All three when omitted.',
          },
          ...PEOPLE_FILTERS,
          bots: {
            type: 'string',
            enum: ['include', 'exclude', 'only'],
            description: 'Default include.',
          },
          limit: LIMIT,
        },
      },
    },
    run: (args, ctx) => {
      const directory = Directory.from(ctx.config);
      const filter = activityFilter(args, ctx, directory);
      return {
        events: activityQueries.listActivity(ctx.db, filter).map((event) =>
          Object.assign(event, {
            person: directory.identify(event.source, event.actor)?.name ?? null,
          }),
        ),
        total: activityQueries.countActivity(ctx.db, filter),
      };
    },
  },

  {
    definition: {
      name: 'activity_by_person',
      title: 'Who was busy in a window',
      description:
        'The same window rolled up per identity. Per identity rather than per person on purpose: a second row under a familiar name is a login nobody mapped, which is worth seeing.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: `Default 14d. ${TIME}` },
          until: { type: 'string', description: TIME },
          container: { type: 'array', items: { type: 'string' } },
          ...PEOPLE_FILTERS,
          limit: LIMIT,
        },
      },
    },
    run: (args, ctx) =>
      activityQueries.activityByActor(
        ctx.db,
        activityFilter(args, ctx, Directory.from(ctx.config)),
      ),
  },

  {
    definition: {
      name: 'list_people',
      title: 'The configured people, bots and teams',
      description:
        'Who the names in the data belong to. Call this before filtering by person or team: the ids these tools accept are defined here, and one person often has several logins.',
      inputSchema: { type: 'object', properties: {} },
    },
    run: (_args, ctx) => {
      const directory = Directory.from(ctx.config);
      return {
        me: directory.me?.id ?? null,
        people: directory.people,
        teams: directory.teams.map((team) => ({
          id: team.id,
          name: team.name,
          description: team.description,
          people: directory.membersOf(team).map((person) => person.name),
        })),
      };
    },
  },

  {
    definition: {
      name: 'open_items_history',
      title: 'How many items were open, day by day',
      description:
        'The balance over a window, which no other tool can answer: the current tables know where an item ended up, not the shape it took getting there.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: `Default 30 days ago. ${TIME}` },
          to: { type: 'string', description: TIME },
          source: { type: 'string', enum: ['github', 'jira'] },
          container: { type: 'string' },
          kind: { type: 'string', enum: ['issue', 'pull_request', 'workitem'] },
          assignee: { type: 'string' },
        },
      },
    },
    run: (args, { db }) => {
      const to = time(args, 'to') ?? new Date().toISOString();
      const from = time(args, 'from') ?? new Date(Date.now() - 29 * 86_400_000).toISOString();
      return {
        from,
        to,
        days: historyQueries.openByDay(db, {
          from,
          to,
          ...defined({
            source: str(args, 'source'),
            container: str(args, 'container'),
            kind: str(args, 'kind'),
            assignee: str(args, 'assignee'),
          }),
        }),
      };
    },
  },

  {
    definition: {
      name: 'sprint_burndown',
      title: 'How a sprint actually went',
      description:
        'Remaining work per day against the ideal, with the scope changes listed. Unlike get_sprint this reads the history, so work pulled in mid sprint lifts the line on the day it arrived rather than being backdated to the start.',
      inputSchema: {
        type: 'object',
        properties: {
          sprint: { type: 'number', description: 'Sprint id, as list_sprints gives.' },
        },
        required: ['sprint'],
      },
    },
    run: (args, { db }) => {
      const id = requiredNum(args, 'sprint');
      const report = insights.sprintBurndown(db, id);
      if (!report) throw new ArgumentError(`No sprint ${String(id)} in the local database.`);
      return report;
    },
  },

  {
    definition: {
      name: 'sprint_velocity',
      title: 'Committed against completed, sprint by sprint',
      description:
        'Both figures read at the instant they refer to, so work that arrived after the plan was agreed is not counted as work the team promised. A ratio above 100% means exactly that, and the added column says how much.',
      inputSchema: {
        type: 'object',
        properties: {
          board: { type: 'number', description: 'One board, when several teams share a site.' },
          limit: LIMIT,
        },
      },
    },
    run: (args, { db }) =>
      insights.sprintVelocity(db, {
        limit: limit(args, 10),
        ...defined({ board: num(args, 'board') }),
      }),
  },

  {
    definition: {
      name: 'status_times',
      title: 'How long work sits in each status',
      description:
        'Median, p85 and longest stay per status. cycle_time measures the whole journey; this says which stop is the slow one. A stay that has not ended is counted separately rather than averaged in as if it were short.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: `Default 90d. ${TIME}` },
          project: { type: 'array', items: { type: 'string' }, description: 'Jira project keys.' },
          limit: LIMIT,
        },
      },
    },
    run: (args, { db }) =>
      insights.statusTimes(db, {
        from: time(args, 'since') ?? resolveTimeExpression('90d'),
        limit: limit(args, 15),
        ...defined({ containers: list(args, 'project') }),
      }),
  },

  {
    definition: {
      name: 'cumulative_flow',
      title: 'How many items sat in each status, day by day',
      description:
        'A cumulative flow diagram over the status history: the count in every status on every day, with the statuses in board order. open_items_history knows only open and closed, so a backlog of forty and a review queue of forty look the same there; this tells them apart.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: `Default 30 days ago. ${TIME}` },
          to: { type: 'string', description: TIME },
          project: { type: 'array', items: { type: 'string' }, description: 'Jira project keys.' },
          status: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only these statuses. Every status present when omitted.',
          },
        },
      },
    },
    run: (args, { db }) =>
      insights.cumulativeFlow(db, {
        ...defined({
          from: time(args, 'from'),
          to: time(args, 'to'),
          containers: list(args, 'project'),
          statuses: list(args, 'status'),
        }),
      }),
  },

  {
    definition: {
      name: 'insights',
      title: 'Cycle time, review latency, work in progress, stale work, flaky steps',
      description:
        'The standing health report over a window. Ask for one section when the question is narrow; the whole thing is a lot of numbers at once.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: `Default 90d. ${TIME}` },
          section: {
            type: 'string',
            enum: ['cycle-time', 'review-latency', 'wip', 'stale', 'flaky'],
            description: 'All of them when omitted.',
          },
          repo: { type: 'array', items: { type: 'string' } },
          project: { type: 'array', items: { type: 'string' } },
          limit: LIMIT,
        },
      },
    },
    run: (args, { db }) => {
      const filter = {
        since: time(args, 'since') ?? resolveTimeExpression('90d'),
        limit: limit(args, 15),
        ...defined({ repos: list(args, 'repo'), projects: list(args, 'project') }),
      };
      const staleAfter = new Date(Date.now() - 30 * 86_400_000).toISOString();

      switch (str(args, 'section')) {
        case 'cycle-time':
          return insights.cycleTime(db, filter);
        case 'review-latency':
          return insights.reviewLatency(db, filter);
        case 'wip':
          return insights.wip(db, filter);
        case 'stale':
          return insights.staleItems(db, staleAfter, filter);
        case 'flaky':
          return insights.flakySteps(db, filter);
        default:
          return {
            cycleTime: insights.cycleTime(db, filter),
            reviewLatency: insights.reviewLatency(db, filter),
            wip: insights.wip(db, filter),
            stale: insights.staleItems(db, staleAfter, filter),
            flaky: insights.flakySteps(db, filter),
          };
      }
    },
  },

  {
    definition: {
      name: 'digest',
      title: 'What happened in a window, ready to summarise',
      description:
        'Merged, finished, started and opened in one window, with who did it and what is still stuck. The tool to reach for when asked to write a standup or a weekly update.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: `Default 7d. ${TIME}` },
          until: { type: 'string', description: TIME },
          repo: { type: 'array', items: { type: 'string' } },
          project: { type: 'array', items: { type: 'string' } },
          person: {
            type: 'array',
            items: { type: 'string' },
            description: 'A configured person id, or a raw login / display name.',
          },
          limit: LIMIT,
        },
      },
    },
    run: (args, ctx) => {
      const directory = Directory.from(ctx.config);
      const asked = list(args, 'person');
      // One person id becomes every identity they answer to, across both
      // sources; anything the directory does not know is passed through.
      const people = asked?.flatMap((value) => {
        const person = directory.person(value);
        return person ? person.github.concat(person.jira) : [value];
      });

      return buildDigest(ctx.db, {
        since: time(args, 'since') ?? resolveTimeExpression('7d'),
        staleAfter: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        limit: limit(args, 10),
        ...defined({
          until: time(args, 'until'),
          repos: list(args, 'repo'),
          projects: list(args, 'project'),
          people,
        }),
      });
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.definition.name, tool]));
