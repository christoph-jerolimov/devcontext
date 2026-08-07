import { Command } from 'commander';

import { parseJsonColumn } from '../db/database.js';
import * as gh from '../db/queries/github.js';
import {
  buildIssueDocument,
  buildPullRequestDocument,
  buildWorkflowRunDocument,
} from '../documents/github.js';
import { renderDocument } from '../output/document.js';
import { printOutput, renderTable, truncate } from '../output/format.js';
import type { Column } from '../output/format.js';
import { CliError } from '../util/errors.js';
import { formatDuration, formatRelative } from '../util/time.js';
import {
  addListOptions,
  addOutputOptions,
  addTimeFilterOptions,
  collect,
  openReadContext,
  parseLimit,
  readOffset,
  readTimeFilters,
} from './shared.js';

const labels = (value: string | null): string => parseJsonColumn<string[]>(value, []).join(', ');

export function createGithubCommand(): Command {
  const github = new Command('github')
    .alias('gh')
    .description('read GitHub data from the local database');

  github.addCommand(reposCommand());
  github.addCommand(issuesCommand());
  github.addCommand(pullRequestsCommand());
  github.addCommand(workflowsCommand());
  github.addCommand(runsCommand());
  github.addCommand(jobsCommand());
  github.addCommand(stepsCommand());
  github.addCommand(logsCommand());

  return github;
}

function reposCommand(): Command {
  const command = new Command('repos')
    .aliases(['repo', 'repositories', 'repository'])
    .description('list the repositories that have been synced');

  return addListOptions(command).action((options: Record<string, unknown>, self: Command) => {
    const ctx = openReadContext(self);
    try {
      const rows = gh.listRepositories(ctx.db, {
        search: options['search'] as string | undefined,
        limit: parseLimit(options['limit'] as string | undefined),
        offset: readOffset(options),
      });

      const columns: Column<gh.RepositoryRow>[] = [
        { header: 'REPOSITORY', value: (row) => row.full_name },
        { header: 'ISSUES', value: (row) => row.open_issues ?? 0, align: 'right', optional: true },
        { header: 'STARS', value: (row) => row.stars ?? 0, align: 'right', optional: true },
        { header: 'PUSHED', value: (row) => formatRelative(row.pushed_at), optional: true },
        { header: 'SYNCED', value: (row) => formatRelative(row.synced_at) },
        { header: 'DESCRIPTION', value: (row) => truncate(row.description, 60), optional: true },
      ];

      printOutput(
        renderTable(rows, columns, {
          format: ctx.format,
          list: ctx.list,
          listValue: (row) => row.full_name,
          title: 'Repositories',
          emptyMessage: 'No repositories synced yet. Run "devcontext sync".',
        }),
      );
    } finally {
      ctx.close();
    }
  });
}

