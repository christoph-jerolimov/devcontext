# Web viewer

```bash
devcontext web
# devcontext web is running on http://127.0.0.1:4173
```

The CLI serves a React application together with a JSON API for the local
database. It binds to `127.0.0.1` by default and opens the database read only —
nothing the viewer does can change your data.

| Option              | Default                 | Description             |
| ------------------- | ----------------------- | ----------------------- |
| `-p, --port <port>` | `web.port`, `4173`      | Port                    |
| `--host <host>`     | `web.host`, `127.0.0.1` | Interface to bind to    |
| `--db <path>`       | from the configuration  | Which database to serve |

## Views

| View            | Contents                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview        | Configured projects, row counts per table group, the last sync runs and the current cursors                                                          |
| GitHub issues   | Filter by repository, state and text; click a row for body, comments and timeline                                                                    |
| Pull requests   | Same, plus reviews with their inline comments and the changed files                                                                                  |
| Workflow runs   | Filter by repository and conclusion; click a run for its jobs and every step                                                                         |
| Jira work items | Filter by project, type, status category and full text (summary, description and comments); click for description, comments and the complete history |
| Insights        | Cycle time, review latency, WIP, reviewers, flaky steps and stale work, with adjustable windows                                                      |
| Digest          | What happened in the last day, week or month: merged, finished, started, who did it, and what is still waiting                                       |
| Sprints         | Filter by state; click for the work items of a sprint                                                                                                |

The viewer follows the light or dark preference of your system.

## Rendered text

Descriptions, comments and reviews are rendered as markdown: headings, lists,
task lists, tables, fenced code, quotes, links and images.

Both platforms end up in the same format. GitHub returns GitHub flavoured
markdown; Jira returns either Atlassian Document Format (Cloud, REST API v3) or
wiki markup (Data Center and Server, v2), and the sync converts both to
markdown before storing them. So the database, the markdown mirrors, the
`-o markdown` output and this viewer all show the same text.

The renderer builds React elements rather than HTML, and only `http`, `https`
and `mailto` links are made clickable. A body containing markup or a
`javascript:` link is therefore displayed as the text it is.

## JSON API

The same endpoints power the viewer and are useful on their own:

| Endpoint                                                            | Description                                      |
| ------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /api/status`                                                   | Configuration, counts, recent runs, sync state   |
| `GET /api/github/repos`                                             | Synced repositories                              |
| `GET /api/github/issues?repo=&state=&label=&author=&search=&limit=` | Issue list                                       |
| `GET /api/github/issues/:owner/:repo/:number`                       | One issue with comments and events               |
| `GET /api/github/pulls?...`                                         | Pull request list                                |
| `GET /api/github/pulls/:owner/:repo/:number`                        | One pull request with reviews, commits and files |
| `GET /api/github/workflows?repo=`                                   | Workflows                                        |
| `GET /api/github/runs?repo=&conclusion=&branch=&workflow=`          | Workflow runs                                    |
| `GET /api/github/runs/:id`                                          | One run with jobs and steps                      |
| `GET /api/github/jobs?run=`                                         | Jobs                                             |
| `GET /api/github/steps?job=&run=`                                   | Steps                                            |
| `GET /api/github/logs/:jobId`                                       | Stored job log                                   |
| `GET /api/jira/projects`                                            | Jira projects                                    |
| `GET /api/jira/fields`                                              | Fields and their mapped names                    |
| `GET /api/jira/workitems?project=&type=&status=&category=&q=`       | Work items (`q` searches comments too)           |
| `GET /api/jira/workitems/:key`                                      | One work item with comments and history          |
| `GET /api/jira/sprints?state=`                                      | Sprints                                          |
| `GET /api/jira/sprints/:id`                                         | One sprint with its work items                   |
| `GET /api/insights`                                                 | Every insight section at once                    |
| `GET /api/insights/{cycle-time,review-latency,wip,stale,flaky}`     | One section                                      |
| `GET /api/insights/sprint/:id`                                      | One sprint report                                |
| `GET /api/digest?since=&until=&repo=&project=&person=&staleAfter=`  | Activity digest for a window                     |

```bash
curl -s "http://127.0.0.1:4173/api/jira/workitems?category=In%20Progress" | jq '.[].key'
```

## Developing the viewer

```bash
devcontext web                 # terminal 1: API + data on :4173
npm run dev:web                # terminal 2: Vite with hot reload on :5173
```

Vite proxies `/api` to `http://127.0.0.1:4173`; set `DEVCONTEXT_API` to point it
somewhere else. `npm run build:web` type checks and writes `web/dist`, which is
what `devcontext web` serves in production. If the viewer has not been built,
`devcontext web` still serves the API and says so.
