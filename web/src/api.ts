/**
 * Typed access to the JSON API that `devcontext web` serves.
 *
 * The payload types live in `@devcontext/shared` — the same declarations the
 * server's handlers are compiled against — so what the viewer expects and
 * what the server sends cannot drift apart. This module re-exports them for
 * the components and keeps the one thing that is the viewer's own business:
 * how to fetch.
 */

import type {
  ActivityResponse,
  BurndownResponse,
  ClosedResponse,
  DigestResponse,
  HistoryResponse,
  InsightsResponse,
  IssueDocument,
  Issue,
  LinksResponse,
  PullRequest,
  Repository,
  RunsResponse,
  SearchHit,
  Sprint,
  StatusResponse,
  StatusTimesResponse,
  TicketContainer,
  TicketsResponse,
  TicketType,
  VelocityResponse,
  Workitem,
  WorkitemTree,
  WorkflowRun,
} from '@devcontext/shared';

export type {
  ActivityEvent,
  ActivityResponse,
  BurndownDay,
  BurndownResponse,
  ClosedOnDay,
  ClosedResponse,
  Contributor,
  CrossLink,
  DigestEntry,
  DigestResponse,
  Distribution,
  HistoryResponse,
  InsightsResponse,
  Issue,
  IssueDocument,
  LinksResponse,
  OpenOnDay,
  PersonOption,
  PullRequest,
  Repository,
  RunsOnDay,
  RunsResponse,
  SearchHit,
  Sprint,
  StatusResponse,
  StatusTimesResponse,
  SyncProgress,
  SyncRun,
  SyncState,
  TeamOption,
  Ticket,
  TicketContainer,
  TicketsResponse,
  TicketType,
  TreeNode,
  TreeSummary,
  VelocityResponse,
  Workitem,
  WorkitemTree,
  WorkflowRun,
} from '@devcontext/shared';

export class ApiError extends Error {}

async function request<T>(
  path: string,
  params: Record<string, string | undefined> = {},
): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Request failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  status: () => request<StatusResponse>('/api/status'),
  repos: () => request<Repository[]>('/api/github/repos'),
  issues: (params: Record<string, string | undefined>) =>
    request<Issue[]>('/api/github/issues', params),
  issue: (repo: string, number: number) =>
    request<IssueDocument>(`/api/github/issues/${repo}/${number}`),
  pulls: (params: Record<string, string | undefined>) =>
    request<PullRequest[]>('/api/github/pulls', params),
  pull: (repo: string, number: number) =>
    request<IssueDocument>(`/api/github/pulls/${repo}/${number}`),
  workflowRuns: (params: Record<string, string | undefined>) =>
    request<WorkflowRun[]>('/api/github/runs', params),
  workflowRun: (id: number) => request<IssueDocument>(`/api/github/runs/${id}`),
  history: (params: Record<string, string | undefined>) =>
    request<HistoryResponse>('/api/history', params),
  closedPerDay: (params: Record<string, string | undefined>) =>
    request<ClosedResponse>('/api/history/closed', params),
  runsPerDay: (params: Record<string, string | undefined>) =>
    request<RunsResponse>('/api/history/runs', params),
  activity: (params: Record<string, string | undefined>) =>
    request<ActivityResponse>('/api/activity', params),
  tickets: (params: Record<string, string | undefined>) =>
    request<TicketsResponse>('/api/tickets', params),
  ticketTypes: (params: Record<string, string | undefined>) =>
    request<TicketType[]>('/api/tickets/types', params),
  ticketContainers: (params: Record<string, string | undefined>) =>
    request<TicketContainer[]>('/api/tickets/containers', params),
  workitems: (params: Record<string, string | undefined>) =>
    request<Workitem[]>('/api/jira/workitems', params),
  workitem: (key: string) => request<IssueDocument>(`/api/jira/workitems/${key}`),
  tree: (key: string, params: Record<string, string | undefined> = {}) =>
    request<WorkitemTree>(`/api/jira/tree/${encodeURIComponent(key)}`, params),
  sprints: (params: Record<string, string | undefined>) =>
    request<Sprint[]>('/api/jira/sprints', params),
  sprint: (id: number) => request<IssueDocument>(`/api/jira/sprints/${id}`),
  burndown: (sprint: number) =>
    request<BurndownResponse>(`/api/insights/burndown/${String(sprint)}`),
  velocity: (params: Record<string, string | undefined>) =>
    request<VelocityResponse>('/api/insights/velocity', params),
  statusTimes: (params: Record<string, string | undefined>) =>
    request<StatusTimesResponse>('/api/insights/status-time', params),
  insights: (params: Record<string, string | undefined>) =>
    request<InsightsResponse>('/api/insights', params),
  digest: (params: Record<string, string | undefined>) =>
    request<DigestResponse>('/api/digest', params),
  search: (params: Record<string, string | undefined>) =>
    request<SearchHit[]>('/api/search', params),
  links: (reference: string) =>
    request<LinksResponse>(`/api/links/${reference.split('/').map(encodeURIComponent).join('/')}`),
};

export function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return String(value);
  const diff = Date.now() - then;
  const units: Array<[number, string]> = [
    [31_536_000_000, 'y'],
    [2_592_000_000, 'mo'],
    [604_800_000, 'w'],
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
  ];
  for (const [ms, suffix] of units) {
    if (Math.abs(diff) >= ms) {
      const amount = Math.floor(Math.abs(diff) / ms);
      return diff >= 0 ? `${amount}${suffix} ago` : `in ${amount}${suffix}`;
    }
  }
  return 'just now';
}
