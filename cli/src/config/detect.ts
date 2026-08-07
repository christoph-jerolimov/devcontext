import { execFileSync } from 'node:child_process';

export interface DetectedRepository {
  /** `owner/name`. */
  fullName: string;
  owner: string;
  name: string;
  /** The git remote it came from, e.g. `origin`. */
  remote: string;
  /** Host name as it appears in the URL, e.g. `github.com` or `github.acme.com`. */
  host: string;
  /** The raw remote URL, kept for the summary devcontext prints. */
  url: string;
}

export interface DetectedEnvironment {
  repositories: DetectedRepository[];
  /** Where a usable GitHub token was found, if anywhere. */
  token: { source: 'env'; variable: string } | { source: 'gh-cli' } | null;
  /** Enterprise hosts that were seen, so the configuration can define them. */
  hosts: Array<{ name: string; apiUrl: string }>;
}

/**
 * Parses a git remote URL into owner, repository and host.
 *
 * Handles the forms git actually produces:
 *   https://github.com/acme/platform.git
 *   https://user@github.com/acme/platform
 *   git@github.com:acme/platform.git
 *   ssh://git@github.acme.com:2222/acme/platform.git
 *   git://github.com/acme/platform.git
 */
export function parseRemoteUrl(url: string): { host: string; owner: string; name: string } | null {
  const trimmed = url.trim();
  if (trimmed === '') return null;

  let host: string;
  let path: string;

  const scpLike = /^(?:([^@/]+)@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  if (scpLike && !trimmed.includes('://')) {
    host = scpLike[2] ?? '';
    path = scpLike[3] ?? '';
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  }

  const segments = path
    .replace(/\.git$/i, '')
    .split('/')
    .filter((segment) => segment !== '');

  if (segments.length < 2 || host === '') return null;

  // Enterprise URLs can be nested, but the repository is always the last two.
  const name = segments[segments.length - 1] as string;
  const owner = segments[segments.length - 2] as string;
  return { host, owner, name };
}

/** `github.com` -> the public API, anything else -> the Enterprise Server path. */
export function apiUrlForHost(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

/** A short, stable configuration name for a host. */
export function hostNameFor(host: string): string {
  return host === 'github.com' ? 'github.com' : host.split('.')[0] || host;
}

function run(command: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/** Lists the git remotes of `cwd` as name -> url. */
export function gitRemotes(cwd: string = process.cwd()): Map<string, string> {
  const remotes = new Map<string, string>();
  const output = run('git', ['remote', '-v'], cwd);
  if (output === null) return remotes;

  for (const line of output.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const [, name, url] = match;
    if (name && url && !remotes.has(name)) remotes.set(name, url);
  }
  return remotes;
}

/** True when the `gh` CLI is installed and holds a usable token. */
function ghCliToken(cwd: string): boolean {
  return run('gh', ['auth', 'token'], cwd) !== null;
}

const TOKEN_VARIABLES = ['DEVCONTEXT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'];

/**
 * Looks at the working directory and the environment and reports what a
 * configuration could be built from, without writing anything.
 */
export function detectEnvironment(
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): DetectedEnvironment {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  const repositories: DetectedRepository[] = [];
  const seen = new Set<string>();

  // `origin` first, then `upstream`, then whatever else exists.
  const remotes = [...gitRemotes(cwd).entries()].toSorted(([a], [b]) => rank(a) - rank(b));

  for (const [remote, url] of remotes) {
    const parsed = parseRemoteUrl(url);
    if (!parsed) continue;
    const fullName = `${parsed.owner}/${parsed.name}`;
    if (seen.has(`${parsed.host}/${fullName}`)) continue;
    seen.add(`${parsed.host}/${fullName}`);
    repositories.push({
      fullName,
      owner: parsed.owner,
      name: parsed.name,
      remote,
      host: parsed.host,
      url,
    });
  }

  const variable = TOKEN_VARIABLES.find((name) => (env[name] ?? '') !== '');
  const token = variable
    ? ({ source: 'env', variable } as const)
    : ghCliToken(cwd)
      ? ({ source: 'gh-cli' } as const)
      : null;

  const hosts = [...new Set(repositories.map((repository) => repository.host))].map((host) => ({
    name: hostNameFor(host),
    apiUrl: apiUrlForHost(host),
  }));

  return { repositories, token, hosts };
}

function rank(remote: string): number {
  if (remote === 'origin') return 0;
  if (remote === 'upstream') return 1;
  return 2;
}

export interface BuildConfigOptions {
  repositories: DetectedRepository[];
  /** Project key; defaults to the first repository name. */
  projectKey?: string;
  tokenEnv?: string;
  since?: string;
}

/**
 * Renders a small, ready to use configuration for the detected repositories.
 * Deliberately shorter than the full example: it is meant to be read in one
 * go and edited, not to document every option.
 */
export function buildDetectedConfig(options: BuildConfigOptions): string {
  const { repositories } = options;
  const first = repositories[0];
  const projectKey = options.projectKey ?? (first ? first.name.toLowerCase() : 'my-project');
  const tokenEnv = options.tokenEnv ?? 'GITHUB_TOKEN';
  const since = options.since ?? '12mo';

  const hosts = [
    ...new Map(repositories.map((repository) => [repository.host, repository])).values(),
  ];
  const needsHostSection = hosts.some((repository) => repository.host !== 'github.com');

  const lines: string[] = [
    '# devcontext configuration, generated by `devcontext init --detect`.',
    '#',
    '# The repositories below were detected from the git remotes of this',
    '# working directory. See docs/configuration.md for every available option,',
    '# or run `devcontext init --force` to write the fully commented example.',
    'version: 1',
    '',
    'database:',
    '  path: .devcontext/devcontext.db',
    '',
  ];

  if (needsHostSection) {
    lines.push('github:', '  hosts:');
    for (const repository of hosts) {
      lines.push(
        `    - name: ${hostNameFor(repository.host)}`,
        `      apiUrl: ${apiUrlForHost(repository.host)}`,
        `      tokenEnv: ${
          repository.host === 'github.com'
            ? tokenEnv
            : `${hostNameFor(repository.host)
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '_')}_TOKEN`
        }`,
      );
    }
    lines.push('');
  } else {
    lines.push('github:', '  hosts:', '    - name: github.com', `      tokenEnv: ${tokenEnv}`, '');
  }

  lines.push(
    '# Uncomment to sync Jira as well. `devcontext jira fields` lists the',
    '# custom field ids of your site once the first sync has run.',
    '# jira:',
    '#   sites:',
    '#     - name: acme',
    '#       baseUrl: https://acme.atlassian.net',
    '#       email: ${JIRA_EMAIL}',
    '#       tokenEnv: JIRA_API_TOKEN',
    '',
    'projects:',
    `  - key: ${projectKey}`,
    '    github:',
  );

  for (const repository of repositories) {
    lines.push(`      - repo: ${repository.fullName}`);
    if (repository.host !== 'github.com') {
      lines.push(`        host: ${hostNameFor(repository.host)}`);
    }
    lines.push(`        since: ${since}`);
  }

  lines.push('#    jira:', '#      - project: PLAT', '');
  return lines.join('\n');
}
