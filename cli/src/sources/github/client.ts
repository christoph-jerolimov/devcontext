import type { GithubHost, SyncSettings } from '../../config/types.js';
import { CliError } from '../../util/errors.js';
import type { Logger } from '../../util/logger.js';
import type { JsonObject } from '../../util/json.js';
import { HttpClient, HttpError } from '../../sync/httpClient.js';
import type { ProgressReporter } from '../../sync/progress.js';
import { RateLimiter } from '../../sync/rateLimiter.js';

const USER_AGENT = 'devcontext-cli';

export interface GithubClientOptions {
  host: GithubHost;
  settings: SyncSettings;
  progress: ProgressReporter;
  logger: Logger;
  /** Aborts requests when the person asks the sync to stop. */
  signal?: AbortSignal;
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}

/** Thin REST client for github.com and GitHub Enterprise Server. */
export class GithubClient {
  private readonly http: HttpClient;
  private readonly rateLimiter: RateLimiter;
  readonly host: GithubHost;

  constructor(options: GithubClientOptions) {
    this.host = options.host;

    if (!options.host.token) {
      options.logger.warn(
        `No token for GitHub host "${options.host.name}" (expected in $${options.host.tokenEnv}). ` +
          'Continuing unauthenticated: private data is invisible and the rate limit is 60 requests per hour.',
      );
    }

    this.rateLimiter = new RateLimiter({
      minDelayMs: options.settings.minDelayMs,
      respectRateLimit: options.settings.respectRateLimit,
      reserve: options.settings.rateLimitReserve,
      maxWaitMs: options.settings.maxRateLimitWaitMs,
      logger: options.logger,
    });

    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
    };
    if (options.host.token) headers.authorization = `Bearer ${options.host.token}`;

