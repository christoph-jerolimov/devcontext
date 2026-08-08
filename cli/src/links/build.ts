import type { Database } from '../db/database.js';
import { nowIso } from '../util/time.js';
import { extractClosingReferences } from './closing.js';
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

  /**
   * A GitHub item pointing at another GitHub item.
   *
   * Kept separate from the Jira side because the failure mode is different:
   * a Jira key is distinctive enough to spot anywhere, and an issue number is
   * not, so every one of these has to come from somewhere that means it.
   */
  const addGithubTarget = (
    from: Pick<Candidate, 'fromSource' | 'fromKind' | 'fromRef'>,
    ref: string,
    via: string,
    detail: string,
  ): void => {
    if (!knownGithub.has(ref)) {
      danglingGithub.add(ref);
      return;
    }
    // A pull request that says "fixes" its own number is a typo, not a link,
    // and one drawn on a diagram is a loop.
    if (ref === from.fromRef) return;

    const [repo = '', number = ''] = ref.split('#');
    candidates.push({
      ...from,
      toSource: 'github',
      toKind: guessKind(db, repo, Number(number)),
      toRef: ref,
      via,
      detail,
    });
  };

  /*
   * What a pull request says it fixes.
   *
   * The relation the whole feature is about: "fixes #12" means the issue is
   * finished when this lands, which "mentions #12" does not. Read from the
   * body with the closing keyword required — see closing.ts for why the bare
   * form is safe here and refused everywhere else.
   */
  for (const pull of pullRequests) {
    const from = {
      fromSource: 'github' as const,
      fromKind: 'pull_request' as const,
      fromRef: `${pull.repo}#${pull.number}`,
    };
    for (const closing of extractClosingReferences(pull.body, pull.repo)) {
      addGithubTarget(from, `${closing.repo}#${String(closing.number)}`, 'closes', closing.match);
    }
  }

  /*
   * What GitHub itself already worked out.
   *
   * A `cross-referenced` timeline event on an issue records that something
   * mentioned it, with the referring item attached — GitHub resolved the
   * reference, so there is nothing here to guess at and no bare number to
   * misread. The payload is already in `gh_events.raw`, synced with the
   * timeline and until now never read, so this costs no API call.
   */
  for (const event of db.all<{ repo: string; number: number; raw: string }>(
    `SELECT repo_full_name AS repo, issue_number AS number, raw FROM gh_events
      WHERE event IN ('cross-referenced', 'connected')`,
  )) {
    const source = crossReferenceSource(event.raw, event.repo);
    if (source === null) continue;

    // The event sits on the item that was mentioned, and names the one that
    // did the mentioning — so the link runs from the source towards this row.
    addGithubTarget(
      {
        fromSource: 'github',
        fromKind: source.isPullRequest ? 'pull_request' : 'issue',
        fromRef: source.ref,
      },
      `${event.repo}#${String(event.number)}`,
      'timeline',
      source.isPullRequest ? 'referenced by a pull request' : 'referenced by an issue',
    );
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

/**
 * The item that produced a `cross-referenced` timeline event.
 *
 * GitHub attaches the referring item under `source.issue`, having already
 * resolved which repository and which number it is — which is the reason to
 * prefer this over reading the same reference out of prose. A pull request is
 * distinguished from an issue by the presence of a `pull_request` object,
 * exactly as it is everywhere else in this API.
 *
 * Returns null rather than guessing when the payload is not the shape
 * expected: an event whose source cannot be identified is not a link, and
 * inventing one from half a payload is how a wrong link gets in.
 */
export function crossReferenceSource(
  raw: string,
  fallbackRepo: string,
): { ref: string; isPullRequest: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const source = (parsed as { source?: { issue?: Record<string, unknown> } }).source?.issue;
  if (!source) return null;

  const number = source['number'];
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;

  const repository = source['repository'] as { full_name?: unknown } | undefined;
  const repo = typeof repository?.full_name === 'string' ? repository.full_name : fallbackRepo;

  return { ref: `${repo}#${String(number)}`, isPullRequest: source['pull_request'] !== undefined };
}

function guessKind(db: Database, repo: string, number: number): 'issue' | 'pull_request' {
  const isPull = db.get<{ number: number }>(
    'SELECT number FROM gh_pull_requests WHERE repo_full_name = ? AND number = ?',
    [repo, number],
  );
  return isPull ? 'pull_request' : 'issue';
}
