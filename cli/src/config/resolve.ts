import { isAbsolute, resolve as resolvePath } from 'node:path';

import { CliError } from '../util/errors.js';
import { resolveTimeExpression } from '../util/time.js';
import type { RawConfig, RawGithubSyncOptions, RawJiraSyncOptions } from './schema.js';
import type {
  GithubHost,
  GithubRepoSyncOptions,
  GithubRepoTarget,
  JiraProjectSyncOptions,
  JiraProjectTarget,
  JiraSite,
  OutputTargets,
  ProjectConfig,
  ResolvedConfig,
  SyncSettings,
} from './types.js';

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  minDelayMs: 250,
  maxRetries: 5,
  retryBaseMs: 1000,
  respectRateLimit: true,
  rateLimitReserve: 50,
  requestTimeoutMs: 60_000,
  pageSize: 100,
  progress: true,
};

export const DEFAULT_GITHUB_SYNC: GithubRepoSyncOptions = {
  issues: true,
  issueComments: true,
  issueTimeline: true,
  issueReactions: false,
  pullRequests: true,
  pullRequestReviews: true,
  pullRequestComments: true,
  pullRequestCommits: true,
  pullRequestFiles: true,
  labels: true,
  milestones: true,
  releases: false,
  workflows: true,
  workflowRuns: true,
  workflowJobs: true,
  workflowLogs: false,
};

export const DEFAULT_JIRA_SYNC: JiraProjectSyncOptions = {
  workitems: true,
  comments: true,
  changelog: true,
  worklogs: false,
  links: true,
  attachments: true,
  boards: true,
  sprints: true,
};

const DEFAULT_GITHUB_HOST: GithubHost = {
  name: 'github.com',
  apiUrl: 'https://api.github.com',
  webUrl: 'https://github.com',
  token: null,
  tokenEnv: 'GITHUB_TOKEN',
};

function mergeFlags<T extends object>(
  defaults: T,
  ...overrides: Array<Partial<Record<keyof T, boolean | undefined>> | undefined>
): T {
  const result = { ...defaults };
  for (const override of overrides) {
    if (!override) continue;
    for (const [key, value] of Object.entries(override)) {
      if (typeof value === 'boolean' && key in result) {
        (result as Record<string, boolean>)[key] = value;
      }
    }
  }
  return result;
}

function absolutePath(rootDir: string, value: string): string {
  return isAbsolute(value) ? value : resolvePath(rootDir, value);
}

function readToken(explicit: string | undefined, envName: string): string | null {
  if (explicit && explicit.trim() !== '') return explicit;
  const fromEnv = process.env[envName];
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : null;
}

function resolveSince(value: string | undefined, now: Date): string | null {
  if (value === undefined) return null;
  return resolveTimeExpression(value, now);
}

