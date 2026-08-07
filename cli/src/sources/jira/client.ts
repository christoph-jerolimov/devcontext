import type { JiraSite, SyncSettings } from '../../config/types.js';
import { CliError } from '../../util/errors.js';
import type { Logger } from '../../util/logger.js';
import { arr, bool, num, str } from '../../util/json.js';
import type { JsonObject } from '../../util/json.js';
import { HttpClient, HttpError } from '../../sync/httpClient.js';
import type { ProgressReporter } from '../../sync/progress.js';
import { RateLimiter } from '../../sync/rateLimiter.js';

export interface JiraClientOptions {
  site: JiraSite;
  settings: SyncSettings;
  progress: ProgressReporter;
  logger: Logger;
}

export interface JiraSearchPage {
  issues: JsonObject[];
  /** Total number of matching issues, when the API reports it. */
  total: number | null;
  isLast: boolean;
  nextPageToken: string | null;
  startAt: number;
}

/** REST client for Jira Cloud and Jira Data Center (API v2 and v3). */
export class JiraClient {
  private readonly http: HttpClient;
  private readonly rateLimiter: RateLimiter;
  readonly site: JiraSite;
  /** Cloud replaced `/search` with `/search/jql`; detected on first use. */
  private useJqlSearchEndpoint: boolean | null = null;

