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
  /** The same totals per repository and per project. */
  githubByRepository: Array<{ repository: string } & Record<string, number>>;
  jiraByProject: Array<{ project: string } & Record<string, number>>;
  /** Choices the server defines, so the viewer does not restate them. */
  filters: {
    workitemTypes: string[];
    /** The repositories and Jira projects that actually have rows. */
    containers: { github: string[]; jira: string[] };
    /** Configured people and bots; empty when devcontext.yaml names none. */
    people: PersonOption[];
    teams: TeamOption[];
  };
  runs: SyncRun[];
  state: SyncState[];
}

/** One thing that happened: a status change, a comment or a review. */
export interface ActivityEvent {
  source: 'github' | 'jira';
  kind: 'status' | 'comment' | 'review';
  /** `opened`, `closed`, `merged`, `commented`, `approved`, ... */
  action: string;
  ref: string;
  container: string;
  title: string | null;
  /** The login or display name as stored. */
  actor: string | null;
  at: string;
  detail: string | null;
  url: string | null;
  /** Resolved by the server; null when nobody has mapped this identity. */
  person: PersonOption | null;
}

export interface ActivityResponse {
  events: ActivityEvent[];
  /** Everything the filters match, which the page usually is not. */
  total: number;
  kinds: string[];
}

export interface BurndownDay {
  day: string;
  inSprint: number;
  remaining: number;
  done: number;
  remainingPoints: number;
  donePoints: number;
  added: number;
  removed: number;
  /** Null when the sprint has no dates to draw an ideal line between. */
  ideal: number | null;
  idealPoints: number | null;
  /** False once the day is in the future; the actual series stops there. */
  actual: boolean;
}

export interface BurndownResponse {
  kind: 'burndown';
  sprint: {
    id: number;
    name: string | null;
    state: string | null;
    startDate: string | null;
    endDate: string | null;
    completeDate: string | null;
    goal: string | null;
  };
  committed: { items: number; points: number };
  finalScope: { items: number; points: number };
  completed: { items: number; points: number };
  scope: {
    added: number;
    removed: number;
    changes: Array<{ key: string; at: string; direction: 'added' | 'removed'; points: number }>;
  };
  days: BurndownDay[];
  /** False when nothing in the sprint carries an estimate. */
  hasPoints: boolean;
  /** False on a database whose state history predates the points dimension. */
  pointsAreHistorical: boolean;
}

export interface VelocityResponse {
  kind: 'velocity';
  sprints: Array<{
    id: number;
    name: string | null;
    state: string | null;
    startDate: string | null;
    endDate: string | null;
    committed: { items: number; points: number };
    completed: { items: number; points: number };
    added: number;
    removed: number;
    ratio: number | null;
  }>;
  average: { items: number; points: number };
  hasPoints: boolean;
  pointsAreHistorical: boolean;
}

/** How long work sits in each status, from the state history. */
export interface StatusTimesResponse {
  kind: 'status-time';
  statuses: Array<{
    status: string;
    category: string | null;
    stays: number;
    hours: { count: number; p50: number | null; p85: number | null; max: number | null };
  }>;
  /** Stays that had not ended; excluded from the numbers rather than guessed at. */
  ongoing: number;
}

/** Somebody who touched an item, and what they did to it. */
export interface Contributor {
  /** The configured person's name where there is one, else the raw identity. */
  name: string;
  roles: string[];
  events: number;
}

export interface PersonOption {
  id: string;
  name: string;
  kind: 'person' | 'bot';
}

