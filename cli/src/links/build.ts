import type { Database } from '../db/database.js';
import { nowIso } from '../util/time.js';
import { confidenceFor, extractGithubReferences, extractJiraKeys } from './extract.js';

export interface CrossLinkRow {
  uid: string;
  from_source: string;
  from_kind: string;
  from_ref: string;
  to_source: string;
  to_kind: string;
  to_ref: string;
  via: string;
  detail: string | null;
  confidence: string;
  synced_at: string;
}

export interface BuildLinksResult {
  /** Links written, i.e. the size of the table afterwards. */
  links: number;
  /** How many came from each place a reference can appear. */
  byVia: Record<string, number>;
  /** Jira keys that were referenced but are not (yet) synced. */
  danglingJiraKeys: string[];
  /** GitHub references that point at something not synced. */
  danglingGithubRefs: string[];
}

interface Candidate {
  fromSource: 'github' | 'jira';
  fromKind: 'issue' | 'pull_request' | 'workitem';
  fromRef: string;
  toSource: 'github' | 'jira';
  toKind: 'issue' | 'pull_request' | 'workitem';
  toRef: string;
  via: string;
  detail: string;
}

/**
 * Rebuilds the cross reference table from the synced text.
 *
 * It is a full rebuild rather than an incremental update on purpose: the input
 * is text that already lives in the database, so recomputing costs one pass and
 * removes any chance of stale links surviving an edited title or branch.
 */