  constructor(options: JiraClientOptions) {
    this.site = options.site;

    if (!options.site.token) {
      throw new CliError(
        `No API token for the Jira site "${options.site.name}" (expected in $${options.site.tokenEnv}).`,
        {
          hint: 'Create a token at https://id.atlassian.com/manage-profile/security/api-tokens and export it.',
        },
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
      accept: 'application/json',
      'user-agent': 'devcontext-cli',
      authorization: buildAuthorizationHeader(options.site),
    };

    this.http = new HttpClient({
      baseUrl: options.site.baseUrl,
      headers,
      rateLimiter: this.rateLimiter,
      progress: options.progress,
      logger: options.logger,
      maxRetries: options.settings.maxRetries,
      retryBaseMs: options.settings.retryBaseMs,
      timeoutMs: options.settings.requestTimeoutMs,
      label: `Jira (${options.site.name})`,
    });
  }

  private get api(): string {
    return `/rest/api/${this.site.apiVersion}`;
  }

  async project(projectKey: string): Promise<JsonObject> {
    try {
      const response = await this.http.request<JsonObject>(`${this.api}/project/${projectKey}`);
      return response.data;
    } catch (error) {
      if (error instanceof HttpError && (error.status === 404 || error.status === 400)) {
        throw new CliError(`Jira project "${projectKey}" was not found on ${this.site.baseUrl}.`);
      }
      throw error;
    }
  }

  async fields(): Promise<JsonObject[]> {
    const response = await this.http.request<JsonObject[]>(`${this.api}/field`);
    return Array.isArray(response.data) ? response.data : [];
  }

  /** One page of a JQL search; works with both the token and the startAt API. */
  async search(options: {
    jql: string;
    fields?: string[];
    expand?: string[];
    maxResults?: number;
    nextPageToken?: string | null;
    startAt?: number;
  }): Promise<JiraSearchPage> {
    const maxResults = options.maxResults ?? 100;
    const fields = options.fields ?? ['*all'];

    if (this.useJqlSearchEndpoint !== false) {
      try {
        const response = await this.http.request<JsonObject>(`${this.api}/search/jql`, {
          method: 'POST',
          body: {
            jql: options.jql,
            maxResults,
            fields,
            ...(options.expand ? { expand: options.expand.join(',') } : {}),
            ...(options.nextPageToken ? { nextPageToken: options.nextPageToken } : {}),
          },
        });
        this.useJqlSearchEndpoint = true;
        return {
          issues: arr(response.data, 'issues') as JsonObject[],
          total: num(response.data, 'total'),
          isLast: str(response.data, 'nextPageToken') === null,
          nextPageToken: str(response.data, 'nextPageToken'),
          startAt: 0,
        };
      } catch (error) {
        const notAvailable =
          error instanceof HttpError && (error.status === 404 || error.status === 410);
        if (!notAvailable || this.useJqlSearchEndpoint === true) throw error;
        this.useJqlSearchEndpoint = false;
      }
    }

    const startAt = options.startAt ?? 0;
    const response = await this.http.request<JsonObject>(`${this.api}/search`, {
      method: 'POST',
      body: {
        jql: options.jql,
        startAt,
        maxResults,
        fields,
        ...(options.expand ? { expand: options.expand } : {}),
      },
    });
    const issues = arr(response.data, 'issues') as JsonObject[];
    const total = num(response.data, 'total');
    return {
      issues,
      total,
      isLast: total !== null ? startAt + issues.length >= total : issues.length < maxResults,
      nextPageToken: null,
      startAt: startAt + issues.length,
    };
  }

  /** Number of issues a JQL query matches, used to size the progress bar. */
  async count(jql: string): Promise<number | null> {
    try {
      const response = await this.http.request<JsonObject>(`${this.api}/search/approximate-count`, {
        method: 'POST',
        body: { jql },
      });
      const count = num(response.data, 'count');
      if (count !== null) return count;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }

    const page = await this.search({ jql, maxResults: 1, fields: ['key'] });
    return page.total;
  }

  async comments(issueKey: string): Promise<JsonObject[]> {
    const collected: JsonObject[] = [];
    let startAt = 0;
    for (;;) {
      const response = await this.http.request<JsonObject>(
        `${this.api}/issue/${issueKey}/comment`,
        { query: { startAt, maxResults: 100, orderBy: 'created' } },
      );
      const comments = arr(response.data, 'comments') as JsonObject[];
      collected.push(...comments);
      const total = num(response.data, 'total') ?? collected.length;
      startAt += comments.length;
      if (comments.length === 0 || startAt >= total) return collected;
    }
  }

  async changelog(issueKey: string): Promise<JsonObject[]> {
    const collected: JsonObject[] = [];
    let startAt = 0;
    for (;;) {
      const response = await this.http.request<JsonObject>(
        `${this.api}/issue/${issueKey}/changelog`,
        { query: { startAt, maxResults: 100 } },
      );
      const values = arr(response.data, 'values') as JsonObject[];
      collected.push(...values);
      const total = num(response.data, 'total') ?? collected.length;
      startAt += values.length;
      if (values.length === 0 || startAt >= total) return collected;
    }
  }

  async worklogs(issueKey: string): Promise<JsonObject[]> {
    const response = await this.http.request<JsonObject>(`${this.api}/issue/${issueKey}/worklog`, {
      query: { maxResults: 100 },
    });
    return arr(response.data, 'worklogs') as JsonObject[];
  }

  async boards(projectKey: string): Promise<JsonObject[]> {
    const collected: JsonObject[] = [];
    let startAt = 0;
    for (;;) {
      const response = await this.http.request<JsonObject>('/rest/agile/1.0/board', {
        query: { projectKeyOrId: projectKey, startAt, maxResults: 50 },
        allowStatus: [404],
      });
      if (response.status === 404) return collected;
      const values = arr(response.data, 'values') as JsonObject[];
      collected.push(...values);
      if (values.length === 0 || bool(response.data, 'isLast') === true) return collected;
      startAt += values.length;

      const total = num(response.data, 'total');
      if (total !== null && startAt >= total) return collected;
      if (values.length < 50) return collected;
    }
  }

  async sprints(boardId: number): Promise<JsonObject[]> {
    const collected: JsonObject[] = [];
    let startAt = 0;
    for (;;) {
      const response = await this.http.request<JsonObject>(
        `/rest/agile/1.0/board/${boardId}/sprint`,
        { query: { startAt, maxResults: 50 }, allowStatus: [400, 404] },
      );
      // Kanban boards have no sprints and answer with 400.
      if (response.status === 400 || response.status === 404) return collected;
      const values = arr(response.data, 'values') as JsonObject[];
      collected.push(...values);
      if (values.length === 0 || values.length < 50) return collected;
      startAt += values.length;
    }
  }

  async sprintIssueKeys(sprintId: number): Promise<Array<{ id: string; key: string }>> {
    const collected: Array<{ id: string; key: string }> = [];
    let startAt = 0;
    for (;;) {
      const response = await this.http.request<JsonObject>(
        `/rest/agile/1.0/sprint/${sprintId}/issue`,
        { query: { startAt, maxResults: 100, fields: 'key' }, allowStatus: [404] },
      );
      if (response.status === 404) return collected;
      const issues = arr(response.data, 'issues') as JsonObject[];
      for (const issue of issues) {
        const id = str(issue, 'id');
        const key = str(issue, 'key');
        if (id && key) collected.push({ id, key });
      }
      startAt += issues.length;
      const total = num(response.data, 'total') ?? collected.length;
      if (issues.length === 0 || startAt >= total) return collected;
    }
  }
}

function buildAuthorizationHeader(site: JiraSite): string {
  if (site.auth === 'basic') {
    if (!site.email) {
      throw new CliError(`Jira site "${site.name}" uses basic auth but has no email configured.`, {
        hint: 'Add "email:" to the site, or switch to auth: bearer for a personal access token.',
      });
    }
    const encoded = Buffer.from(`${site.email}:${site.token}`, 'utf8').toString('base64');
    return `Basic ${encoded}`;
  }
  return `Bearer ${site.token}`;
}
