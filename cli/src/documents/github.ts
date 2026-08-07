import type { Database } from '../db/database.js';
import { parseJsonColumn } from '../db/database.js';
import * as gh from '../db/queries/github.js';
import type { Document } from '../output/document.js';
import { formatRelative } from '../util/time.js';

const list = (value: string | null): string[] => parseJsonColumn<string[]>(value, []);

/** Everything devcontext knows about one issue, ready to render or export. */
export function buildIssueDocument(db: Database, issue: gh.IssueRow): Document {
  const comments = gh.listComments(db, issue.repo_full_name, issue.number);
  const events = gh.listEvents(db, issue.repo_full_name, issue.number);

  const data = {
    kind: 'github-issue',
    repository: issue.repo_full_name,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    stateReason: issue.state_reason,
    author: issue.author,
    assignees: list(issue.assignees),
    labels: list(issue.labels),
    milestone: issue.milestone,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    url: issue.html_url,
    body: issue.body,
    comments: comments.map((comment) => ({
      id: comment.id,
      author: comment.author,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      body: comment.body,
    })),
    events: events.map((event) => ({
      id: event.uid,
      event: event.event,
      actor: event.actor,
      createdAt: event.created_at,
      label: event.label,
      assignee: event.assignee,
      milestone: event.milestone,
      from: event.from_value,
      to: event.to_value,
      commit: event.commit_sha,
    })),
  };

  return {
    title: `${issue.repo_full_name}#${issue.number} ${issue.title ?? ''}`.trim(),
    subtitle: `${issue.state ?? 'unknown'}${issue.state_reason ? ` (${issue.state_reason})` : ''}`,
    url: issue.html_url,
    meta: [
      ['Author', issue.author],
      ['Assignees', list(issue.assignees).join(', ')],
      ['Labels', list(issue.labels).join(', ')],
      ['Milestone', issue.milestone],
      ['Created', formatTimestamp(issue.created_at)],
      ['Updated', formatTimestamp(issue.updated_at)],
      ['Closed', formatTimestamp(issue.closed_at)],
      ['Comments', comments.length],
    ],
    body: issue.body,
    sections: [
      {
        heading: `Comments (${comments.length})`,
        entries: comments.map((comment) => ({
          title: comment.author ?? 'unknown',
          meta: formatTimestamp(comment.created_at),
          body: comment.body,
        })),
      },
      {
        heading: `Timeline (${events.length})`,
        table: {
          columns: ['When', 'Actor', 'Event', 'Detail'],
          rows: events.map((event) => [
            formatTimestamp(event.created_at),
            event.actor ?? '',
            event.event,
            describeEvent(event),
          ]),
        },
      },
    ],
    data,
  };
}

/** Everything devcontext knows about one pull request. */
export function buildPullRequestDocument(db: Database, pr: gh.PullRequestRow): Document {
  const comments = gh.listComments(db, pr.repo_full_name, pr.number);
  const events = gh.listEvents(db, pr.repo_full_name, pr.number);
  const reviews = gh.listReviews(db, pr.repo_full_name, pr.number);
  const reviewComments = gh.listReviewComments(db, pr.repo_full_name, pr.number);
  const commits = gh.listCommits(db, pr.repo_full_name, pr.number);
  const files = gh.listChangedFiles(db, pr.repo_full_name, pr.number);

  const data = {
    kind: 'github-pull-request',
    repository: pr.repo_full_name,
    number: pr.number,
    title: pr.title,
    state: pr.merged ? 'merged' : pr.state,
    draft: Boolean(pr.draft),
    author: pr.author,
    assignees: list(pr.assignees),
    labels: list(pr.labels),
    head: pr.head_ref,
    base: pr.base_ref,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    closedAt: pr.closed_at,
    mergedAt: pr.merged_at,
    mergedBy: pr.merged_by,
    url: pr.html_url,
    body: pr.body,
    commits: commits.map((commit) => ({
      sha: commit.sha,
      message: commit.message,
      author: commit.author_login ?? commit.author_name,
      committedAt: commit.committed_at,
    })),
    files,
    reviews: reviews.map((review) => ({
      id: review.id,
      author: review.author,
      state: review.state,
      submittedAt: review.submitted_at,
      body: review.body,
      comments: reviewComments
        .filter((comment) => comment.review_id === review.id)
        .map((comment) => ({
          id: comment.id,
          author: comment.author,
          path: comment.path,
          line: comment.line,
          createdAt: comment.created_at,
          body: comment.body,
          diffHunk: comment.diff_hunk,
        })),
    })),
    comments: comments.map((comment) => ({
      id: comment.id,
      author: comment.author,
      createdAt: comment.created_at,
      body: comment.body,
    })),
    events: events.map((event) => ({
      id: event.uid,
      event: event.event,
      actor: event.actor,
      createdAt: event.created_at,
      label: event.label,
      commit: event.commit_sha,
    })),
  };

  return {
    title: `${pr.repo_full_name}#${pr.number} ${pr.title ?? ''}`.trim(),
    subtitle: `${pr.merged ? 'merged' : (pr.state ?? 'unknown')}${pr.draft ? ' · draft' : ''}`,
    url: pr.html_url,
    meta: [
      ['Author', pr.author],
      ['Branch', pr.head_ref && pr.base_ref ? `${pr.head_ref} → ${pr.base_ref}` : null],
      ['Labels', list(pr.labels).join(', ')],
      [
        'Changes',
        `+${pr.additions ?? 0} -${pr.deletions ?? 0} in ${pr.changed_files ?? 0} file(s)`,
      ],
      ['Commits', commits.length],
      ['Reviews', reviews.length],
      ['Created', formatTimestamp(pr.created_at)],
      ['Updated', formatTimestamp(pr.updated_at)],
      ['Merged', formatTimestamp(pr.merged_at)],
    ],
    body: pr.body,
    sections: [
      {
        heading: `Commits (${commits.length})`,
        table: {
          columns: ['SHA', 'When', 'Author', 'Message'],
          rows: commits.map((commit) => [
            commit.sha.slice(0, 8),
            formatTimestamp(commit.committed_at),
            commit.author_login ?? commit.author_name ?? '',
            firstLine(commit.message),
          ]),
        },
      },
      {
        heading: `Changed files (${files.length})`,
        table: {
          columns: ['File', 'Status', '+', '-'],
          rows: files.map((file) => [file.filename, file.status, file.additions, file.deletions]),
        },
      },
      {
        heading: `Reviews (${reviews.length})`,
        entries: reviews.map((review) => ({
          title: `${review.author ?? 'unknown'} — ${review.state ?? ''}`,
          meta: formatTimestamp(review.submitted_at),
          body: [
            review.body,
            ...reviewComments
              .filter((comment) => comment.review_id === review.id)
              .map(
                (comment) =>
                  `- \`${comment.path ?? ''}${comment.line ? `:${comment.line}` : ''}\` ${comment.body ?? ''}`,
              ),
          ]
            .filter(Boolean)
            .join('\n\n'),
        })),
      },
      {
        heading: `Comments (${comments.length})`,
        entries: comments.map((comment) => ({
          title: comment.author ?? 'unknown',
          meta: formatTimestamp(comment.created_at),
          body: comment.body,
        })),
      },
      {
        heading: `Timeline (${events.length})`,
        table: {
          columns: ['When', 'Actor', 'Event', 'Detail'],
          rows: events.map((event) => [
            formatTimestamp(event.created_at),
            event.actor ?? '',
            event.event,
            describeEvent(event),
          ]),
        },
      },
    ],
    data,
  };
}

