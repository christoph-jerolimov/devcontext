/** Typed access to the JSON API that `devcontext web` serves. */

export interface StatusResponse {
  config: {
    path: string;
    database: string;
    projects: Array<{
      key: string;
      name: string;
      description: string | null;
      github: string[];
      jira: string[];
    }>;
  };
  github: Record<string, number>;
  jira: Record<string, number>;
  runs: SyncRun[];
  state: SyncState[];
}

export interface SyncRun {
  id: number;
  project_key: string | null;
  source: string;
  target: string;
  mode: string;
  status: string;
  started_at: string;
  duration_ms: number | null;
  api_calls: number;
  items_synced: number;
  error: string | null;
}

export interface SyncState {
  scope: string;
  cursor: string | null;
  updated_at: string;
}

export interface Repository {
  full_name: string;
  description: string | null;
  default_branch: string | null;
  open_issues: number | null;
  stars: number | null;
  pushed_at: string | null;
  synced_at: string;
}

export interface Issue {
  repo_full_name: string;
  number: number;
  title: string | null;
  state: string | null;
  author: string | null;
  labels: string | null;
  comment_count: number | null;
  created_at: string | null;
  updated_at: string | null;
  html_url: string | null;
}

export interface PullRequest extends Issue {
  merged: number;
  draft: number;
  head_ref: string | null;
  base_ref: string | null;
  additions: number | null;
  deletions: number | null;
  merged_at: string | null;
}

export interface WorkflowRun {
  id: number;
  repo_full_name: string;
  workflow_name: string | null;
  run_number: number | null;
  event: string | null;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  actor: string | null;
  created_at: string | null;
  html_url: string | null;
}

export interface Workitem {
  key: string;
  project_key: string;
  summary: string | null;
  type: string | null;
  status: string | null;
  status_category: string | null;
  assignee: string | null;
  story_points: number | null;
  sprint_name: string | null;
  labels: string | null;
  updated_at: string | null;
  url: string | null;
}

export interface Sprint {
  id: number;
  name: string | null;
  state: string | null;
  goal: string | null;
  start_date: string | null;
  end_date: string | null;
  workitem_count?: number;
}

export interface IssueDocument {
  kind: string;
  repository?: string;
  number?: number;
  key?: string;
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  description?: string | null;
  url?: string | null;
  [key: string]: unknown;
}

export interface Distribution {
  count: number;
  p50: number | null;
  p85: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  average: number | null;
  total: number;
}

export interface InsightsResponse {
  cycleTime: {
    overall: Distribution;
    byType: Array<{ type: string; distribution: Distribution }>;
    items: Array<{ key: string; summary: string | null; hours: number }>;
    withoutStart: number;
  };
  reviewLatency: {
    toFirstReview: Distribution;
    toMerge: Distribution;
    mergedWithoutReview: number;
    byReviewer: Array<{ reviewer: string; reviews: number; medianResponseHours: number | null }>;
  };
  wip: {
    workitems: number;
    openPullRequests: number;
    draftPullRequests: number;
    openIssues: number;
    byAssignee: Array<{
      assignee: string;
      workitems: number;
      pullRequests: number;
      oldestHours: number | null;
    }>;
  };
  stale: {
    threshold: string;
    items: Array<{
      kind: string;
      ref: string;
      title: string | null;
      owner: string | null;
      updatedAt: string | null;
    }>;
  };
  flaky: {
    minRuns: number;
    steps: Array<{
      workflow: string | null;
      job: string | null;
      step: string | null;
      runs: number;
      failures: number;
      failureRate: number | null;
      retriedGreen: number;
    }>;
  };
}

export interface DigestEntry {
  ref: string;
  title: string | null;
  who: string | null;
  at: string | null;
  url: string | null;
  detail?: string;
}

export interface DigestResponse {
  since: string;
  until: string;
  github: {
    pullRequestsOpened: DigestEntry[];
    pullRequestsMerged: DigestEntry[];
    issuesOpened: DigestEntry[];
    issuesClosed: DigestEntry[];
    reviews: number;
    comments: number;
    failedRuns: DigestEntry[];
  };
  jira: {
    created: DigestEntry[];
    started: DigestEntry[];
    finished: DigestEntry[];
    comments: number;
  };
  people: Array<{
    person: string;
    pullRequestsOpened: number;
    pullRequestsMerged: number;
    reviews: number;
    issuesClosed: number;
    workitemsFinished: number;
    comments: number;
    total: number;
  }>;
  inFlight: { workitems: number; pullRequests: number; drafts: number };
  stale: Array<{
    kind: string;
    ref: string;
    title: string | null;
    owner: string | null;
    updatedAt: string | null;
  }>;
  quiet: boolean;
}

export interface SearchHit {
  ref: string;
  kind: 'issue' | 'pull-request' | 'workitem';
  source: 'github' | 'jira';
  container: string;
  state: string | null;
  title: string | null;
  updatedAt: string | null;
  url: string | null;
  snippet: string | null;
  score: number | null;
}

export class ApiError extends Error {}

async function request<T>(
  path: string,
  params: Record<string, string | undefined> = {},
): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Request failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  status: () => request<StatusResponse>('/api/status'),
  repos: () => request<Repository[]>('/api/github/repos'),
  issues: (params: Record<string, string | undefined>) =>
    request<Issue[]>('/api/github/issues', params),
  issue: (repo: string, number: number) =>
    request<IssueDocument>(`/api/github/issues/${repo}/${number}`),
  pulls: (params: Record<string, string | undefined>) =>
    request<PullRequest[]>('/api/github/pulls', params),
  pull: (repo: string, number: number) =>
    request<IssueDocument>(`/api/github/pulls/${repo}/${number}`),
  workflowRuns: (params: Record<string, string | undefined>) =>
    request<WorkflowRun[]>('/api/github/runs', params),
  workflowRun: (id: number) => request<IssueDocument>(`/api/github/runs/${id}`),
  workitems: (params: Record<string, string | undefined>) =>
    request<Workitem[]>('/api/jira/workitems', params),
  workitem: (key: string) => request<IssueDocument>(`/api/jira/workitems/${key}`),
  sprints: (params: Record<string, string | undefined>) =>
    request<Sprint[]>('/api/jira/sprints', params),
  sprint: (id: number) => request<IssueDocument>(`/api/jira/sprints/${id}`),
  insights: (params: Record<string, string | undefined>) =>
    request<InsightsResponse>('/api/insights', params),
  digest: (params: Record<string, string | undefined>) =>
    request<DigestResponse>('/api/digest', params),
  search: (params: Record<string, string | undefined>) =>
    request<SearchHit[]>('/api/search', params),
};

export function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return String(value);
  const diff = Date.now() - then;
  const units: Array<[number, string]> = [
    [31_536_000_000, 'y'],
    [2_592_000_000, 'mo'],
    [604_800_000, 'w'],
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
  ];
  for (const [ms, suffix] of units) {
    if (Math.abs(diff) >= ms) {
      const amount = Math.floor(Math.abs(diff) / ms);
      return diff >= 0 ? `${amount}${suffix} ago` : `in ${amount}${suffix}`;
    }
  }
  return 'just now';
}
