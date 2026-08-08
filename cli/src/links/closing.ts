/**
 * Which issue a pull request says it fixes.
 *
 * Distinct from a mention, and the distinction is the whole value. A pull
 * request that says "see also #12" and one that says "fixes #12" both contain
 * the string `#12`, and only the second means the issue is finished when the
 * pull request lands. Flattening them makes "what shipped in this release"
 * unanswerable.
 *
 * ## Why bare `#12` is accepted here and nowhere else
 *
 * `extractGithubReferences` deliberately refuses a bare `#12`, because in
 * ordinary prose it is far too common to attribute to a repository — a comment
 * saying "step #3 failed" would link to an unrelated issue.
 *
 * A closing keyword removes that problem. `fixes #12` is not something anybody
 * writes by accident, it is the exact syntax GitHub itself acts on, and the
 * repository is unambiguous: GitHub only closes issues in the pull request's
 * own repository through a bare reference. So the keyword is what licenses the
 * bare form, and the keyword has to be immediately before it.
 */

/** The words GitHub itself acts on. Anything else is a mention. */
const KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
];

/**
 * `fixes #12`, `Fixes owner/repo#12`, `resolved https://github.com/o/r/issues/12`.
 *
 * The separator allows a colon and whitespace, which people write, and nothing
 * else — "fixes the thing in #12" is prose about an issue rather than a promise
 * to close it, and GitHub does not act on it either.
 */
const CLOSING = new RegExp(
  String.raw`\b(${KEYWORDS.join('|')})\b\s*:?\s+` +
    String.raw`(?:https?://(?:www\.)?github\.com/([\w.-]+)/([\w.-]+)/(?:issues|pull)/(\d{1,9})` +
    String.raw`|([\w.-]+)/([\w.-]+)#(\d{1,9})` +
    String.raw`|#(\d{1,9}))`,
  'gi',
);

export interface ClosingReference {
  /** Repository the reference points at; the pull request's own when bare. */
  repo: string;
  number: number;
  /** The keyword as written, so the row can say what produced it. */
  keyword: string;
  match: string;
}

/**
 * Every "fixes #12" in `text`, resolved against the repository it was written
 * in.
 *
 * `ownRepo` is required rather than optional: a bare `#12` means nothing
 * without it, and defaulting to some other repository would produce links that
 * point at the wrong project while looking entirely ordinary.
 */
export function extractClosingReferences(
  text: string | null | undefined,
  ownRepo: string,
): ClosingReference[] {
  if (!text) return [];

  const found = new Map<string, ClosingReference>();

  for (const match of text.matchAll(CLOSING)) {
    const keyword = (match[1] ?? '').toLowerCase();
    const urlRepo = match[2] && match[3] ? `${match[2]}/${match[3]}` : null;
    const qualifiedRepo = match[5] && match[6] ? `${match[5]}/${match[6]}` : null;
    const number = Number(match[4] ?? match[7] ?? match[8]);

    if (!Number.isInteger(number) || number <= 0) continue;

    const repo = urlRepo ?? qualifiedRepo ?? ownRepo;
    const key = `${repo}#${String(number)}`;
    // First mention wins, so "fixes #12, fixes #12" is one link rather than
    // two identical ones.
    if (!found.has(key)) found.set(key, { repo, number, keyword, match: match[0] });
  }

  return [...found.values()];
}