function issuesCommand(): Command {
  const command = new Command('issues')
    .aliases(['issue'])
    .description('list issues, or show one issue with all comments and events')
    .argument('[number]', 'issue number to show in detail')
    .option('-r, --repo <repo>', 'repository (owner/name), repeatable', collect, [])
    .option('-s, --state <state>', 'open, closed or all', 'open')
    .option('-l, --label <label>', 'label filter, repeatable', collect, [])
    .option('-a, --author <login>', 'issue author')
    .option('--assignee <login>', 'assigned to this user')
    .option('--milestone <title>', 'milestone title')
    .option('--sort <field>', 'updated, created or number', 'updated')
    .option('--order <direction>', 'asc or desc', 'desc');

  addTimeFilterOptions(command);

  return addListOptions(command).action(
    (number: string | undefined, options: Record<string, unknown>, self: Command) => {
      const ctx = openReadContext(self);
      try {
        const repos = options['repo'] as string[];

        if (number !== undefined) {
          const issue = findIssue(ctx.db, repos, Number(number));
          printOutput(renderDocument(buildIssueDocument(ctx.db, issue), ctx.format));
          return;
        }

        const rows = gh.listIssues(ctx.db, {
          repos: repos.length > 0 ? repos : undefined,
          state: options['state'] as 'open' | 'closed' | 'all',
          labels: options['label'] as string[],
          author: options['author'] as string | undefined,
          assignee: options['assignee'] as string | undefined,
          milestone: options['milestone'] as string | undefined,
          search: options['search'] as string | undefined,
          sort: options['sort'] as 'updated' | 'created' | 'number',
          order: options['order'] as 'asc' | 'desc',
          limit: parseLimit(options['limit'] as string | undefined),
          offset: readOffset(options),
          ...readTimeFilters(options),
        });

        const columns: Column<gh.IssueRow>[] = [
          { header: 'REPOSITORY', value: (row) => row.repo_full_name, optional: true },
          { header: 'NUMBER', value: (row) => `#${row.number}`, align: 'right' },
          { header: 'STATE', value: (row) => row.state },
          { header: 'TITLE', value: (row) => truncate(row.title, 70) },
          { header: 'AUTHOR', value: (row) => row.author, optional: true },
          { header: 'LABELS', value: (row) => truncate(labels(row.labels), 30), optional: true },
          { header: 'UPDATED', value: (row) => formatRelative(row.updated_at) },
        ];

        printOutput(
          renderTable(rows, columns, {
            format: ctx.format,
            list: ctx.list,
            listValue: (row) => `${row.repo_full_name}#${row.number}`,
            title: 'Issues',
            emptyMessage: 'No issues match these filters.',
          }),
        );
      } finally {
        ctx.close();
      }
    },
  );
}

function pullRequestsCommand(): Command {
  const command = new Command('prs')
    .aliases(['pr', 'pullrequest', 'pullrequests', 'pull-request', 'pull-requests'])
    .description('list pull requests, or show one with reviews, commits and files')
    .argument('[number]', 'pull request number to show in detail')
    .option('-r, --repo <repo>', 'repository (owner/name), repeatable', collect, [])
    // Unlike issues, which default to open: a merged pull request is the
    // normal end of one, and hiding them makes the list read as if nothing
    // ever shipped. `--state open` narrows it back down.
    .option('-s, --state <state>', 'open, closed or all', 'all')
    .option('-l, --label <label>', 'label filter, repeatable', collect, [])
    .option('-a, --author <login>', 'pull request author')
    .option('--assignee <login>', 'assigned to this user')
    .option('--reviewer <login>', 'reviewed by this user')
    .option('--base <ref>', 'target branch')
    .option('--draft', 'only drafts')
    .option('--no-draft', 'exclude drafts')
    .option('--merged', 'only merged pull requests')
    .option('--no-merged', 'only unmerged pull requests')
    .option('--sort <field>', 'updated, created or number', 'updated')
    .option('--order <direction>', 'asc or desc', 'desc');

  addTimeFilterOptions(command);

  return addListOptions(command).action(
    (number: string | undefined, options: Record<string, unknown>, self: Command) => {
      const ctx = openReadContext(self);
      try {
        const repos = options['repo'] as string[];

        if (number !== undefined) {
          const pr = findPullRequest(ctx.db, repos, Number(number));
          printOutput(renderDocument(buildPullRequestDocument(ctx.db, pr), ctx.format));
          return;
        }

        // Commander sets these to `true`/`false` only when the flag was used.
        const draft =
          self.getOptionValueSourceWithGlobals('draft') === 'cli'
            ? (options['draft'] as boolean)
            : undefined;
        const merged =
          self.getOptionValueSourceWithGlobals('merged') === 'cli'
            ? (options['merged'] as boolean)
            : undefined;

        const rows = gh.listPullRequests(ctx.db, {
          repos: repos.length > 0 ? repos : undefined,
          state: options['state'] as 'open' | 'closed' | 'all',
          labels: options['label'] as string[],
          author: options['author'] as string | undefined,
          assignee: options['assignee'] as string | undefined,
          reviewer: options['reviewer'] as string | undefined,
          baseRef: options['base'] as string | undefined,
          draft,
          merged,
          search: options['search'] as string | undefined,
          sort: options['sort'] as 'updated' | 'created' | 'number',
          order: options['order'] as 'asc' | 'desc',
          limit: parseLimit(options['limit'] as string | undefined),
          offset: readOffset(options),
          ...readTimeFilters(options),
        });

        const columns: Column<gh.PullRequestRow>[] = [
          { header: 'REPOSITORY', value: (row) => row.repo_full_name, optional: true },
          { header: 'NUMBER', value: (row) => `#${row.number}`, align: 'right' },
          { header: 'STATE', value: (row) => (row.merged ? 'merged' : row.state) },
          { header: 'TITLE', value: (row) => truncate(row.title, 60) },
          { header: 'AUTHOR', value: (row) => row.author, optional: true },
          {
            header: 'CHANGES',
            value: (row) => `+${row.additions ?? 0}/-${row.deletions ?? 0}`,
            align: 'right',
            optional: true,
          },
          { header: 'UPDATED', value: (row) => formatRelative(row.updated_at) },
        ];

        printOutput(
          renderTable(rows, columns, {
            format: ctx.format,
            list: ctx.list,
            listValue: (row) => `${row.repo_full_name}#${row.number}`,
            title: 'Pull requests',
            emptyMessage: 'No pull requests match these filters.',
          }),
        );
      } finally {
        ctx.close();
      }
    },
  );
}