export function buildCrossLinks(db: Database): BuildLinksResult {
  const syncedAt = nowIso();

  const projectKeys = db
    .all<{ key: string }>('SELECT DISTINCT project_key AS key FROM jira_workitems')
    .map((row) => row.key)
    .concat(db.all<{ key: string }>('SELECT key FROM jira_projects').map((row) => row.key))
    .filter((key) => typeof key === 'string' && key !== '');

  const knownProjects = new Set(projectKeys.map((key) => key.toUpperCase()));
  const knownWorkitems = new Set(
    db.all<{ key: string }>('SELECT key FROM jira_workitems').map((row) => row.key.toUpperCase()),
  );
  const knownGithub = new Set([
    ...db
      .all<{ repo: string; number: number }>(
        'SELECT repo_full_name AS repo, number FROM gh_issues WHERE is_pull_request = 0',
      )
      .map((row) => `${row.repo}#${row.number}`),
    ...db
      .all<{ repo: string; number: number }>(
        'SELECT repo_full_name AS repo, number FROM gh_pull_requests',
      )
      .map((row) => `${row.repo}#${row.number}`),
  ]);

  const candidates: Candidate[] = [];
  const danglingJira = new Set<string>();
  const danglingGithub = new Set<string>();

  const addJiraTargets = (
    from: Pick<Candidate, 'fromSource' | 'fromKind' | 'fromRef'>,
    text: string | null,
    via: string,
  ): void => {
    for (const reference of extractJiraKeys(text, knownProjects)) {
      if (!knownWorkitems.has(reference.key)) {
        danglingJira.add(reference.key);
        continue;
      }
      candidates.push({
        ...from,
        toSource: 'jira',
        toKind: 'workitem',
        toRef: reference.key,
        via,
        detail: reference.match,
      });
    }
  };

  // --- GitHub pull requests -------------------------------------------------
  const pullRequests = db.all<{
    repo: string;
    number: number;
    title: string | null;
    body: string | null;
    head_ref: string | null;
    id: number;
  }>('SELECT repo_full_name AS repo, number, title, body, head_ref, id FROM gh_pull_requests');

  for (const pull of pullRequests) {
    const from = {
      fromSource: 'github' as const,
      fromKind: 'pull_request' as const,
      fromRef: `${pull.repo}#${pull.number}`,
    };
    addJiraTargets(from, pull.head_ref, 'branch');
    addJiraTargets(from, pull.title, 'title');
    addJiraTargets(from, pull.body, 'body');

    for (const commit of db.all<{ message: string | null }>(
      'SELECT message FROM gh_commits WHERE pr_id = ?',
      [pull.id],
    )) {
      addJiraTargets(from, commit.message, 'commit');
    }
  }

  // --- GitHub issues --------------------------------------------------------
  for (const issue of db.all<{
    repo: string;
    number: number;
    title: string | null;
    body: string | null;
  }>(
    'SELECT repo_full_name AS repo, number, title, body FROM gh_issues WHERE is_pull_request = 0',
  )) {
    const from = {
      fromSource: 'github' as const,
      fromKind: 'issue' as const,
      fromRef: `${issue.repo}#${issue.number}`,
    };
    addJiraTargets(from, issue.title, 'title');
    addJiraTargets(from, issue.body, 'body');
  }

  // --- Comments on both ------------------------------------------------------
  for (const comment of db.all<{ repo: string; number: number; body: string | null }>(
    'SELECT repo_full_name AS repo, issue_number AS number, body FROM gh_comments WHERE body IS NOT NULL',
  )) {
    const ref = `${comment.repo}#${comment.number}`;
    const kind = knownGithub.has(ref) ? guessKind(db, comment.repo, comment.number) : 'issue';
    addJiraTargets({ fromSource: 'github', fromKind: kind, fromRef: ref }, comment.body, 'comment');
  }

  // --- Jira work items pointing back at GitHub -------------------------------
  const workitems = db.all<{
    key: string;
    id: string;
    summary: string | null;
    description: string | null;
  }>('SELECT key, id, summary, description FROM jira_workitems');

  for (const workitem of workitems) {
    const from = {
      fromSource: 'jira' as const,
      fromKind: 'workitem' as const,
      fromRef: workitem.key,
    };

    const scan = (text: string | null, via: string): void => {
      for (const reference of extractGithubReferences(text)) {
        const ref = `${reference.repo}#${reference.number}`;
        if (!knownGithub.has(ref)) {
          danglingGithub.add(ref);
          continue;
        }
        candidates.push({
          ...from,
          toSource: 'github',
          toKind: guessKind(db, reference.repo, reference.number),
          toRef: ref,
          via,
          detail: reference.match,
        });
      }
    };

    scan(workitem.summary, 'title');
    scan(workitem.description, 'body');

    for (const comment of db.all<{ body: string | null }>(
      'SELECT body FROM jira_comments WHERE workitem_id = ?',
      [workitem.id],
    )) {
      scan(comment.body, 'comment');
    }
  }

  // --- Write ----------------------------------------------------------------
  const byVia: Record<string, number> = {};
  const rows = new Map<string, CrossLinkRow>();

  for (const candidate of candidates) {
    const uid = `${candidate.fromRef}|${candidate.toRef}|${candidate.via}`;
    if (rows.has(uid)) continue;
    rows.set(uid, {
      uid,
      from_source: candidate.fromSource,
      from_kind: candidate.fromKind,
      from_ref: candidate.fromRef,
      to_source: candidate.toSource,
      to_kind: candidate.toKind,
      to_ref: candidate.toRef,
      via: candidate.via,
      detail: candidate.detail,
      confidence: confidenceFor(candidate.via),
      synced_at: syncedAt,
    });
    byVia[candidate.via] = (byVia[candidate.via] ?? 0) + 1;
  }

  db.transaction(() => {
    db.run('DELETE FROM cross_links');
    for (const row of rows.values()) db.upsert('cross_links', { ...row });
  });

  return {
    links: rows.size,
    byVia,
    danglingJiraKeys: [...danglingJira].toSorted(),
    danglingGithubRefs: [...danglingGithub].toSorted(),
  };
}

function guessKind(db: Database, repo: string, number: number): 'issue' | 'pull_request' {
  const isPull = db.get<{ number: number }>(
    'SELECT number FROM gh_pull_requests WHERE repo_full_name = ? AND number = ?',
    [repo, number],
  );
  return isPull ? 'pull_request' : 'issue';
}
