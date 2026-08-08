/**
 * Finding the references that connect GitHub and Jira.
 *
 * Neither platform records the other side reliably, but people write the
 * reference down anyway: in the branch name, the pull request title, a commit
 * message, a comment. Extracting those is the one thing a tool holding both
 * datasets can do that neither platform can.
 */

/** A Jira key like `PLAT-42`. Filtered against the known project keys. */
const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;

/** `owner/repo#123`. */
const GITHUB_QUALIFIED = /\b([\w.-]+)\/([\w.-]+)#(\d{1,7})\b/g;

/** A github.com issue or pull request URL, including Enterprise hosts. */
const GITHUB_URL = /https?:\/\/[\w.-]+\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d{1,7})\b/g;

export interface JiraReference {
  key: string;
  /** The characters that produced the match, useful for explaining a link. */
  match: string;
}

export interface GithubReference {
  repo: string;
  number: number;
  match: string;
}

/**
 * Jira keys in `text`, restricted to `projectKeys`.
 *
 * The restriction is what keeps this useful: `UTF-8`, `COVID-19`, `SHA-256`
 * and `HTTP-2` all look exactly like a Jira key, so matching without knowing
 * the projects produces mostly noise.
 */
export function extractJiraKeys(
  text: string | null | undefined,
  projectKeys: Iterable<string>,
): JiraReference[] {
  if (!text) return [];

  const known = new Set([...projectKeys].map((key) => key.toUpperCase()));
  if (known.size === 0) return [];

  const found = new Map<string, JiraReference>();

  for (const match of text.matchAll(JIRA_KEY)) {
    const project = (match[1] ?? '').toUpperCase();
    if (!known.has(project)) continue;
    const key = `${project}-${match[2]}`;
    if (!found.has(key)) found.set(key, { key, match: match[0] });
  }

  // Branch names carry the key in shapes the word-boundary regex misses:
  // feature/plat-42-speed-up, PLAT_42, bugfix/plat42.
  for (const project of known) {
    const relaxed = new RegExp(`${project}[-_ ]?(\\d{1,7})`, 'gi');
    for (const match of text.matchAll(relaxed)) {
      const key = `${project}-${match[1]}`;
      if (!found.has(key)) found.set(key, { key, match: match[0] });
    }
  }

  return [...found.values()];
}

/**
 * GitHub issue and pull request references in `text`.
 *
 * Only qualified forms are accepted (`owner/repo#12` or a URL). A bare `#12`
 * is far too common in prose to attribute to a repository with any confidence.
 */
export function extractGithubReferences(text: string | null | undefined): GithubReference[] {
  if (!text) return [];

  const found = new Map<string, GithubReference>();

  const add = (owner: string, repo: string, number: string, match: string) => {
    const parsed = Number(number);
    if (!Number.isInteger(parsed) || parsed <= 0) return;
    const key = `${owner}/${repo}#${parsed}`;
    if (!found.has(key)) found.set(key, { repo: `${owner}/${repo}`, number: parsed, match });
  };

  for (const match of text.matchAll(GITHUB_URL)) {
    add(match[1] ?? '', match[2] ?? '', match[3] ?? '', match[0]);
  }
  for (const match of text.matchAll(GITHUB_QUALIFIED)) {
    add(match[1] ?? '', match[2] ?? '', match[3] ?? '', match[0]);
  }

  return [...found.values()];
}

/**
 * How much a reference is worth trusting.
 *
 * A key in the branch name or the title was put there on purpose. A key in a
 * comment might be someone mentioning a neighbouring ticket in passing.
 */
export type LinkConfidence = 'high' | 'medium';

export const CONFIDENCE_BY_SOURCE: Record<string, LinkConfidence> = {
  branch: 'high',
  title: 'high',
  'jira-field': 'high',
  // GitHub resolved this one itself, from its own timeline: there is no
  // reference to have misread.
  timeline: 'high',
  // A closing keyword is the syntax GitHub acts on, not a turn of phrase.
  closes: 'high',
  body: 'medium',
  commit: 'medium',
  comment: 'medium',
};

export function confidenceFor(via: string): LinkConfidence {
  return CONFIDENCE_BY_SOURCE[via] ?? 'medium';
}
