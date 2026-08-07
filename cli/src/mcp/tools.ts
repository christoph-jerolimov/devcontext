import type { ResolvedConfig } from '../config/types.js';
import type { Database } from '../db/database.js';
import { SyncJournal } from '../db/journal.js';
import * as gh from '../db/queries/github.js';
import * as jira from '../db/queries/jira.js';
import {
  buildIssueDocument,
  buildPullRequestDocument,
  buildWorkflowRunDocument,
} from '../documents/github.js';
import { buildSprintDocument, buildWorkitemDocument } from '../documents/jira.js';
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

const ISSUE_FILTERS = {
  repo: { type: 'string', description: 'Repository as owner/name. Omit for all repositories.' },
  state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default open.' },
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
    state: (str(args, 'state') as 'open' | 'closed' | 'all' | undefined) ?? 'open',
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
        'Search GitHub issues and pull requests and Jira work items (including their comments) for a phrase. Returns a compact list; follow up with get_issue, get_pull_request or get_workitem for the full history.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to look for.' },
          sources: {
            type: 'array',
            items: { type: 'string', enum: ['github', 'jira'] },
            description: 'Defaults to both.',
          },
          limit: LIMIT,
        },
        required: ['query'],
      },
    },
    run: (args, { db }) => {
      const query = requiredStr(args, 'query');
      const sources = list(args, 'sources') ?? ['github', 'jira'];
      const max = limit(args, 25);
      const results: unknown[] = [];

      if (sources.includes('github')) {
        for (const issue of gh.listIssues(db, { state: 'all', search: query, limit: max })) {
          results.push({
            kind: 'github-issue',
            repository: issue.repo_full_name,
            number: issue.number,
            title: issue.title,
            state: issue.state,
            updatedAt: issue.updated_at,
            url: issue.html_url,
          });
        }
        for (const pull of gh.listPullRequests(db, { state: 'all', search: query, limit: max })) {
          results.push({
            kind: 'github-pull-request',
            repository: pull.repo_full_name,
            number: pull.number,
            title: pull.title,
            state: pull.merged ? 'merged' : pull.state,
            updatedAt: pull.updated_at,
            url: pull.html_url,
          });
        }
      }

      if (sources.includes('jira')) {
        for (const workitem of jira.searchWorkitems(db, query, { limit: max })) {
          results.push({
            kind: 'jira-workitem',
            key: workitem.key,
            summary: workitem.summary,
            type: workitem.type,
            status: workitem.status,
            updatedAt: workitem.updated_at,
            url: workitem.url,
          });
        }
      }

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
      description: 'Filtered list of pull requests.',
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
      description: 'Sprints with their work item counts.',
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
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.definition.name, tool]));
