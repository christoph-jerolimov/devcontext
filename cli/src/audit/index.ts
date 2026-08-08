import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import type { ResolvedConfig } from '../config/types.js';
import type { Database } from '../db/database.js';
import { scanText } from './secrets.js';
import type { SecretFinding } from './secrets.js';

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

export interface StoredFile {
  kind: 'database' | 'yaml' | 'markdown' | 'json';
  path: string;
  /** Relative to the working directory when that is shorter, for display. */
  shortPath: string;
  exists: boolean;
  bytes: number;
  /** POSIX mode as `rw-r--r--`, so "who else can read this" is one glance. */
  mode: string | null;
  /** True when git would track it — the accident that leaks a whole database. */
  tracked: boolean | null;
}

export interface StorageReport {
  kind: 'storage';
  files: StoredFile[];
  totalBytes: number;
  /** Paths that git is not ignoring; the thing to fix before committing. */
  unignored: string[];
}

export function storageReport(config: ResolvedConfig): StorageReport {
  const ignored = gitIgnorePatterns(config.configPath ?? process.cwd());

  const candidates: Array<{ kind: StoredFile['kind']; path: string | null }> = [
    { kind: 'database', path: config.databasePath },
    { kind: 'yaml', path: config.outputs.yaml.enabled ? config.outputs.yaml.path : null },
    {
      kind: 'markdown',
      path: config.outputs.markdown.enabled ? config.outputs.markdown.path : null,
    },
    { kind: 'json', path: config.outputs.json.enabled ? config.outputs.json.path : null },
  ];

  const files: StoredFile[] = [];
  for (const candidate of candidates) {
    if (candidate.path === null) continue;
    const exists = existsSync(candidate.path);
    const stat = exists ? statSync(candidate.path) : null;
    files.push({
      kind: candidate.kind,
      path: candidate.path,
      shortPath: shorten(candidate.path),
      exists,
      bytes: stat ? directorySize(candidate.path) : 0,
      mode: stat ? formatMode(stat.mode) : null,
      tracked: ignored === null ? null : !isIgnored(candidate.path, ignored),
    });
  }

  return {
    kind: 'storage',
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    unignored: files.filter((file) => file.tracked === true).map((file) => file.path),
  };
}

/** An absolute path is unambiguous but unreadable; prefer the relative one. */
function shorten(path: string): string {
  const relativePath = relative(process.cwd(), path);
  return relativePath !== '' && !relativePath.startsWith('..') && relativePath.length < path.length
    ? relativePath
    : path;
}

function directorySize(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;

  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const child = resolve(path, entry);
    try {
      const childStat = statSync(child);
      total += childStat.isDirectory() ? directorySize(child) : childStat.size;
    } catch {
      // Disappeared while walking; nothing to report.
    }
  }
  return total;
}

function formatMode(mode: number): string {
  const bits = ['r', 'w', 'x'];
  let out = '';
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let bit = 0; bit < 3; bit += 1) {
      out += (mode >> (shift + (2 - bit))) & 1 ? bits[bit] : '-';
    }
  }
  return out;
}

