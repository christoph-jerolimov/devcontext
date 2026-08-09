import type { BindValue } from '../../db/database.js';
import { arr, bool, num, obj, str, strList } from '../../util/json.js';
import type { JsonObject } from '../../util/json.js';

export type Row = Record<string, BindValue>;

export interface RepoRef {
  host: string;
  repoId: number;
  fullName: string;
}

const json = (value: unknown): string => JSON.stringify(value ?? null);

export function mapRepository(raw: JsonObject, host: string, syncedAt: string): Row {
  return {
    host,
    id: num(raw, 'id') ?? 0,
    node_id: str(raw, 'node_id'),
    owner: str(raw, 'owner', 'login'),
    name: str(raw, 'name'),
    full_name: str(raw, 'full_name'),
    private: bool(raw, 'private') ?? false,
    fork: bool(raw, 'fork') ?? false,
    archived: bool(raw, 'archived') ?? false,
    description: str(raw, 'description'),
    homepage: str(raw, 'homepage'),
    language: str(raw, 'language'),
    default_branch: str(raw, 'default_branch'),
    visibility: str(raw, 'visibility'),
    stars: num(raw, 'stargazers_count'),
    forks: num(raw, 'forks_count'),
    open_issues: num(raw, 'open_issues_count'),
    html_url: str(raw, 'html_url'),
    created_at: str(raw, 'created_at'),
    updated_at: str(raw, 'updated_at'),
    pushed_at: str(raw, 'pushed_at'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function mapUser(raw: JsonObject, host: string, syncedAt: string): Row | null {
  const id = num(raw, 'id');
  const login = str(raw, 'login');
  if (id === null || login === null) return null;
  return {
    host,
    id,
    login,
    name: str(raw, 'name'),
    type: str(raw, 'type'),
    site_admin: bool(raw, 'site_admin') ?? false,
    avatar_url: str(raw, 'avatar_url'),
    html_url: str(raw, 'html_url'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function mapLabel(raw: JsonObject, ref: RepoRef, syncedAt: string): Row {
  return {
    host: ref.host,
    id: num(raw, 'id') ?? 0,
    repo_id: ref.repoId,
    name: str(raw, 'name'),
    color: str(raw, 'color'),
    description: str(raw, 'description'),
    is_default: bool(raw, 'default') ?? false,
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function mapMilestone(raw: JsonObject, ref: RepoRef, syncedAt: string): Row {
  return {
    host: ref.host,
    id: num(raw, 'id') ?? 0,
    repo_id: ref.repoId,
    number: num(raw, 'number'),
    title: str(raw, 'title'),
    description: str(raw, 'description'),
    state: str(raw, 'state'),
    open_issues: num(raw, 'open_issues'),
    closed_issues: num(raw, 'closed_issues'),
    created_at: str(raw, 'created_at'),
    updated_at: str(raw, 'updated_at'),
    due_on: str(raw, 'due_on'),
    closed_at: str(raw, 'closed_at'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function isPullRequest(raw: JsonObject): boolean {
  return obj(raw, 'pull_request') !== null;
}

export function mapIssue(raw: JsonObject, ref: RepoRef, syncedAt: string): Row {
  const labels = strList(raw, ['labels'], 'name');
  const assignees = strList(raw, ['assignees'], 'login');
  return {
    host: ref.host,
    id: num(raw, 'id') ?? 0,
    repo_id: ref.repoId,
    repo_full_name: ref.fullName,
    number: num(raw, 'number') ?? 0,
    node_id: str(raw, 'node_id'),
    title: str(raw, 'title'),
    body: str(raw, 'body'),
    state: str(raw, 'state'),
    state_reason: str(raw, 'state_reason'),
    locked: bool(raw, 'locked') ?? false,
    author: str(raw, 'user', 'login'),
    author_association: str(raw, 'author_association'),
    assignees: json(assignees),
    labels: json(labels),
    milestone: str(raw, 'milestone', 'title'),
    comment_count: num(raw, 'comments'),
    reactions: json(obj(raw, 'reactions')),
    is_pull_request: isPullRequest(raw),
    created_at: str(raw, 'created_at'),
    updated_at: str(raw, 'updated_at'),
    closed_at: str(raw, 'closed_at'),
    closed_by: str(raw, 'closed_by', 'login'),
    html_url: str(raw, 'html_url'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function issueLabelRows(raw: JsonObject, host: string): Row[] {
  const issueId = num(raw, 'id') ?? 0;
  return strList(raw, ['labels'], 'name').map((label) => ({
    host,
    issue_id: issueId,
    label_name: label,
  }));
}

export function issueAssigneeRows(raw: JsonObject, host: string): Row[] {
  const issueId = num(raw, 'id') ?? 0;
  return strList(raw, ['assignees'], 'login').map((login) => ({
    host,
    issue_id: issueId,
    login,
  }));
}

export function mapComment(
  raw: JsonObject,
  ref: RepoRef,
  issue: { id: number; number: number },
  syncedAt: string,
): Row {
  return {
    host: ref.host,
    id: num(raw, 'id') ?? 0,
    repo_id: ref.repoId,
    repo_full_name: ref.fullName,
    issue_id: issue.id,
    issue_number: issue.number,
    author: str(raw, 'user', 'login'),
    body: str(raw, 'body'),
    reactions: json(obj(raw, 'reactions')),
    created_at: str(raw, 'created_at'),
    updated_at: str(raw, 'updated_at'),
    html_url: str(raw, 'html_url'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

/**
 * Timeline entries have wildly different shapes. Everything is kept in `raw`;
 * the columns lift out what most queries need (who did what, when, to which
 * label / assignee / title).
 */
export function mapTimelineEvent(
  raw: JsonObject,
  ref: RepoRef,
  issue: { id: number; number: number },
  index: number,
  syncedAt: string,
): Row {
  const event = str(raw, 'event') ?? 'unknown';
  const id = num(raw, 'id');
  const createdAt =
    str(raw, 'created_at') ??
    str(raw, 'submitted_at') ??
    str(raw, 'committer', 'date') ??
    str(raw, 'author', 'date');

  const uid = id !== null ? String(id) : `${issue.id}:${event}:${createdAt ?? 'unknown'}:${index}`;

  return {
    host: ref.host,
    uid,
    id,
    node_id: str(raw, 'node_id'),
    repo_id: ref.repoId,
    repo_full_name: ref.fullName,
    issue_id: issue.id,
    issue_number: issue.number,
    event,
    actor:
      str(raw, 'actor', 'login') ??
      str(raw, 'user', 'login') ??
      str(raw, 'author', 'name') ??
      str(raw, 'committer', 'name'),
    created_at: createdAt,
    label: str(raw, 'label', 'name'),
    assignee: str(raw, 'assignee', 'login'),
    milestone: str(raw, 'milestone', 'title'),
    from_value: str(raw, 'rename', 'from') ?? str(raw, 'source', 'type'),
    to_value: str(raw, 'rename', 'to') ?? str(raw, 'state_reason'),
    commit_sha: str(raw, 'commit_id') ?? str(raw, 'sha'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function mapPullRequest(raw: JsonObject, ref: RepoRef, syncedAt: string): Row {
  return {
    host: ref.host,
    id: num(raw, 'id') ?? 0,
    repo_id: ref.repoId,
    repo_full_name: ref.fullName,
    number: num(raw, 'number') ?? 0,
    node_id: str(raw, 'node_id'),
    title: str(raw, 'title'),
    body: str(raw, 'body'),
    state: str(raw, 'state'),
    draft: bool(raw, 'draft') ?? false,
    merged: bool(raw, 'merged') ?? str(raw, 'merged_at') !== null,
    mergeable: str(raw, 'mergeable'),
    mergeable_state: str(raw, 'mergeable_state'),
    author: str(raw, 'user', 'login'),
    assignees: json(strList(raw, ['assignees'], 'login')),
    requested_reviewers: json(strList(raw, ['requested_reviewers'], 'login')),
    labels: json(strList(raw, ['labels'], 'name')),
    milestone: str(raw, 'milestone', 'title'),
    head_ref: str(raw, 'head', 'ref'),
    head_sha: str(raw, 'head', 'sha'),
    head_repo: str(raw, 'head', 'repo', 'full_name'),
    base_ref: str(raw, 'base', 'ref'),
    base_sha: str(raw, 'base', 'sha'),
    merge_commit_sha: str(raw, 'merge_commit_sha'),
    additions: num(raw, 'additions'),
    deletions: num(raw, 'deletions'),
    changed_files: num(raw, 'changed_files'),
    commit_count: num(raw, 'commits'),
    comment_count: num(raw, 'comments'),
    review_comment_count: num(raw, 'review_comments'),
    created_at: str(raw, 'created_at'),
    updated_at: str(raw, 'updated_at'),
    closed_at: str(raw, 'closed_at'),
    merged_at: str(raw, 'merged_at'),
    merged_by: str(raw, 'merged_by', 'login'),
    html_url: str(raw, 'html_url'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function mapReview(
  raw: JsonObject,
  ref: RepoRef,
  pr: { id: number; number: number },
  syncedAt: string,
): Row {
  return {
    host: ref.host,
    id: num(raw, 'id') ?? 0,
    repo_id: ref.repoId,
    repo_full_name: ref.fullName,
    pr_id: pr.id,
    pr_number: pr.number,
    author: str(raw, 'user', 'login'),
    state: str(raw, 'state'),
    body: str(raw, 'body'),
    commit_id: str(raw, 'commit_id'),
    submitted_at: str(raw, 'submitted_at'),
    html_url: str(raw, 'html_url'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function mapReviewComment(
  raw: JsonObject,
  ref: RepoRef,
  pr: { id: number; number: number },
  syncedAt: string,
): Row {
  return {
    host: ref.host,
    id: num(raw, 'id') ?? 0,
    repo_id: ref.repoId,
    repo_full_name: ref.fullName,
    pr_id: pr.id,
    pr_number: pr.number,
    review_id: num(raw, 'pull_request_review_id'),
    in_reply_to_id: num(raw, 'in_reply_to_id'),
    author: str(raw, 'user', 'login'),
    body: str(raw, 'body'),
    path: str(raw, 'path'),
    diff_hunk: str(raw, 'diff_hunk'),
    line: num(raw, 'line'),
    original_line: num(raw, 'original_line'),
    start_line: num(raw, 'start_line'),
    side: str(raw, 'side'),
    commit_id: str(raw, 'commit_id'),
    created_at: str(raw, 'created_at'),
    updated_at: str(raw, 'updated_at'),
    html_url: str(raw, 'html_url'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function mapCommit(
  raw: JsonObject,
  ref: RepoRef,
  pr: { id: number; number: number } | null,
  syncedAt: string,
): Row {
  return {
    host: ref.host,
    repo_id: ref.repoId,
    repo_full_name: ref.fullName,
    sha: str(raw, 'sha') ?? '',
    pr_id: pr?.id ?? 0,
    pr_number: pr?.number ?? null,
    message: str(raw, 'commit', 'message'),
    author_name: str(raw, 'commit', 'author', 'name'),
    author_email: str(raw, 'commit', 'author', 'email'),
    author_login: str(raw, 'author', 'login'),
    authored_at: str(raw, 'commit', 'author', 'date'),
    committer_name: str(raw, 'commit', 'committer', 'name'),
    committed_at: str(raw, 'commit', 'committer', 'date'),
    parents: json(arr(raw, 'parents').map((parent) => str(parent, 'sha'))),
    html_url: str(raw, 'html_url'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function mapPullRequestFile(
  raw: JsonObject,
  ref: RepoRef,
  pr: { id: number },
  syncedAt: string,
): Row {
  return {
    host: ref.host,
    repo_id: ref.repoId,
    pr_id: pr.id,
    filename: str(raw, 'filename') ?? '',
    status: str(raw, 'status'),
    additions: num(raw, 'additions'),
    deletions: num(raw, 'deletions'),
    changes: num(raw, 'changes'),
    previous_filename: str(raw, 'previous_filename'),
    patch: str(raw, 'patch'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function mapWorkflow(raw: JsonObject, ref: RepoRef, syncedAt: string): Row {
  return {
    host: ref.host,
    id: num(raw, 'id') ?? 0,
    repo_id: ref.repoId,
    repo_full_name: ref.fullName,
    name: str(raw, 'name'),
    path: str(raw, 'path'),
    state: str(raw, 'state'),
    created_at: str(raw, 'created_at'),
    updated_at: str(raw, 'updated_at'),
    html_url: str(raw, 'html_url'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function mapWorkflowRun(raw: JsonObject, ref: RepoRef, syncedAt: string): Row {
  return {
    host: ref.host,
    id: num(raw, 'id') ?? 0,
    repo_id: ref.repoId,
    repo_full_name: ref.fullName,
    workflow_id: num(raw, 'workflow_id'),
    workflow_name: str(raw, 'name'),
    name: str(raw, 'display_title') ?? str(raw, 'name'),
    run_number: num(raw, 'run_number'),
    run_attempt: num(raw, 'run_attempt'),
    event: str(raw, 'event'),
    status: str(raw, 'status'),
    conclusion: str(raw, 'conclusion'),
    head_branch: str(raw, 'head_branch'),
    head_sha: str(raw, 'head_sha'),
    actor: str(raw, 'actor', 'login'),
    triggering_actor: str(raw, 'triggering_actor', 'login'),
    pr_numbers: json(arr(raw, 'pull_requests').map((pr) => num(pr, 'number'))),
    created_at: str(raw, 'created_at'),
    updated_at: str(raw, 'updated_at'),
    run_started_at: str(raw, 'run_started_at'),
    html_url: str(raw, 'html_url'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function mapWorkflowJob(raw: JsonObject, ref: RepoRef, syncedAt: string): Row {
  const startedAt = str(raw, 'started_at');
  const completedAt = str(raw, 'completed_at');
  return {
    host: ref.host,
    id: num(raw, 'id') ?? 0,
    repo_id: ref.repoId,
    repo_full_name: ref.fullName,
    run_id: num(raw, 'run_id') ?? 0,
    run_attempt: num(raw, 'run_attempt'),
    name: str(raw, 'name'),
    status: str(raw, 'status'),
    conclusion: str(raw, 'conclusion'),
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs(startedAt, completedAt),
    runner_name: str(raw, 'runner_name'),
    runner_group: str(raw, 'runner_group_name'),
    labels: json(arr(raw, 'labels')),
    html_url: str(raw, 'html_url'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function mapWorkflowSteps(job: JsonObject, host: string, syncedAt: string): Row[] {
  const jobId = num(job, 'id') ?? 0;
  const runId = num(job, 'run_id');
  return arr(job, 'steps').map((step, index) => {
    const startedAt = str(step, 'started_at');
    const completedAt = str(step, 'completed_at');
    return {
      host,
      job_id: jobId,
      number: num(step, 'number') ?? index + 1,
      run_id: runId,
      name: str(step, 'name'),
      status: str(step, 'status'),
      conclusion: str(step, 'conclusion'),
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs(startedAt, completedAt),
      synced_at: syncedAt,
      raw: json(step),
    };
  });
}

function durationMs(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end - start;
}
