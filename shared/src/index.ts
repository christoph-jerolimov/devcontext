/**
 * The wire contract between the devcontext server and its viewers.
 *
 * These are the shapes the JSON API under `/api` answers with. They live in
 * their own workspace because two independently built programs have to agree
 * on them: the server (`@devcontext/cli`) annotates its handlers with these
 * types, and the web viewer imports them for what `fetch` returns. Before this
 * package existed each side kept its own copy, and the copies drifted — the
 * server grew fields the viewer's types never heard of.
 *
 * Everything here is a type. The package has no runtime code at all, so
 * importing it costs nothing and cannot fail — its `exports` map offers only
 * `types`, and a value import is a build error rather than a quiet bundle.
 */

/** Row counts for one repository, as `/api/status` breaks them down. */
export interface RepositoryStats {
  repository: string;
  issues: number;
  openIssues: number;
  pullRequests: number;
  openPullRequests: number;
  comments: number;
  events: number;
  reviews: number;
  workflows: number;
  workflowRuns: number;
  workflowJobs: number;
  jobLogs: number;
}

/** Row counts for one Jira project. */
export interface ProjectStats {
  project: string;
  workitems: number;
  openWorkitems: number;
  comments: number;
  changelogEntries: number;
  links: number;
  attachments: number;
  boards: number;
  sprints: number;
}

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
  githubByRepository: RepositoryStats[];
  jiraByProject: ProjectStats[];
  /** Cross references between the two sides, counted by kind. */
  links: Record<string, number>;
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
  /** Non-null when the server was started with `serve --watch`. */
  watch: WatchStatus | null;
}

/** Present in `/api/status` when the server also syncs on an interval. */
export interface WatchStatus {
  intervalMs: number;
  /** True while a background sync is writing. */
  running: boolean;
  /** True while the interval is held; nothing syncs until resumed. */
  paused: boolean;
  /**
   * Where the running sync has got to; null between runs. Served with the
   * status so a page opened two hours into a sync shows the bar immediately
   * instead of waiting for the next event.
   */
  progress: SyncProgress | null;
}

/** How far a sync has got — the server's progress bar, as data. */
export interface SyncProgress {
  /** `planning`, `issues`, `pull requests`, ... */
  phase: string;
  /** `#4021, 5 of 231`, or empty when the phase is not walking a list. */
  position: string;
  apiCalls: number;
  /** Grows as the sync discovers work; never below `apiCalls`. */
  apiCallsExpected: number;
  items: number;
  elapsedMs: number;
  /** Null before the first call has been made; 0 when nothing remains. */
  etaMs: number | null;
}

/*
 * The `/api/events` stream (server-sent events). Each named event carries one
 * JSON payload; `data-changed` also fires when a sync outside this process —
 * a plain `devcontext sync` in another terminal — commits to the database.
 */
export interface HelloEvent {
  watch: { intervalMs: number } | null;
}

export interface SyncStartedEvent {
  at: string;
  reason: 'startup' | 'interval' | 'manual' | 'resume';
}

export interface SyncProgressEvent {
  at: string;
  progress: SyncProgress;
}

/** `watch-paused` / `watch-resumed`: the interval was held or released. */
export interface WatchPausedEvent {
  at: string;
}

export interface SyncCompletedEvent {
  at: string;
  /** `interrupted` means a pause cut the run short; nothing is lost. */
  status: 'completed' | 'failed' | 'interrupted';
  durationMs: number;
  error: string | null;
}

export interface DataChangedEvent {
  /** SQLite's data_version: it only ever moves, its value means nothing. */
  version: number;
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
