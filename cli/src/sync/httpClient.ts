import { CliError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { formatDuration, sleep } from '../util/time.js';
import type { ProgressReporter } from './progress.js';
import type { RateLimiter } from './rateLimiter.js';

export interface HttpClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  rateLimiter: RateLimiter;
  progress: ProgressReporter;
  logger: Logger;
  maxRetries: number;
  retryBaseMs: number;
  timeoutMs: number;
  /** Label used in error messages, e.g. "GitHub" or "Jira (acme)". */
  label: string;
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Return the raw text body instead of parsing JSON. */
  responseType?: 'json' | 'text';
  /** Treat these status codes as an empty result instead of an error. */
  allowStatus?: number[];
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
  url: string;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * A small fetch wrapper shared by the GitHub and Jira clients. Every call goes
 * through the rate limiter, is counted by the progress reporter and is retried
 * with exponential backoff on transient failures.
 */
export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {}

  async request<T = unknown>(
    path: string,
    requestOptions: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const url = this.buildUrl(path, requestOptions.query);
    const method = requestOptions.method ?? 'GET';
    const allowStatus = new Set(requestOptions.allowStatus ?? []);

    let attempt = 0;
    for (;;) {
      await this.options.rateLimiter.acquire();
      this.options.progress.recordApiCall();
      this.options.logger.debug(`${method} ${url}`);

      let response: Response;
      try {
        response = await this.fetchWithTimeout(url, method, requestOptions);
      } catch (error) {
        if (attempt >= this.options.maxRetries) {
          throw new CliError(
            `${this.options.label}: request to ${url} failed: ${(error as Error).message}`,
            { cause: error },
          );
        }
        await this.backoff(++attempt, (error as Error).message);
        continue;
      }

      this.options.rateLimiter.observeHeaders(response.headers);

      if (response.ok) {
        return {
          status: response.status,
          headers: response.headers,
          url,
          data: await this.readBody<T>(response, requestOptions.responseType ?? 'json'),
        };
      }

      const bodyText = await safeText(response);

      if (allowStatus.has(response.status)) {
        return {
          status: response.status,
          headers: response.headers,
          url,
          data: undefined as T,
        };
      }

      const isRateLimited = this.isRateLimited(response, bodyText);
      if (
        (RETRYABLE_STATUS.has(response.status) || isRateLimited) &&
        attempt < this.options.maxRetries
      ) {
        const retryAfterMs = this.options.rateLimiter.applyRetryAfter(response.headers);
        if (isRateLimited && retryAfterMs === null) {
          // Secondary rate limit without a hint: back off generously.
          this.options.rateLimiter.pauseFor(60_000);
        }
        await this.backoff(++attempt, `HTTP ${response.status}`);
        continue;
      }

      throw new HttpError(
        `${this.options.label}: ${method} ${url} failed with HTTP ${response.status}${
          bodyText ? `: ${truncate(bodyText, 400)}` : ''
        }`,
        response.status,
        url,
        bodyText,
      );
    }
  }

  private isRateLimited(response: Response, bodyText: string): boolean {
    if (response.status === 429) return true;
    if (response.status !== 403) return false;
    if (response.headers.get('x-ratelimit-remaining') === '0') return true;
    return /rate limit|abuse detection|secondary rate/i.test(bodyText);
  }

  private async fetchWithTimeout(
    url: string,
    method: string,
    requestOptions: RequestOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const headers: Record<string, string> = {
        ...this.options.headers,
        ...requestOptions.headers,
      };
      let body: string | undefined;
      if (requestOptions.body !== undefined) {
        body = JSON.stringify(requestOptions.body);
        headers['content-type'] = 'application/json';
      }
      return await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
        redirect: 'follow',
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readBody<T>(response: Response, responseType: 'json' | 'text'): Promise<T> {
    if (responseType === 'text') return (await response.text()) as T;
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text.trim() === '') return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new CliError(
        `${this.options.label}: could not parse the response of ${response.url} as JSON.`,
        { cause: error },
      );
    }
  }

  private async backoff(attempt: number, reason: string): Promise<void> {
    const waitMs = Math.min(this.options.retryBaseMs * 2 ** (attempt - 1), 60_000);
    this.options.logger.warn(
      `${this.options.label}: ${reason}; retrying in ${formatDuration(waitMs)} (attempt ${attempt}/${this.options.maxRetries}).`,
    );
    await sleep(waitMs);
  }

  buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = path.startsWith('http')
      ? new URL(path)
      : new URL(`${this.options.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