/** Applies defaults, resolves paths/tokens and links projects to hosts and sites. */
export function resolveConfig(
  raw: RawConfig,
  options: { configPath: string; rootDir: string; now?: Date },
): ResolvedConfig {
  const now = options.now ?? new Date();
  const rootDir = options.rootDir;

  const databasePath =
    typeof raw.database === 'string'
      ? absolutePath(rootDir, raw.database)
      : absolutePath(rootDir, raw.database?.path ?? '.devcontext/devcontext.db');

  const sync: SyncSettings = {
    ...DEFAULT_SYNC_SETTINGS,
    ...Object.fromEntries(Object.entries(raw.sync ?? {}).filter(([, v]) => v !== undefined)),
  } as SyncSettings;

  const outputs: OutputTargets = {
    yaml: {
      enabled: raw.outputs?.yaml?.enabled ?? true,
      path: absolutePath(rootDir, raw.outputs?.yaml?.path ?? '.devcontext/yaml'),
    },
    markdown: {
      enabled: raw.outputs?.markdown?.enabled ?? true,
      path: absolutePath(rootDir, raw.outputs?.markdown?.path ?? '.devcontext/markdown'),
    },
    json: {
      enabled: raw.outputs?.json?.enabled ?? false,
      path: absolutePath(rootDir, raw.outputs?.json?.path ?? '.devcontext/json'),
    },
  };

  const githubHosts = new Map<string, GithubHost>();
  const rawHosts = raw.github?.hosts ?? [];
  if (rawHosts.length === 0) {
    githubHosts.set(DEFAULT_GITHUB_HOST.name, {
      ...DEFAULT_GITHUB_HOST,
      token: readToken(undefined, DEFAULT_GITHUB_HOST.tokenEnv),
    });
  }
  for (const host of rawHosts) {
    if (githubHosts.has(host.name)) {
      throw new CliError(`Duplicate GitHub host "${host.name}" in the configuration.`);
    }
    const tokenEnv = host.tokenEnv ?? DEFAULT_GITHUB_HOST.tokenEnv;
    const apiUrl = (host.apiUrl ?? DEFAULT_GITHUB_HOST.apiUrl).replace(/\/+$/, '');
    githubHosts.set(host.name, {
      name: host.name,
      apiUrl,
      webUrl: (host.webUrl ?? deriveWebUrl(apiUrl)).replace(/\/+$/, ''),
      tokenEnv,
      token: readToken(host.token, tokenEnv),
    });
  }

  const jiraSites = new Map<string, JiraSite>();
  for (const site of raw.jira?.sites ?? []) {
    if (jiraSites.has(site.name)) {
      throw new CliError(`Duplicate Jira site "${site.name}" in the configuration.`);
    }
    const tokenEnv = site.tokenEnv ?? 'JIRA_API_TOKEN';
    jiraSites.set(site.name, {
      name: site.name,
      baseUrl: site.baseUrl.replace(/\/+$/, ''),
      apiVersion: site.apiVersion ?? '3',
      auth: site.auth ?? (site.email ? 'basic' : 'bearer'),
      email: site.email ?? null,
      tokenEnv,
      token: readToken(site.token, tokenEnv),
      fields: site.fields ?? {},
    });
  }

  const projects: ProjectConfig[] = [];
  const seenProjectKeys = new Set<string>();

  for (const project of raw.projects) {
    if (seenProjectKeys.has(project.key)) {
      throw new CliError(`Duplicate project key "${project.key}" in the configuration.`);
    }
    seenProjectKeys.add(project.key);

    const github: GithubRepoTarget[] = (project.github ?? []).map((entry) => {
      const hostName = entry.host ?? firstKey(githubHosts) ?? DEFAULT_GITHUB_HOST.name;
      const host = githubHosts.get(hostName);
      if (!host) {
        throw new CliError(
          `Project "${project.key}" references the unknown GitHub host "${hostName}".`,
          { hint: `Known hosts: ${[...githubHosts.keys()].join(', ') || '(none)'}` },
        );
      }
      const [owner, repo] = entry.repo.split('/') as [string, string];
      return {
        host,
        owner,
        repo,
        fullName: `${owner}/${repo}`,
        since: resolveSince(entry.since, now),
        maxWorkflowRuns: entry.maxWorkflowRuns ?? 250,
        maxLogBytes: entry.maxLogBytes ?? 2_000_000,
        sync: mergeFlags<GithubRepoSyncOptions>(
          DEFAULT_GITHUB_SYNC,
          raw.github?.sync as RawGithubSyncOptions | undefined,
          entry.sync as RawGithubSyncOptions | undefined,
        ),
      };
    });

    const jira: JiraProjectTarget[] = (project.jira ?? []).map((entry) => {
      const siteName = entry.site ?? firstKey(jiraSites);
      if (!siteName) {
        throw new CliError(
          `Project "${project.key}" configures a Jira project but no Jira site is defined.`,
          { hint: 'Add a jira.sites entry with a name, baseUrl and tokenEnv.' },
        );
      }
      const site = jiraSites.get(siteName);
      if (!site) {
        throw new CliError(
          `Project "${project.key}" references the unknown Jira site "${siteName}".`,
          { hint: `Known sites: ${[...jiraSites.keys()].join(', ') || '(none)'}` },
        );
      }
      return {
        site,
        projectKey: entry.project.toUpperCase(),
        filter: entry.filter ?? null,
        since: resolveSince(entry.since, now),
        boardIds: entry.boards ?? [],
        fields: { ...site.fields, ...entry.fields },
        sync: mergeFlags<JiraProjectSyncOptions>(
          DEFAULT_JIRA_SYNC,
          raw.jira?.sync as RawJiraSyncOptions | undefined,
          entry.sync as RawJiraSyncOptions | undefined,
        ),
      };
    });

    if (github.length === 0 && jira.length === 0) {
      throw new CliError(
        `Project "${project.key}" has neither a GitHub repository nor a Jira project configured.`,
      );
    }

    projects.push({
      key: project.key,
      name: project.name ?? project.key,
      description: project.description ?? null,
      github,
      jira,
    });
  }

  return {
    configPath: options.configPath,
    rootDir,
    databasePath,
    sync,
    outputs,
    web: {
      port: raw.web?.port ?? 4173,
      host: raw.web?.host ?? '127.0.0.1',
      open: raw.web?.open ?? false,
    },
    githubHosts,
    jiraSites,
    projects,
  };
}

function firstKey<T>(map: Map<string, T>): string | undefined {
  for (const key of map.keys()) return key;
  return undefined;
}

/** `https://api.github.com` -> `https://github.com`, `https://ghe/api/v3` -> `https://ghe`. */
function deriveWebUrl(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    if (url.hostname === 'api.github.com') return 'https://github.com';
    return `${url.protocol}//${url.host}`;
  } catch {
    return apiUrl;
  }
}