export interface TeamOption {
  id: string;
  name: string;
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
  /** Everyone who touched it, busiest first. */
  contributors?: Contributor[];
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

/** A GitHub issue or a Jira work item, reconciled into one shape. */
export interface Ticket {
  source: 'github' | 'jira';
  ref: string;
  container: string;
  type: string;
  title: string | null;
  /** The word the source uses: `open`, `closed`, `In Progress`, `Done`. */
  status: string | null;
  /** Normalised, so both sides can be filtered and counted together. */
  state: 'open' | 'closed';
  assignee: string | null;
  author: string | null;
  updated_at: string | null;
  created_at: string | null;
  url: string | null;
  /** Everyone who touched it, busiest first. */
  contributors?: Contributor[];
}

export interface TicketsResponse {
  tickets: Ticket[];
  /** Everything the filters match, which the page usually is not. */
  total: number;
}

export interface TicketType {
  source: 'github' | 'jira';
  type: string;
  count: number;
}

export interface TicketContainer {
  source: 'github' | 'jira';
  container: string;
  count: number;
}

export interface OpenOnDay {
  day: string;
  open: number;
  opened: number;
  closed: number;
}

export interface HistoryResponse {
  from: string;
  to: string;
  days: OpenOnDay[];
}

/** Pull requests finished per day. A count of events, not a balance. */
export interface ClosedOnDay {
  day: string;
  total: number;
  merged: number;
  /** Closed without merging — work that produced nothing. */
  discarded: number;
}

export interface ClosedResponse {
  from: string;
  to: string;
  days: ClosedOnDay[];
}

export interface RunsOnDay {
  day: string;
  total: number;
  success: number;
  failure: number;
  cancelled: number;
  /** Skipped, timed out, and the ones still running. */
  other: number;
}

export interface RunsResponse {
  from: string;
  to: string;
  days: RunsOnDay[];
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

/** The other end of a cross reference, as `/api/links/<ref>` returns it. */
export interface CrossLink {
  ref: string;
  source: 'github' | 'jira';
  kind: string;
  /** Where the reference was found: branch, title, body, commit or comment. */
  via: string;
  confidence: 'high' | 'medium';
}

export interface LinksResponse {
  ref: string;
  links: CrossLink[];
}

/** One work item in the hierarchy that `/api/jira/tree/<key>` returns. */
export interface TreeNode {
  key: string;
  summary: string | null;
  type: string | null;
  status: string | null;
  statusCategory: string | null;
  assignee: string | null;
  storyPoints: number | null;
  resolvedAt: string | null;
  url: string | null;
  /** How this node hangs off its parent. */
  relation: 'parent' | 'self' | 'child' | 'epic-child';
  /** Depth relative to the requested item; ancestors are negative. */
  depth: number;
  children: TreeNode[];
}

export interface TreeSummary {
  total: number;
  done: number;
  storyPoints: number;
  storyPointsDone: number;
  byType: Record<string, number>;
  byStatusCategory: Record<string, number>;
}

export interface WorkitemTree {
  root: TreeNode;
  /** Parents above the requested item, closest first. */
  ancestors: TreeNode[];
  all: TreeNode[];
  /** Roll-up over the root and everything below it. */
  summary: TreeSummary;
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
  history: (params: Record<string, string | undefined>) =>
    request<HistoryResponse>('/api/history', params),
  closedPerDay: (params: Record<string, string | undefined>) =>
    request<ClosedResponse>('/api/history/closed', params),
  runsPerDay: (params: Record<string, string | undefined>) =>
    request<RunsResponse>('/api/history/runs', params),
  activity: (params: Record<string, string | undefined>) =>
    request<ActivityResponse>('/api/activity', params),
  tickets: (params: Record<string, string | undefined>) =>
    request<TicketsResponse>('/api/tickets', params),
  ticketTypes: (params: Record<string, string | undefined>) =>
    request<TicketType[]>('/api/tickets/types', params),
  ticketContainers: (params: Record<string, string | undefined>) =>
    request<TicketContainer[]>('/api/tickets/containers', params),
  workitems: (params: Record<string, string | undefined>) =>
    request<Workitem[]>('/api/jira/workitems', params),
  workitem: (key: string) => request<IssueDocument>(`/api/jira/workitems/${key}`),
  tree: (key: string, params: Record<string, string | undefined> = {}) =>
    request<WorkitemTree>(`/api/jira/tree/${encodeURIComponent(key)}`, params),
  sprints: (params: Record<string, string | undefined>) =>
    request<Sprint[]>('/api/jira/sprints', params),
  sprint: (id: number) => request<IssueDocument>(`/api/jira/sprints/${id}`),
  burndown: (sprint: number) =>
    request<BurndownResponse>(`/api/insights/burndown/${String(sprint)}`),
  velocity: (params: Record<string, string | undefined>) =>
    request<VelocityResponse>('/api/insights/velocity', params),
  statusTimes: (params: Record<string, string | undefined>) =>
    request<StatusTimesResponse>('/api/insights/status-time', params),
  insights: (params: Record<string, string | undefined>) =>
    request<InsightsResponse>('/api/insights', params),
  digest: (params: Record<string, string | undefined>) =>
    request<DigestResponse>('/api/digest', params),
  search: (params: Record<string, string | undefined>) =>
    request<SearchHit[]>('/api/search', params),
  links: (reference: string) =>
    request<LinksResponse>(`/api/links/${reference.split('/').map(encodeURIComponent).join('/')}`),
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