/** One workflow run with its jobs and steps. */
export function buildWorkflowRunDocument(db: Database, run: gh.WorkflowRunRow): Document {
  const jobs = gh.listWorkflowJobs(db, { runId: run.id });
  const jobDocuments = jobs.map((job) => ({
    job,
    steps: gh.listWorkflowSteps(db, { jobId: job.id }),
  }));

  return {
    title: `${run.repo_full_name} · ${run.workflow_name ?? run.name ?? 'workflow'} #${run.run_number ?? run.id}`,
    subtitle: `${run.status ?? ''}${run.conclusion ? ` / ${run.conclusion}` : ''}`,
    url: run.html_url,
    meta: [
      ['Event', run.event],
      ['Branch', run.head_branch],
      ['Commit', run.head_sha?.slice(0, 8)],
      ['Actor', run.actor],
      ['Attempt', run.run_attempt],
      ['Created', formatTimestamp(run.created_at)],
      ['Updated', formatTimestamp(run.updated_at)],
      ['Jobs', jobs.length],
    ],
    sections: jobDocuments.map(({ job, steps }) => ({
      heading: `Job: ${job.name ?? job.id} (${job.conclusion ?? job.status ?? 'unknown'})`,
      table: {
        columns: ['#', 'Step', 'Status', 'Conclusion', 'Duration'],
        rows: steps.map((step) => [
          step.number,
          step.name,
          step.status,
          step.conclusion,
          step.duration_ms !== null ? `${Math.round(step.duration_ms / 1000)}s` : '',
        ]),
      },
    })),
    data: {
      kind: 'github-workflow-run',
      repository: run.repo_full_name,
      id: run.id,
      workflow: run.workflow_name,
      runNumber: run.run_number,
      runAttempt: run.run_attempt,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      branch: run.head_branch,
      sha: run.head_sha,
      actor: run.actor,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      url: run.html_url,
      jobs: jobDocuments.map(({ job, steps }) => ({
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        durationMs: job.duration_ms,
        runner: job.runner_name,
        steps: steps.map((step) => ({
          number: step.number,
          name: step.name,
          status: step.status,
          conclusion: step.conclusion,
          startedAt: step.started_at,
          completedAt: step.completed_at,
          durationMs: step.duration_ms,
        })),
      })),
    },
  };
}

export function describeEvent(event: gh.EventRow): string {
  const parts: string[] = [];
  if (event.label) parts.push(`label: ${event.label}`);
  if (event.assignee) parts.push(`assignee: ${event.assignee}`);
  if (event.milestone) parts.push(`milestone: ${event.milestone}`);
  if (event.from_value) parts.push(`from: ${event.from_value}`);
  if (event.to_value) parts.push(`to: ${event.to_value}`);
  if (event.commit_sha) parts.push(`commit: ${event.commit_sha.slice(0, 8)}`);
  return parts.join(', ');
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '';
  return `${value.slice(0, 16).replace('T', ' ')} (${formatRelative(value)})`;
}

function firstLine(value: string | null | undefined): string {
  return (value ?? '').split('\n')[0] ?? '';
}
