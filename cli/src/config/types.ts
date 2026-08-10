/** Fully resolved configuration: defaults applied, paths absolute, references linked. */

export interface GithubHost {
  name: string;
  apiUrl: string;
  webUrl: string;
  token: string | null;
  tokenEnv: string;
}

export interface JiraSite {
  name: string;
  baseUrl: string;
  apiVersion: '2' | '3';
  auth: 'basic' | 'bearer';
  email: string | null;
  token: string | null;
  tokenEnv: string;
  /** Global custom field mapping, e.g. `customfield_10016` -> `storyPoints`. */
  fields: Record<string, string>;
}

export interface GithubRepoSyncOptions {
  issues: boolean;
  issueComments: boolean;
  issueTimeline: boolean;
  issueReactions: boolean;
  pullRequests: boolean;
  pullRequestReviews: boolean;
  pullRequestComments: boolean;
  pullRequestCommits: boolean;
  pullRequestFiles: boolean;
  labels: boolean;
  milestones: boolean;
  workflows: boolean;
  workflowRuns: boolean;
  workflowJobs: boolean;
  workflowLogs: boolean;
}

export interface GithubRepoTarget {
  host: GithubHost;
  owner: string;
  repo: string;
  fullName: string;
  /** Oldest data the initial sync should reach for, as an ISO timestamp. */
  since: string | null;
  /** How many workflow runs one sync may take, or `null` for every one. */
  maxWorkflowRuns: number | null;
  maxLogBytes: number;
  sync: GithubRepoSyncOptions;
}

export interface JiraProjectSyncOptions {
  workitems: boolean;
  comments: boolean;
  changelog: boolean;
  links: boolean;
  attachments: boolean;
  boards: boolean;
  sprints: boolean;
}

export interface JiraProjectTarget {
  site: JiraSite;
  projectKey: string;
  /** Extra JQL that every synced work item must match (e.g. to exclude security issues). */
  filter: string | null;
  since: string | null;
  boardIds: number[];
  /** Custom field mapping merged from site level and project level. */
  fields: Record<string, string>;
  sync: JiraProjectSyncOptions;
}

export interface ProjectConfig {
  key: string;
  name: string;
  description: string | null;
  github: GithubRepoTarget[];
  jira: JiraProjectTarget[];
}

export type PersonKind = 'person' | 'bot';

/**
 * One human or one automation, and every name the sources know them by.
 *
 * The database stores whatever string the API returned — a GitHub login in one
 * table, a Jira display name in another — so without this the same colleague is
 * two or three different people to every query that counts them.
 */
export interface Person {
  id: string;
  name: string;
  email: string | null;
  kind: PersonKind;
  /** GitHub logins, as written in the configuration. */
  github: string[];
  /** Jira display names, account ids or emails, as written in the configuration. */
  jira: string[];
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
  /** Person ids, in configuration order. */
  members: string[];
}

export interface SyncSettings {
  /** Minimum delay between two API calls against the same source, in milliseconds. */
  minDelayMs: number;
  /** How many API calls may be in flight at once; 1 is the old serial sync. */
  concurrency: number;
  maxRetries: number;
  retryBaseMs: number;
  /** Slow down / wait when the remote rate limit budget gets low. */
  respectRateLimit: boolean;
  /** Keep this many requests in reserve before waiting for the rate limit window to reset. */
  rateLimitReserve: number;
  /** Fail instead of waiting longer than this for a rate limit window to reset. */
  maxRateLimitWaitMs: number;
  requestTimeoutMs: number;
  pageSize: number;
  progress: boolean;
}

export interface OutputTargets {
  yaml: { enabled: boolean; path: string };
  markdown: { enabled: boolean; path: string };
  json: { enabled: boolean; path: string };
}

export interface WebSettings {
  port: number;
  host: string;
  open: boolean;
}

export interface ResolvedConfig {
  /** Absolute path of the configuration file this was loaded from. */
  configPath: string;
  /** Directory of the configuration file; all relative paths resolve against it. */
  rootDir: string;
  databasePath: string;
  sync: SyncSettings;
  outputs: OutputTargets;
  web: WebSettings;
  githubHosts: Map<string, GithubHost>;
  jiraSites: Map<string, JiraSite>;
  /** Humans and bots, in configuration order; humans first when both sections are used. */
  people: Person[];
  /** The id of the person running devcontext, when they said so. */
  me: string | null;
  teams: Team[];
  projects: ProjectConfig[];
}