    this.http = new HttpClient({
      baseUrl: options.host.apiUrl,
      headers,
      rateLimiter: this.rateLimiter,
      progress: options.progress,
      logger: options.logger,
      maxRetries: options.settings.maxRetries,
      retryBaseMs: options.settings.retryBaseMs,
      timeoutMs: options.settings.requestTimeoutMs,
      label: `GitHub (${options.host.name})`,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  get rateLimit(): RateLimitInfo {
    const state = this.rateLimiter.state;
    return { limit: state.limit, remaining: state.remaining, resetAt: state.resetAt };
  }

  private get pageSize(): number {
    return 100;
  }

  /** Yields every page of a paginated collection endpoint. */
  async *paginate(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): AsyncGenerator<JsonObject[]> {
    let url: string | null = this.http.buildUrl(path, { per_page: this.pageSize, ...query });

    while (url) {
      const response = await this.http.request<unknown>(url);
      const items = Array.isArray(response.data) ? (response.data as JsonObject[]) : [];
      yield items;
      url = nextPageUrl(response.headers.get('link'));
    }
  }

  /**
   * How many items a collection endpoint would yield, in one request.
   *
   * This is what lets the sync know the size of the job before doing it: one
   * call per resource buys an exact item count, from which every follow up
   * call it implies can be counted too.
   *
   * Null means the endpoint would not say, and the caller has to fall back to
   * discovering the size as it goes.
   */
  async countItems(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<number | null> {
    const url = this.http.buildUrl(path, { ...query, per_page: 1 });
    const response = await this.http.request<unknown>(url);

    // A few list endpoints — actions/runs, actions/workflows, the search ones —
    // wrap the array in an object and state the total outright. That is better
    // than anything the Link header can be made to say, and it is also the only
    // thing that works: an object is not an array, so counting the items on the
    // page yields nothing and a single page response has no Link header to fall
    // back on. Sizing those endpoints quietly produced zero before.
    const stated = statedTotal(response.data);
    if (stated !== null) return stated;

    const items = Array.isArray(response.data) ? response.data.length : 0;
    return totalFromLinkHeader(response.headers.get('link'), items);
  }

  async collect(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<JsonObject[]> {
    const all: JsonObject[] = [];
    for await (const page of this.paginate(path, query)) all.push(...page);
    return all;
  }

  async getRepository(owner: string, repo: string): Promise<JsonObject> {
    try {
      const response = await this.http.request<JsonObject>(`/repos/${owner}/${repo}`);
      return response.data;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw new CliError(`Repository ${owner}/${repo} was not found on ${this.host.name}.`, {
          hint: 'Check the spelling and make sure the token can read the repository.',
        });
      }
      throw error;
    }
  }

  /** Issues *and* pull requests, newest updates first, optionally since a date. */
  issues(
    owner: string,
    repo: string,
    options: { since?: string | null; state?: 'open' | 'closed' | 'all' } = {},
  ): AsyncGenerator<JsonObject[]> {
    return this.paginate(`/repos/${owner}/${repo}/issues`, {
      state: options.state ?? 'all',
      sort: 'updated',
      direction: 'asc',
      ...(options.since ? { since: options.since } : {}),
    });
  }

  /** One issue (or the issue side of a pull request) by number. */
  async issue(owner: string, repo: string, number: number): Promise<JsonObject> {
    try {
      const response = await this.http.request<JsonObject>(
        `/repos/${owner}/${repo}/issues/${number}`,
      );
      return response.data;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        throw new CliError(`${owner}/${repo}#${number} was not found on ${this.host.name}.`);
      }
      throw error;
    }
  }

  issueComments(owner: string, repo: string, issueNumber: number): Promise<JsonObject[]> {
    return this.collect(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`);
  }

  issueTimeline(owner: string, repo: string, issueNumber: number): Promise<JsonObject[]> {
    return this.collect(`/repos/${owner}/${repo}/issues/${issueNumber}/timeline`);
  }

  pullRequests(
    owner: string,
    repo: string,
    options: { state?: 'open' | 'closed' | 'all' } = {},
  ): AsyncGenerator<JsonObject[]> {
    return this.paginate(`/repos/${owner}/${repo}/pulls`, {
      state: options.state ?? 'all',
      sort: 'updated',
      direction: 'desc',
    });
  }

  async pullRequest(owner: string, repo: string, number: number): Promise<JsonObject> {
    const response = await this.http.request<JsonObject>(`/repos/${owner}/${repo}/pulls/${number}`);
    return response.data;
  }

  pullRequestReviews(owner: string, repo: string, number: number): Promise<JsonObject[]> {
    return this.collect(`/repos/${owner}/${repo}/pulls/${number}/reviews`);
  }

  pullRequestReviewComments(owner: string, repo: string, number: number): Promise<JsonObject[]> {
    return this.collect(`/repos/${owner}/${repo}/pulls/${number}/comments`);
  }

  pullRequestCommits(owner: string, repo: string, number: number): Promise<JsonObject[]> {
    return this.collect(`/repos/${owner}/${repo}/pulls/${number}/commits`);
  }

  pullRequestFiles(owner: string, repo: string, number: number): Promise<JsonObject[]> {
    return this.collect(`/repos/${owner}/${repo}/pulls/${number}/files`);
  }

  labels(owner: string, repo: string): Promise<JsonObject[]> {
    return this.collect(`/repos/${owner}/${repo}/labels`);
  }

  milestones(owner: string, repo: string): Promise<JsonObject[]> {
    return this.collect(`/repos/${owner}/${repo}/milestones`, { state: 'all' });
  }

  async workflows(owner: string, repo: string): Promise<JsonObject[]> {
    const response = await this.http.request<JsonObject>(
      `/repos/${owner}/${repo}/actions/workflows`,
      {
        query: { per_page: this.pageSize },
      },
    );
    const list = response.data?.workflows;
    return Array.isArray(list) ? (list as JsonObject[]) : [];
  }

  /** Workflow runs are wrapped in an envelope, so pagination is manual. */
  async *workflowRuns(
    owner: string,
    repo: string,
    options: { created?: string | null; perPage?: number } = {},
  ): AsyncGenerator<JsonObject[]> {
    let page = 1;
    for (;;) {
      const response = await this.http.request<JsonObject>(`/repos/${owner}/${repo}/actions/runs`, {
        query: {
          per_page: options.perPage ?? this.pageSize,
          page,
          ...(options.created ? { created: `>=${options.created.slice(0, 10)}` } : {}),
        },
      });
      const runs = Array.isArray(response.data?.workflow_runs)
        ? (response.data.workflow_runs as JsonObject[])
        : [];
      if (runs.length === 0) return;
      yield runs;
      if (runs.length < (options.perPage ?? this.pageSize)) return;
      page += 1;
    }
  }

  async workflowRunJobs(owner: string, repo: string, runId: number): Promise<JsonObject[]> {
    const jobs: JsonObject[] = [];
    let page = 1;
    for (;;) {
      const response = await this.http.request<JsonObject>(
        `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`,
        { query: { per_page: this.pageSize, page, filter: 'all' } },
      );
      const items = Array.isArray(response.data?.jobs) ? (response.data.jobs as JsonObject[]) : [];
      jobs.push(...items);
      if (items.length < this.pageSize) return jobs;
      page += 1;
    }
  }

  /** Plain text log of a single job; `null` when GitHub expired the logs. */
  async jobLogs(owner: string, repo: string, jobId: number): Promise<string | null> {
    const response = await this.http.request<string>(
      `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
      {
        responseType: 'text',
        allowStatus: [404, 410],
        headers: { accept: 'application/vnd.github+json' },
      },
    );
    if (response.status === 404 || response.status === 410) return null;
    return typeof response.data === 'string' ? response.data : null;
  }
}

/** Extracts the URL of one `rel` from a GitHub `Link` header. */
export function linkUrl(linkHeader: string | null, rel: string): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match && match[2] === rel) return match[1] ?? null;
  }
  return null;
}

export function nextPageUrl(linkHeader: string | null): string | null {
  return linkUrl(linkHeader, 'next');
}

/**
 * How many items a collection holds, from its `Link` header.
 *
 * Asked for one item per page, the last page number *is* the item count — so
 * a single request answers "how many are there" exactly, without walking the
 * collection. GitHub omits the header entirely when everything fits on one
 * page, which at this page size means zero or one item, and the body says
 * which.
 *
 * Returns null when the header is present but unreadable, so a caller can tell
 * "no idea" from "none".
 */
/** `total_count` from an object shaped list response, when it carries one. */
export function statedTotal(data: unknown): number | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const total = (data as Record<string, unknown>)['total_count'];
  return typeof total === 'number' && Number.isInteger(total) && total >= 0 ? total : null;
}

export function totalFromLinkHeader(linkHeader: string | null, itemsOnPage: number): number | null {
  if (!linkHeader) return itemsOnPage;

  const last = linkUrl(linkHeader, 'last');
  if (!last) {
    // A `next` with no `last` happens on cursor paginated endpoints, where the
    // total is genuinely unknowable up front.
    return linkUrl(linkHeader, 'next') ? null : itemsOnPage;
  }

  const page = new URL(last, 'https://api.github.com').searchParams.get('page');
  const parsed = Number(page);
  return page !== null && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
