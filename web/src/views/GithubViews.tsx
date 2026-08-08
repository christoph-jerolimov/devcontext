import type { ReactNode } from 'react';

import { api, formatRelative, parseList } from '../api.ts';
import type { Issue, PullRequest, Repository, WorkflowRun } from '../api.ts';
import {
  Badge,
  Contributors,
  Labels,
  Panel,
  StateMessage,
  useAsync,
  useSelection,
} from '../components/common.tsx';
import { DetailPanel } from '../components/DetailPanel.tsx';
import { usePeopleFilter } from '../components/PeopleFilter.tsx';
import { useUrlState } from '../router.ts';

/** `acme/platform#42` — the reference the URL carries and the API needs. */
function splitReference(reference: string): [string, number] | null {
  const hash = reference.lastIndexOf('#');
  if (hash === -1) return null;
  const number = Number(reference.slice(hash + 1));
  return Number.isFinite(number) ? [reference.slice(0, hash), number] : null;
}

function RepoFilter({
  repos,
  value,
  onChange,
}: {
  repos: Repository[];
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">all repositories</option>
      {repos.map((repo) => (
        <option key={repo.full_name} value={repo.full_name}>
          {repo.full_name}
        </option>
      ))}
    </select>
  );
}

export function IssuesView({ repos }: { repos: Repository[] }): ReactNode {
  const [repo, setRepo] = useUrlState('repo');
  // Every state by default, as pull requests do: a closed issue is the normal
  // end of one, and a list that hides them reads as if nothing was finished.
  const [state, setState] = useUrlState('state', 'all');
  const [search, setSearch] = useUrlState('search');
  const people = usePeopleFilter();

  const detail = useSelection((reference) => {
    const parts = splitReference(reference);
    if (!parts) throw new Error(`Not an issue reference: ${reference}`);
    return api.issue(parts[0], parts[1]);
  });

  const { data, error, loading } = useAsync<Issue[]>(
    () =>
      api.issues({
        repo: repo || undefined,
        state,
        search: search || undefined,
        ...people.params,
        limit: '200',
      }),
    [repo, state, search, people.key],
  );

  return (
    <div className="split">
      <Panel
        title="Issues"
        actions={
          <>
            <RepoFilter repos={repos} value={repo} onChange={setRepo} />
            <select value={state} onChange={(event) => setState(event.target.value)}>
              <option value="open">open</option>
              <option value="closed">closed</option>
              <option value="all">all</option>
            </select>
            {people.control}
            <input
              type="search"
              placeholder="search title and body"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </>
        }
      >
        <StateMessage
          loading={loading}
          error={error}
          empty={(data ?? []).length === 0}
          emptyMessage="No issues match these filters."
        />
        {data && data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>#</th>
                <th>Title</th>
                <th>State</th>
                <th>Author</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.map((issue) => (
                <tr
                  key={`${issue.repo_full_name}#${issue.number}`}
                  onClick={() => detail.open(`${issue.repo_full_name}#${issue.number}`)}
                >
                  <td className="muted">{issue.repo_full_name}</td>
                  <td className="right">{issue.number}</td>
                  <td>
                    {issue.title} <Labels values={parseList(issue.labels)} />
                  </td>
                  <td>
                    <Badge value={issue.state} />
                  </td>
                  <td>{issue.author}</td>
                  <td className="muted">{formatRelative(issue.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>

      <DetailPanel
        document={detail.document}
        loading={detail.loading}
        error={detail.error}
        onClose={detail.close}
      />
    </div>
  );
}

export function PullRequestsView({ repos }: { repos: Repository[] }): ReactNode {
  const [repo, setRepo] = useUrlState('repo');
  // All states by default: a merged pull request is the normal
  // end of one, and hiding them makes the list read as if nothing shipped.
  const [state, setState] = useUrlState('state', 'all');
  const [search, setSearch] = useUrlState('search');
  const people = usePeopleFilter();

  const detail = useSelection((reference) => {
    const parts = splitReference(reference);
    if (!parts) throw new Error(`Not a pull request reference: ${reference}`);
    return api.pull(parts[0], parts[1]);
  });

  const { data, error, loading } = useAsync<PullRequest[]>(
    () =>
      api.pulls({
        repo: repo || undefined,
        state,
        search: search || undefined,
        ...people.params,
        limit: '200',
      }),
    [repo, state, search, people.key],
  );

  return (
    <div className="split">
      <Panel
        title="Pull requests"
        actions={
          <>
            <RepoFilter repos={repos} value={repo} onChange={setRepo} />
            <select value={state} onChange={(event) => setState(event.target.value)}>
              <option value="open">open</option>
              <option value="closed">closed</option>
              <option value="all">all</option>
            </select>
            {people.control}
            <input
              type="search"
              placeholder="search title and body"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </>
        }
      >
        <StateMessage
          loading={loading}
          error={error}
          empty={(data ?? []).length === 0}
          emptyMessage="No pull requests match these filters."
        />
        {data && data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>#</th>
                <th>Title</th>
                <th>State</th>
                <th>Changes</th>
                <th>People</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.map((pull) => (
                <tr
                  key={`${pull.repo_full_name}#${pull.number}`}
                  onClick={() => detail.open(`${pull.repo_full_name}#${pull.number}`)}
                >
                  <td className="muted">{pull.repo_full_name}</td>
                  <td className="right">{pull.number}</td>
                  <td>
                    {pull.title} <Labels values={parseList(pull.labels)} />
                  </td>
                  <td>
                    {/*
                     * A pull request closed without merging shares GitHub's
                     * `closed` state with a merged one, so it needs its own
                     * kind to read differently.
                     */}
                    <Badge
                      value={pull.merged ? 'merged' : pull.state}
                      kind={!pull.merged && pull.state === 'closed' ? 'unmerged' : undefined}
                    />
                  </td>
                  <td className="right">
                    <span className="changes-added">+{pull.additions ?? 0}</span>
                    <span className="muted">/</span>
                    <span className="changes-removed">-{pull.deletions ?? 0}</span>
                  </td>
                  {/* Author and reviewers together: on a pull request the
                      reviewers are usually the names somebody scanning the
                      list is after, and no other column can show them. */}
                  <td>
                    <Contributors people={pull.contributors} />
                  </td>
                  <td className="muted">{formatRelative(pull.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>

      <DetailPanel
        document={detail.document}
        loading={detail.loading}
        error={detail.error}
        onClose={detail.close}
      />
    </div>
  );
}

export function WorkflowRunsView({ repos }: { repos: Repository[] }): ReactNode {
  const [repo, setRepo] = useUrlState('repo');
  const [conclusion, setConclusion] = useUrlState('conclusion');
  const detail = useSelection((reference) => api.workflowRun(Number(reference)));

  const { data, error, loading } = useAsync<WorkflowRun[]>(
    () =>
      api.workflowRuns({
        repo: repo || undefined,
        conclusion: conclusion || undefined,
        limit: '200',
      }),
    [repo, conclusion],
  );

  return (
    <div className="split">
      <Panel
        title="Workflow runs"
        actions={
          <>
            <RepoFilter repos={repos} value={repo} onChange={setRepo} />
            <select value={conclusion} onChange={(event) => setConclusion(event.target.value)}>
              <option value="">any conclusion</option>
              <option value="success">success</option>
              <option value="failure">failure</option>
              <option value="cancelled">cancelled</option>
              <option value="skipped">skipped</option>
            </select>
          </>
        }
      >
        <StateMessage
          loading={loading}
          error={error}
          empty={(data ?? []).length === 0}
          emptyMessage="No workflow runs match these filters."
        />
        {data && data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Repository</th>
                <th>Workflow</th>
                <th>Run</th>
                <th>Event</th>
                <th>Branch</th>
                <th>Conclusion</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.map((run) => (
                <tr key={run.id} onClick={() => detail.open(String(run.id))}>
                  <td className="muted">{run.repo_full_name}</td>
                  <td>{run.workflow_name}</td>
                  <td className="right">{run.run_number}</td>
                  <td>{run.event}</td>
                  <td>{run.head_branch}</td>
                  <td>
                    <Badge value={run.conclusion ?? run.status} />
                  </td>
                  <td className="muted">{formatRelative(run.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>

      <DetailPanel
        document={detail.document}
        loading={detail.loading}
        error={detail.error}
        onClose={detail.close}
      />
    </div>
  );
}
