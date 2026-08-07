import type { ReactNode } from 'react';
import { useState } from 'react';

import { api, formatRelative, parseList } from '../api.ts';
import type { Issue, IssueDocument, PullRequest, Repository, WorkflowRun } from '../api.ts';
import { Badge, Labels, Panel, StateMessage, useAsync } from '../components/common.tsx';
import { DetailPanel } from '../components/DetailPanel.tsx';

function useDocument() {
  const [selection, setSelection] = useState<(() => Promise<IssueDocument>) | null>(null);
  const [key, setKey] = useState(0);
  const { data, error, loading } = useAsync<IssueDocument | null>(
    () => (selection ? selection() : Promise.resolve(null)),
    [key],
  );

  return {
    document: selection ? data : null,
    error,
    loading: Boolean(selection) && loading,
    open: (loader: () => Promise<IssueDocument>) => {
      setSelection(() => loader);
      setKey((value) => value + 1);
    },
    close: () => {
      setSelection(null);
      setKey((value) => value + 1);
    },
  };
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
  const [repo, setRepo] = useState('');
  const [state, setState] = useState('open');
  const [search, setSearch] = useState('');
  const detail = useDocument();

  const { data, error, loading } = useAsync<Issue[]>(
    () => api.issues({ repo: repo || undefined, state, search: search || undefined, limit: '200' }),
    [repo, state, search],
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
                  onClick={() => detail.open(() => api.issue(issue.repo_full_name, issue.number))}
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
  const [repo, setRepo] = useState('');
  const [state, setState] = useState('open');
  const [search, setSearch] = useState('');
  const detail = useDocument();

  const { data, error, loading } = useAsync<PullRequest[]>(
    () => api.pulls({ repo: repo || undefined, state, search: search || undefined, limit: '200' }),
    [repo, state, search],
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
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.map((pull) => (
                <tr
                  key={`${pull.repo_full_name}#${pull.number}`}
                  onClick={() => detail.open(() => api.pull(pull.repo_full_name, pull.number))}
                >
                  <td className="muted">{pull.repo_full_name}</td>
                  <td className="right">{pull.number}</td>
                  <td>
                    {pull.title} <Labels values={parseList(pull.labels)} />
                  </td>
                  <td>
                    <Badge value={pull.merged ? 'merged' : pull.state} />
                  </td>
                  <td className="right">
                    +{pull.additions ?? 0}/-{pull.deletions ?? 0}
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
  const [repo, setRepo] = useState('');
  const [conclusion, setConclusion] = useState('');
  const detail = useDocument();

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
                <tr key={run.id} onClick={() => detail.open(() => api.workflowRun(run.id))}>
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