function workflowsCommand(): Command {
  const command = new Command('workflows')
    .aliases(['workflow', 'actions', 'action'])
    .description('list the GitHub Actions workflows of the synced repositories')
    .option('-r, --repo <repo>', 'repository (owner/name), repeatable', collect, []);

  return addListOptions(command).action((options: Record<string, unknown>, self: Command) => {
    const ctx = openReadContext(self);
    try {
      const repos = options['repo'] as string[];
      const rows = gh.listWorkflows(ctx.db, {
        repos: repos.length > 0 ? repos : undefined,
        search: options['search'] as string | undefined,
        limit: parseLimit(options['limit'] as string | undefined),
        offset: readOffset(options),
      });

      const columns: Column<gh.WorkflowRow>[] = [
        { header: 'REPOSITORY', value: (row) => row.repo_full_name, optional: true },
        { header: 'ID', value: (row) => row.id, align: 'right', optional: true },
        { header: 'NAME', value: (row) => row.name },
        { header: 'PATH', value: (row) => row.path, optional: true },
        { header: 'STATE', value: (row) => row.state },
        { header: 'RUNS', value: (row) => row.run_count ?? 0, align: 'right' },
        { header: 'LAST RUN', value: (row) => formatRelative(row.last_run_at) },
      ];

      printOutput(
        renderTable(rows, columns, {
          format: ctx.format,
          list: ctx.list,
          listValue: (row) => row.name ?? String(row.id),
          title: 'Workflows',
          emptyMessage: 'No workflows synced yet.',
        }),
      );
    } finally {
      ctx.close();
    }
  });
}