/** The patterns of the nearest `.gitignore`, or `null` when there is no repo. */
function gitIgnorePatterns(from: string): string[] | null {
  let directory = statSafeIsDirectory(from) ? from : dirname(from);
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(resolve(directory, '.git'))) {
      const file = resolve(directory, '.gitignore');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'));
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function statSafeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isIgnored(path: string, patterns: string[]): boolean {
  const relativePath = relative(process.cwd(), path).replaceAll('\\', '/');
  return patterns.some((pattern) => {
    const clean = pattern.replace(/^\//, '').replace(/\/$/, '');
    return (
      relativePath === clean ||
      relativePath.startsWith(`${clean}/`) ||
      relativePath.split('/').includes(clean)
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Content                                                                     */
/* -------------------------------------------------------------------------- */

export interface ContentGroup {
  group: string;
  rows: number;
  /** Columns of this group that hold free text somebody wrote. */
  freeText: string[];
}

export interface ContentReport {
  kind: 'content';
  groups: ContentGroup[];
  totalRows: number;
}

/*
 * What is actually stored, grouped the way somebody asking "what is on your
 * laptop?" thinks about it, with the free text columns named because those are
 * the ones that carry anything confidential.
 */
const CONTENT_GROUPS: Array<{ group: string; tables: string[]; freeText: string[] }> = [
  { group: 'Issues', tables: ['gh_issues'], freeText: ['title', 'body'] },
  { group: 'Issue comments', tables: ['gh_comments'], freeText: ['body'] },
  { group: 'Issue timeline', tables: ['gh_events'], freeText: ['label', 'rename'] },
  { group: 'Pull requests', tables: ['gh_pull_requests'], freeText: ['title', 'body'] },
  { group: 'Reviews', tables: ['gh_reviews'], freeText: ['body'] },
  { group: 'Review comments', tables: ['gh_review_comments'], freeText: ['body', 'diff_hunk'] },
  { group: 'Commits', tables: ['gh_commits'], freeText: ['message'] },
  { group: 'Changed files', tables: ['gh_pull_request_files'], freeText: ['patch'] },
  {
    group: 'Workflow runs and jobs',
    tables: ['gh_workflow_runs', 'gh_workflow_jobs'],
    freeText: [],
  },
  { group: 'Job logs', tables: ['gh_job_logs'], freeText: ['content'] },
  { group: 'Work items', tables: ['jira_workitems'], freeText: ['summary', 'description'] },
  { group: 'Work item comments', tables: ['jira_comments'], freeText: ['body'] },
  {
    group: 'Work item history',
    tables: ['jira_changelog'],
    freeText: ['from_string', 'to_string'],
  },
  { group: 'Work logs', tables: ['jira_worklogs'], freeText: ['comment'] },
  { group: 'Attachments (metadata only)', tables: ['jira_attachments'], freeText: ['filename'] },
];

export function contentReport(db: Database): ContentReport {
  const groups: ContentGroup[] = [];
  for (const entry of CONTENT_GROUPS) {
    const rows = entry.tables
      .filter((table) => db.tableExists(table))
      .reduce((sum, table) => sum + db.count(table), 0);
    if (rows === 0) continue;
    groups.push({ group: entry.group, rows, freeText: entry.freeText });
  }
  return {
    kind: 'content',
    groups,
    totalRows: groups.reduce((sum, group) => sum + group.rows, 0),
  };
}

/* -------------------------------------------------------------------------- */
/* People                                                                      */
/* -------------------------------------------------------------------------- */

export interface PersonRecord {
  name: string;
  source: 'github' | 'jira';
  /** Where the name shows up, so "why is this person in here" has an answer. */
  appearsAs: string[];
}

export interface PeopleReport {
  kind: 'people';
  people: PersonRecord[];
  emails: number;
}

/** Everybody whose name the database holds, and why. */
export function peopleReport(db: Database, limit = 100): PeopleReport {
  const found = new Map<string, PersonRecord>();

  const collect = (
    table: string,
    column: string,
    source: PersonRecord['source'],
    role: string,
  ): void => {
    if (!db.tableExists(table)) return;
    for (const row of db.all<{ value: string | null }>(
      `SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`,
    )) {
      if (row.value === null) continue;
      const key = `${source}:${row.value}`;
      const entry = found.get(key) ?? { name: row.value, source, appearsAs: [] };
      if (!entry.appearsAs.includes(role)) entry.appearsAs.push(role);
      found.set(key, entry);
    }
  };

  collect('gh_issues', 'author', 'github', 'issue author');
  collect('gh_comments', 'author', 'github', 'commenter');
  collect('gh_pull_requests', 'author', 'github', 'pull request author');
  collect('gh_reviews', 'author', 'github', 'reviewer');
  collect('gh_workflow_runs', 'actor', 'github', 'workflow actor');
  collect('jira_workitems', 'assignee', 'jira', 'assignee');
  collect('jira_workitems', 'reporter', 'jira', 'reporter');
  collect('jira_comments', 'author', 'jira', 'commenter');
  collect('jira_changelog', 'author', 'jira', 'changed a field');

  return {
    kind: 'people',
    people: [...found.values()].toSorted((a, b) => a.name.localeCompare(b.name)).slice(0, limit),
    emails: countEmails(db),
  };
}

/** Email addresses are worth counting separately: they are personal data. */
function countEmails(db: Database): number {
  if (!db.tableExists('gh_commits')) return 0;
  return db.count('gh_commits', `author_email IS NOT NULL AND author_email != ''`);
}

/* -------------------------------------------------------------------------- */
/* Secrets                                                                     */
/* -------------------------------------------------------------------------- */

export interface SecretHit extends SecretFinding {
  ref: string;
  where: string;
}

export interface SecretsReport {
  kind: 'secrets';
  hits: SecretHit[];
  scanned: number;
  /** Counts by pattern, so a wall of one kind reads as one problem. */
  byPattern: Record<string, number>;
  highConfidence: number;
}

interface ScanSource {
  where: string;
  sql: string;
  table: string;
}

const SCAN_SOURCES: ScanSource[] = [
  {
    where: 'issue body',
    table: 'gh_issues',
    sql: `SELECT repo_full_name || '#' || number AS ref, body AS text FROM gh_issues
           WHERE body IS NOT NULL AND body != ''`,
  },
  {
    where: 'issue comment',
    table: 'gh_comments',
    sql: `SELECT repo_full_name || '#' || COALESCE(issue_number, 0) AS ref, body AS text
            FROM gh_comments WHERE body IS NOT NULL AND body != ''`,
  },
  {
    where: 'pull request body',
    table: 'gh_pull_requests',
    sql: `SELECT repo_full_name || '#' || number AS ref, body AS text FROM gh_pull_requests
           WHERE body IS NOT NULL AND body != ''`,
  },
  {
    where: 'review',
    table: 'gh_reviews',
    sql: `SELECT repo_full_name || '#' || COALESCE(pr_number, 0) AS ref, body AS text
            FROM gh_reviews WHERE body IS NOT NULL AND body != ''`,
  },
  {
    where: 'job log',
    table: 'gh_job_logs',
    sql: `SELECT CAST(job_id AS TEXT) AS ref, content AS text FROM gh_job_logs
           WHERE content IS NOT NULL AND content != ''`,
  },
  {
    where: 'work item description',
    table: 'jira_workitems',
    sql: `SELECT key AS ref, description AS text FROM jira_workitems
           WHERE description IS NOT NULL AND description != ''`,
  },
  {
    where: 'work item comment',
    table: 'jira_comments',
    sql: `SELECT workitem_key AS ref, body AS text FROM jira_comments
           WHERE body IS NOT NULL AND body != ''`,
  },
];

export interface SecretsOptions {
  /** Include the keyword heuristics, which need a human to confirm. */
  includeLowConfidence?: boolean | undefined;
  limit?: number | undefined;
}

export function secretsReport(db: Database, options: SecretsOptions = {}): SecretsReport {
  const hits: SecretHit[] = [];
  const byPattern: Record<string, number> = {};
  let scanned = 0;

  for (const source of SCAN_SOURCES) {
    if (!db.tableExists(source.table)) continue;
    for (const row of db.all<{ ref: string; text: string }>(source.sql)) {
      scanned += 1;
      for (const finding of scanText(row.text)) {
        if (finding.confidence === 'low' && options.includeLowConfidence !== true) continue;
        byPattern[finding.patternId] = (byPattern[finding.patternId] ?? 0) + 1;
        hits.push({ ...finding, ref: row.ref, where: source.where });
      }
    }
  }

  // Certain findings first: that is what somebody has to act on today.
  const sorted = hits.toSorted((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'high' ? -1 : 1;
    return a.ref.localeCompare(b.ref);
  });

  return {
    kind: 'secrets',
    hits: options.limit && options.limit > 0 ? sorted.slice(0, options.limit) : sorted,
    scanned,
    byPattern,
    highConfidence: hits.filter((hit) => hit.confidence === 'high').length,
  };
}

/* -------------------------------------------------------------------------- */
/* Config: what a sync would fetch                                             */
/* -------------------------------------------------------------------------- */

export interface TargetPlan {
  target: string;
  source: 'github' | 'jira';
  /** Resources this target would fetch, by their configuration key. */
  enabled: string[];
  disabled: string[];
  /** Everything limiting what is fetched: a date bound, a JQL filter, caps. */
  limits: string[];
  /** The environment variable the credential is read from. Never the value. */
  tokenEnv: string;
  tokenPresent: boolean;
}

export interface ConfigReport {
  kind: 'config';
  configPath: string | null;
  targets: TargetPlan[];
  /** True when every target has at least one thing it will not fetch. */
  writesAnywhere: false;
}

export function configReport(config: ResolvedConfig): ConfigReport {
  const targets: TargetPlan[] = [];

  for (const project of config.projects) {
    for (const repo of project.github) {
      const limits: string[] = [];
      if (repo.since) limits.push(`nothing older than ${repo.since.slice(0, 10)}`);
      limits.push(
        repo.maxWorkflowRuns === null
          ? 'every workflow run'
          : `at most ${String(repo.maxWorkflowRuns)} workflow runs`,
      );
      if (repo.sync.workflowLogs) {
        limits.push(`job logs truncated at ${Math.round(repo.maxLogBytes / 1024)} KiB`);
      }

      targets.push({
        target: repo.fullName,
        source: 'github',
        enabled: enabledKeys(repo.sync),
        disabled: disabledKeys(repo.sync),
        limits,
        tokenEnv: repo.host.tokenEnv,
        tokenPresent: repo.host.token !== null,
      });
    }

    for (const jira of project.jira) {
      const limits: string[] = [];
      if (jira.since) limits.push(`nothing older than ${jira.since.slice(0, 10)}`);
      if (jira.filter) limits.push(`only work items matching: ${jira.filter}`);
      if (jira.boardIds.length > 0) limits.push(`boards ${jira.boardIds.join(', ')} only`);

      targets.push({
        target: `${jira.site.name}/${jira.projectKey}`,
        source: 'jira',
        enabled: enabledKeys(jira.sync),
        disabled: disabledKeys(jira.sync),
        limits,
        tokenEnv: jira.site.tokenEnv,
        tokenPresent: jira.site.token !== null,
      });
    }
  }

  return { kind: 'config', configPath: config.configPath ?? null, targets, writesAnywhere: false };
}

function enabledKeys(options: object): string[] {
  return Object.entries(options)
    .filter(([, value]) => value === true)
    .map(([key]) => key);
}

function disabledKeys(options: object): string[] {
  return Object.entries(options)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
}
