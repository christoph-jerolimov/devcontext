/**
 * A stand-in for the GitHub and Jira APIs, on localhost.
 *
 * The sync that runs against this is the real one — the real CLI, the real
 * HTTP client, the real rate limiter, the real database. Only the far end is
 * fixed, and it has to be: screenshots of live data would change every day and
 * could not be reviewed or compared.
 *
 * It speaks enough of both APIs for a complete sync, including the `Link`
 * pagination headers the size probe reads.
 */
import { createServer } from 'node:http';

import * as data from './data.mjs';

function send(response, status, body, headers = {}) {
  const payload = JSON.stringify(body ?? null);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The rate limiter reads these; generous values keep it out of the way.
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    ...headers,
  });
  response.end(payload);
}

/** A list response with GitHub's `Link` header, honouring `per_page`. */
function paginate(response, url, all) {
  const perPage = Number(url.searchParams.get('per_page') ?? '100');
  const current = Number(url.searchParams.get('page') ?? '1');
  const pages = Math.max(1, Math.ceil(all.length / perPage));
  const slice = all.slice((current - 1) * perPage, current * perPage);

  if (pages <= 1) {
    send(response, 200, slice);
    return;
  }

  const link = (rel, target) =>
    `<${url.origin}${url.pathname}?per_page=${perPage}&page=${target}>; rel="${rel}"`;
  const parts = [link('last', pages)];
  if (current < pages) parts.unshift(link('next', current + 1));
  send(response, 200, slice, { link: parts.join(', ') });
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      try {
        resolve(raw === '' ? {} : JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

/** Every request the sync made, so a test can assert on what it asked for. */
export const requests = [];

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const path = url.pathname;
  requests.push(`${request.method} ${path}${url.search}`);

  // ---- GitHub -------------------------------------------------------------
  const repo = '/repos/acme/platform';
  if (path === repo) return send(response, 200, data.REPO);
  if (path === `${repo}/labels`) return paginate(response, url, data.LABELS);
  if (path === `${repo}/milestones`) return paginate(response, url, data.MILESTONES);
  if (path === `${repo}/releases`) return paginate(response, url, []);
  if (path === `${repo}/issues`) return paginate(response, url, data.ISSUES);
  if (path === `${repo}/pulls`) {
    return paginate(
      response,
      url,
      data.PULL_NUMBERS.map((n) => data.PULLS[n]),
    );
  }

  let match = /^\/repos\/acme\/platform\/issues\/(\d+)(\/(comments|timeline))?$/.exec(path);
  if (match) {
    const number = Number(match[1]);
    if (match[3] === 'comments') return paginate(response, url, data.ISSUE_COMMENTS[number] ?? []);
    if (match[3] === 'timeline') return paginate(response, url, data.TIMELINES[number] ?? []);
    const issue = data.ISSUES.find((entry) => entry.number === number);
    return issue ? send(response, 200, issue) : send(response, 404, { message: 'Not Found' });
  }

  match = /^\/repos\/acme\/platform\/pulls\/(\d+)(\/(reviews|comments|commits|files))?$/.exec(path);
  if (match) {
    const number = Number(match[1]);
    if (match[3] === 'reviews') return paginate(response, url, data.REVIEWS[number] ?? []);
    if (match[3] === 'comments') return paginate(response, url, data.REVIEW_COMMENTS[number] ?? []);
    if (match[3] === 'commits') return paginate(response, url, data.COMMITS[number] ?? []);
    if (match[3] === 'files') return paginate(response, url, data.FILES[number] ?? []);
    const pull = data.PULLS[number];
    return pull ? send(response, 200, pull) : send(response, 404, { message: 'Not Found' });
  }

  if (path === `${repo}/actions/workflows`) {
    return send(response, 200, { total_count: data.WORKFLOWS.length, workflows: data.WORKFLOWS });
  }
  if (path === `${repo}/actions/runs`) {
    const perPage = Number(url.searchParams.get('per_page') ?? '100');
    const current = Number(url.searchParams.get('page') ?? '1');
    const slice = data.RUNS.slice((current - 1) * perPage, current * perPage);
    const pages = Math.max(1, Math.ceil(data.RUNS.length / perPage));
    const headers =
      pages > 1
        ? {
            link: [
              ...(current < pages
                ? [`<${url.origin}${path}?per_page=${perPage}&page=${current + 1}>; rel="next"`]
                : []),
              `<${url.origin}${path}?per_page=${perPage}&page=${pages}>; rel="last"`,
            ].join(', '),
          }
        : {};
    return send(response, 200, { total_count: data.RUNS.length, workflow_runs: slice }, headers);
  }

  match = /^\/repos\/acme\/platform\/actions\/runs\/(\d+)\/jobs$/.exec(path);
  if (match) {
    const jobs = data.JOBS[Number(match[1])] ?? [];
    return send(response, 200, { total_count: jobs.length, jobs });
  }

  match = /^\/repos\/acme\/platform\/actions\/jobs\/(\d+)\/logs$/.exec(path);
  if (match) {
    response.writeHead(200, { 'content-type': 'text/plain' });
    return response.end(`2026-03-01T10:00:00Z Running integration tests\n`);
  }

  // ---- Jira ---------------------------------------------------------------
  if (path === '/rest/api/3/project/PLAT') return send(response, 200, data.JIRA_PROJECT);
  if (path === '/rest/api/3/field') return send(response, 200, data.JIRA_FIELDS);

  if (path === '/rest/api/3/search/approximate-count') {
    await readBody(request);
    return send(response, 200, { count: data.WORKITEMS.length });
  }
  if (path === '/rest/api/3/search/jql') {
    await readBody(request);
    return send(response, 200, {
      issues: data.WORKITEMS,
      total: data.WORKITEMS.length,
      nextPageToken: null,
    });
  }

  match = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/changelog$/.exec(path);
  if (match) {
    const item = data.WORKITEMS.find((entry) => entry.key === match[1]);
    const histories = item?.changelog.histories ?? [];
    return send(response, 200, { values: histories, total: histories.length, isLast: true });
  }

  if (path === '/rest/agile/1.0/board') {
    return send(response, 200, { values: data.BOARDS, total: data.BOARDS.length, isLast: true });
  }
  match = /^\/rest\/agile\/1\.0\/board\/(\d+)\/sprint$/.exec(path);
  if (match) {
    return send(response, 200, { values: data.SPRINTS, total: data.SPRINTS.length, isLast: true });
  }
  match = /^\/rest\/agile\/1\.0\/sprint\/(\d+)\/issue$/.exec(path);
  if (match) {
    const issues = data.SPRINT_ISSUES[Number(match[1])] ?? [];
    return send(response, 200, { issues, total: issues.length });
  }

  // Anything unrecognised is a bug in this stub, and should be loud.
  send(response, 404, { message: `No fixture for ${request.method} ${path}` });
}

export function startFixtureApi() {
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      send(response, 500, { message: String(error) });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
