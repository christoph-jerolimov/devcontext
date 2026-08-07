import type { ReactNode } from 'react';

import { api } from '../api.ts';
import type { CrossLink, IssueDocument } from '../api.ts';
import { navigate } from '../router.ts';
import { StateMessage, useAsync } from './common.tsx';

/** Where each kind of thing lives in the viewer. */
const VIEW_FOR: Record<string, string> = {
  issue: 'issues',
  pull_request: 'pulls',
  workitem: 'workitems',
};

const KIND_LABEL: Record<string, string> = {
  issue: 'issue',
  pull_request: 'pull request',
  workitem: 'work item',
};

/**
 * What to call this item in the cross link table.
 *
 * GitHub items are `owner/repo#42`, Jira items are their key — the same two
 * shapes `devcontext links` takes as an argument. Anything else (a sprint, a
 * workflow run) has no place in the graph and gets no section.
 */
export function referenceFor(document: IssueDocument): string | null {
  if (typeof document.repository === 'string' && typeof document.number === 'number') {
    return `${document.repository}#${String(document.number)}`;
  }
  return typeof document.key === 'string' ? document.key : null;
}

/**
 * High confidence first, then alphabetically.
 *
 * A key in a branch name or a title was put there deliberately; one in a
 * comment may be somebody mentioning a neighbouring ticket in passing. Sorting
 * by reference alone would mix the two together and bury the deliberate ones.
 */
export function sortLinks(links: CrossLink[]): CrossLink[] {
  return [...links].toSorted((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'high' ? -1 : 1;
    return a.ref.localeCompare(b.ref);
  });
}

function open(link: CrossLink): void {
  const params: Record<string, string> = { open: link.ref };
  // The list behind the panel has to contain the item, and a closed issue or a
  // merged pull request is not in the default "open" list.
  if (link.source !== 'jira') params['state'] = 'all';
  navigate(VIEW_FOR[link.kind] ?? 'issues', new URLSearchParams(params));
}

/**
 * What this issue, pull request or work item is connected to on the other
 * platform — the viewer's answer to `devcontext links PLAT-42`.
 *
 * The links are computed during sync by scanning branch names, titles, bodies,
 * commit messages and comments, so this is a read of `cross_links`, not a
 * fresh scan.
 */
export function CrossLinks({ reference }: { reference: string }): ReactNode {
  const { data, error, loading } = useAsync(() => api.links(reference), [reference]);

  if (loading || error) {
    return (
      <section>
        <h3>Links</h3>
        <StateMessage loading={loading} error={error} empty={false} emptyMessage="" />
      </section>
    );
  }

  // Most items reference nothing, so an empty "Links" heading would be noise.
  const links = sortLinks(data?.links ?? []);
  if (links.length === 0) return null;

  return (
    <section>
      <h3>Links ({links.length})</h3>
      <table className="table compact links">
        <tbody>
          {links.map((link) => (
            <tr key={`${link.ref}-${link.via}`} onClick={() => open(link)}>
              <td className="mono">{link.ref}</td>
              <td className="muted">{KIND_LABEL[link.kind] ?? link.kind}</td>
              <td>
                {/*
                 * `via` is the evidence: which text the reference was found
                 * in. It is what tells a deliberate link from a passing
                 * mention, so it is shown rather than hidden behind the
                 * confidence label it produces.
                 */}
                <span className={link.confidence === 'high' ? 'link-via high' : 'link-via'}>
                  {link.via}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