function runsCommand(): Command {
  const command = new Command('runs')
    .aliases(['run'])
    .description('list workflow runs, or show one run with its jobs and steps')
    .argument('[id]', 'workflow run id to show in detail')
    .option('-r, --repo <repo>', 'repository (owner/name), repeatable', collect, [])
    .option('-w, --workflow <name>', 'workflow name or file path')
    .option('--status <status>', 'queued, in_progress or completed')
    .option('--conclusion <conclusion>', 'success, failure, cancelled, skipped, ...')
    .option('--branch <ref>', 'head branch')
    .option('--event <event>', 'trigger event (push, pull_request, schedule, ...)')
    .option('--actor <login>', 'user that triggered the run');

  addTimeFilterOptions(command);

  return addListOptions(command).action(
    (id: string | undefined, options: Record<string, unknown>, self: Command) => {
      const ctx = openReadContext(self);
      try {
        if (id !== undefined) {
          const run = ctx.db.get<gh.WorkflowRunRow>('SELECT * FROM gh_workflow_runs WHERE id = ?', [
            Number(id),
          ]);
          if (!run) throw new CliError(`No workflow run with id ${id} in the database.`);
          printOutput(renderDocument(buildWorkflowRunDocument(ctx.db, run), ctx.format));
          return;
        }

        const repos = options['repo'] as string[];
        const times = readTimeFilters(options);
        const rows = gh.listWorkflowRuns(ctx.db, {
          repos: repos.length > 0 ? repos : undefined,
          workflow: options['workflow'] as string | undefined,
          status: options['status'] as string | undefined,
          conclusion: options['conclusion'] as string | undefined,
          branch: options['branch'] as string | undefined,
          event: options['event'] as string | undefined,
          actor: options['actor'] as string | undefined,
          search: options['search'] as string | undefined,
          createdSince: times.createdSince ?? times.updatedSince,
          createdBefore: times.createdBefore ?? times.updatedBefore,
          limit: parseLimit(options['limit'] as string | undefined),
          offset: readOffset(options),
        });

        const columns: Column<gh.WorkflowRunRow>[] = [
          { header: 'REPOSITORY', value: (row) => row.repo_full_name, optional: true },
          { header: 'ID', value: (row) => row.id, align: 'right' },
          { header: 'WORKFLOW', value: (row) => truncate(row.workflow_name, 28) },
          {
            header: 'RUN',
            value: (row) => `#${row.run_number ?? 0}`,
            align: 'right',
            optional: true,
          },
          { header: 'EVENT', value: (row) => row.event, optional: true },
          { header: 'BRANCH', value: (row) => truncate(row.head_branch, 24), optional: true },
          { header: 'STATUS', value: (row) => row.status },
          { header: 'CONCLUSION', value: (row) => row.conclusion },
          { header: 'CREATED', value: (row) => formatRelative(row.created_at) },
        ];

        printOutput(
          renderTable(rows, columns, {
            format: ctx.format,
            list: ctx.list,
            listValue: (row) => row.id,
            title: 'Workflow runs',
            emptyMessage: 'No workflow runs match these filters.',
          }),
        );
      } finally {
        ctx.close();
      }
    },
  );
}

function jobsCommand(): Command {
  const command = new Command('jobs')
    .aliases(['job'])
    .description('list workflow jobs')
    .argument('[runId]', 'only jobs of this workflow run')
    .option('-r, --repo <repo>', 'repository (owner/name), repeatable', collect, [])
    .option('--conclusion <conclusion>', 'success, failure, cancelled, skipped, ...');

  return addListOptions(command).action(
    (runId: string | undefined, options: Record<string, unknown>, self: Command) => {
      const ctx = openReadContext(self);
      try {
        const repos = options['repo'] as string[];
        const rows = gh.listWorkflowJobs(ctx.db, {
          runId: runId !== undefined ? Number(runId) : undefined,
          repos: repos.length > 0 ? repos : undefined,
          conclusion: options['conclusion'] as string | undefined,
          search: options['search'] as string | undefined,
          limit: parseLimit(options['limit'] as string | undefined),
          offset: readOffset(options),
        });

        const columns: Column<gh.WorkflowJobRow>[] = [
          { header: 'REPOSITORY', value: (row) => row.repo_full_name, optional: true },
          { header: 'JOB', value: (row) => row.id, align: 'right' },
          { header: 'RUN', value: (row) => row.run_id, align: 'right', optional: true },
          { header: 'NAME', value: (row) => truncate(row.name, 40) },
          { header: 'STATUS', value: (row) => row.status },
          { header: 'CONCLUSION', value: (row) => row.conclusion },
          {
            header: 'DURATION',
            value: (row) => (row.duration_ms === null ? '' : formatDuration(row.duration_ms)),
            align: 'right',
          },
          { header: 'STARTED', value: (row) => formatRelative(row.started_at) },
        ];

        printOutput(
          renderTable(rows, columns, {
            format: ctx.format,
            list: ctx.list,
            listValue: (row) => row.id,
            title: 'Workflow jobs',
            emptyMessage: 'No workflow jobs match these filters.',
          }),
        );
      } finally {
        ctx.close();
      }
    },
  );
}

