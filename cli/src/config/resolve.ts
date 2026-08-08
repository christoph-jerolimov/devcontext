import { isAbsolute, resolve as resolvePath } from 'node:path';

import { CliError } from '../util/errors.js';
import { resolveTimeExpression } from '../util/time.js';
import type { RawConfig, RawGithubSyncOptions, RawJiraSyncOptions, RawPerson } from './schema.js';
import type {
  GithubHost,
  GithubRepoSyncOptions,
  GithubRepoTarget,
  JiraProjectSyncOptions,
  JiraProjectTarget,
  JiraSite,
  OutputTargets,
  Person,
  ProjectConfig,
  ResolvedConfig,
  SyncSettings,
  Team,
} from './types.js';

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  minDelayMs: 250,
  maxRetries: 5,
  retryBaseMs: 1000,
  respectRateLimit: true,
  rateLimitReserve: 50,
  maxRateLimitWaitMs: 900_000,
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

/**
 * The workflow run cap, where "no cap" and "not configured" are different.
 *
 * `?? 250` would be wrong: an explicit `null` means every run was asked for,
 * and `??` cannot tell that apart from the key being absent — it would hand
 * back the default and quietly ignore the request. Only `undefined` defaults.
 */
function resolveRunCap(value: number | null | 'all' | undefined): number | null {
  if (value === undefined) return 250;
  return value === 'all' ? null : value;
}

function resolveSince(value: string | undefined, now: Date): string | null {
  if (value === undefined) return null;
  return resolveTimeExpression(value, now);
}

/**
 * `people` and `bots` into one list, with every identity claimed exactly once.
 *
 * Two people claiming the same login is not a preference to resolve silently:
 * whichever one the lookup happened to return would be wrong half the time, and
 * the counts either way would look perfectly plausible. So it is an error, and
 * it names both sides.
 */
function resolvePeople(raw: RawConfig): Person[] {
  const people: Person[] = [];
  const byId = new Map<string, Person>();
  const claims = new Map<string, string>();

  const claim = (source: 'github' | 'jira', identity: string, person: Person): void => {
    const key = `${source}:${identity.toLowerCase()}`;
    const owner = claims.get(key);
    if (owner !== undefined && owner !== person.id) {
      throw new CliError(
        `The ${source} identity "${identity}" is claimed by both "${owner}" and "${person.id}".`,
        { hint: 'An identity can belong to one person only; remove it from one of them.' },
      );
    }
    claims.set(key, person.id);
  };

  const add = (entry: RawPerson, fallbackKind: 'person' | 'bot'): void => {
    if (byId.has(entry.id)) {
      throw new CliError(`Duplicate person id "${entry.id}" in the configuration.`);
    }
    const person: Person = {
      id: entry.id,
      name: entry.name ?? entry.id,
      email: entry.email ?? null,
      kind: (entry.bot ?? fallbackKind === 'bot') ? 'bot' : 'person',
      github: entry.github ?? [],
      jira: entry.jira ?? [],
    };
    for (const login of person.github) claim('github', login, person);
    for (const name of person.jira) claim('jira', name, person);
    byId.set(person.id, person);
    people.push(person);
  };

  for (const entry of raw.people ?? []) add(entry, 'person');
  for (const entry of raw.bots ?? []) add(entry, 'bot');
  return people;
}

function resolveTeams(raw: RawConfig, people: Person[]): Team[] {
  const known = new Set(people.map((person) => person.id));
  const teams: Team[] = [];
  const seen = new Set<string>();

  for (const entry of raw.teams ?? []) {
    if (seen.has(entry.id)) {
      throw new CliError(`Duplicate team id "${entry.id}" in the configuration.`);
    }
    seen.add(entry.id);

    for (const member of entry.members ?? []) {
      if (!known.has(member)) {
        throw new CliError(`Team "${entry.id}" lists the unknown person "${member}".`, {
          hint: `Known people: ${[...known].join(', ') || '(none)'}`,
        });
      }
    }

    teams.push({
      id: entry.id,
      name: entry.name ?? entry.id,
      description: entry.description ?? null,
      members: entry.members ?? [],
    });
  }
  return teams;
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

  const people = resolvePeople(raw);
  const teams = resolveTeams(raw, people);
  const me = resolveMe(raw, people);

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
        maxWorkflowRuns: resolveRunCap(entry.maxWorkflowRuns),
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
    people,
    teams,
    me,
    projects,
  };
}

/**
 * `me:` names one of the configured people, and must actually name one.
 *
 * A typo here would otherwise turn every `--me` into a filter matching nobody,
 * which is indistinguishable from a quiet week — the same reason an unknown
 * `--person` is an error rather than an empty result.
 */
function resolveMe(raw: RawConfig, people: Person[]): string | null {
  if (raw.me === undefined) return null;

  const match = people.find((person) => person.id.toLowerCase() === raw.me?.toLowerCase());
  if (!match) {
    throw new CliError(`me: names "${raw.me}", who is not in the people list.`, {
      hint: people.length
        ? `Known people: ${people.map((person) => person.id).join(', ')}`
        : 'Add a people: section first — see docs/people.md.',
    });
  }
  return match.id;
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