function stepsCommand(): Command {
  const command = new Command('steps')
    .aliases(['step'])
    .description('list workflow steps')
    .argument('[jobId]', 'only steps of this job')
    .option('--run <runId>', 'only steps of this workflow run')
    .option('--conclusion <conclusion>', 'success, failure, cancelled, skipped, ...');

  return addListOptions(command).action(
    (jobId: string | undefined, options: Record<string, unknown>, self: Command) => {
      const ctx = openReadContext(self);
      try {
        const rows = gh.listWorkflowSteps(ctx.db, {
          jobId: jobId !== undefined ? Number(jobId) : undefined,
          runId: options['run'] !== undefined ? Number(options['run']) : undefined,
          conclusion: options['conclusion'] as string | undefined,
          search: options['search'] as string | undefined,
          limit: parseLimit(options['limit'] as string | undefined),
          offset: readOffset(options),
        });

        const columns: Column<gh.WorkflowStepRow>[] = [
          { header: 'JOB', value: (row) => row.job_id, align: 'right' },
          { header: '#', value: (row) => row.number, align: 'right' },
          { header: 'NAME', value: (row) => truncate(row.name, 50) },
          { header: 'STATUS', value: (row) => row.status },
          { header: 'CONCLUSION', value: (row) => row.conclusion },
          {
            header: 'DURATION',
            value: (row) => (row.duration_ms === null ? '' : formatDuration(row.duration_ms)),
            align: 'right',
          },
        ];

        printOutput(
          renderTable(rows, columns, {
            format: ctx.format,
            list: ctx.list,
            listValue: (row) => `${row.job_id}:${row.number}`,
            title: 'Workflow steps',
            emptyMessage: 'No workflow steps match these filters.',
          }),
        );
      } finally {
        ctx.close();
      }
    },
  );
}

function logsCommand(): Command {
  const command = new Command('logs')
    .alias('log')
    .description('print the stored log of a workflow job')
    .argument('<jobId>', 'workflow job id');

  return addOutputOptions(command).action((jobId: string, _options: unknown, self: Command) => {
    const ctx = openReadContext(self);
    try {
      const log = gh.getJobLog(ctx.db, Number(jobId));
      if (!log || log.content === null) {
        throw new CliError(`No log stored for job ${jobId}.`, {
          hint: 'Enable "workflowLogs: true" for the repository and sync again.',
        });
      }
      if (ctx.format === 'json') {
        printOutput(JSON.stringify({ jobId: Number(jobId), ...log }, null, 2));
        return;
      }
      if (ctx.format === 'markdown') {
        printOutput(`## Job ${jobId} log\n\n\`\`\`\n${log.content}\n\`\`\``);
        return;
      }
      printOutput(log.content);
      if (log.truncated) ctx.logger.warn('The stored log was truncated by maxLogBytes.');
    } finally {
      ctx.close();
    }
  });
}

function findIssue(
  db: ReturnType<typeof openReadContext>['db'],
  repos: string[],
  number: number,
): gh.IssueRow {
  const candidates = gh.listIssues(db, {
    repos: repos.length > 0 ? repos : undefined,
    state: 'all',
    numbers: [number],
  });
  const [issue, ...rest] = candidates;
  if (!issue) {
    throw new CliError(`No issue #${number} in the database.`, {
      hint: repos.length === 0 ? 'Pass --repo owner/name to narrow the search.' : undefined,
    });
  }
  if (rest.length > 0) {
    throw new CliError(
      `Issue #${number} exists in several repositories (${[issue, ...rest]
        .map((row) => row.repo_full_name)
        .join(', ')}).`,
      { hint: 'Pass --repo owner/name.' },
    );
  }
  return issue;
}

function findPullRequest(
  db: ReturnType<typeof openReadContext>['db'],
  repos: string[],
  number: number,
): gh.PullRequestRow {
  const candidates = gh.listPullRequests(db, {
    repos: repos.length > 0 ? repos : undefined,
    state: 'all',
    numbers: [number],
  });
  const [pr, ...rest] = candidates;
  if (!pr) {
    throw new CliError(`No pull request #${number} in the database.`, {
      hint: repos.length === 0 ? 'Pass --repo owner/name to narrow the search.' : undefined,
    });
  }
  if (rest.length > 0) {
    throw new CliError(
      `Pull request #${number} exists in several repositories (${[pr, ...rest]
        .map((row) => row.repo_full_name)
        .join(', ')}).`,
      { hint: 'Pass --repo owner/name.' },
    );
  }
  return pr;
}
