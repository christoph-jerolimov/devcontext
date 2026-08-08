# Web viewer

```bash
devcontext serve
# devcontext is serving the viewer on http://127.0.0.1:4173
```

The CLI serves a React application together with a JSON API for the local
database. It binds to `127.0.0.1` by default and opens the database read only —
nothing the viewer does can change your data.

The command used to be called `web`, which still works as an alias.

| Option              | Default                 | Description             |
| ------------------- | ----------------------- | ----------------------- |
| `-p, --port <port>` | `web.port`, `4173`      | Port                    |
| `--host <host>`     | `web.host`, `127.0.0.1` | Interface to bind to    |
| `--db <path>`       | from the configuration  | Which database to serve |

## Views

| View            | Contents                                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview        | Configured projects, row counts per table group, the last sync runs and the current cursors                                                                                                                                               |
| Tickets         | GitHub issues and Jira work items in one list. Quick filters for source, repository/project, type and state — the type and container dropdowns are built from the data, so a project that invents a type gets an entry without a redeploy |
| GitHub issues   | Filter by repository, state and text; click a row for body, comments and timeline. Shows every state by default, since a closed issue is the normal end of one                                                                            |
| Pull requests   | Same, plus reviews with their inline comments and the changed files. Also every state, since a merged pull request is the normal end of one                                                                                               |
| Workflow runs   | Filter by repository and conclusion; click a run for its jobs and every step                                                                                                                                                              |
| Jira work items | Filter by project, type group (Task also matches its subtasks), status category and full text (summary, description and comments); click for description, comments, the complete history and the hierarchy                                |
| Activity        | Status changes, comments and reviews across both platforms, newest first, with a window, source, kind and person/team filter and a switch for hiding bots. Names are shown as the person's, not the login's. See [People](people.md)      |
| Burndown        | A sprint's remaining work per day against the ideal, with the total scope behind it and the mid-sprint scope changes listed, plus committed-against-completed velocity across sprints. See [Sprint reports](sprints.md)                   |
| History         | How many items were open per day, as a line over the last 30 days to a year, with what crossed in and out per day on hover, and a snapshot of who holds what now. See [History](history.md)                                               |
| Insights        | Cycle time, review latency, WIP, reviewers, flaky steps and stale work, with adjustable windows                                                                                                                                           |
| Digest          | What happened in the last day, week or month: merged, finished, started, who did it, and what is still waiting                                                                                                                            |
| Sprints         | Filter by state; click for the work items of a sprint                                                                                                                                                                                     |

The viewer follows the light or dark preference of your system.

## Cross links

Every issue, pull request and work item shows what it is connected to on the
other platform — the same graph `devcontext links` reads, computed during sync
by scanning branch names, titles, bodies, commit messages and comments.

Clicking a row crosses over: from a ticket to the pull request that implemented
it, and back again. GitHub items open with `state=all`, because the one you are
looking for has usually been closed or merged.

Each row states **where** the reference was found, because that is what
separates a deliberate link from a passing mention. A key in a branch name or a
title was put there on purpose and is shown in full strength; one found in a
body or a comment is stated but dimmed. High confidence rows sort first.

An item that references nothing shows no section at all.

## Hierarchy

Opening a work item shows where it sits: the chain of parents above it, and
everything below it, the same tree `devcontext jira tree` prints. Above it is
the roll-up over the item and its descendants — how many are done, and how many
story points of the total are finished.

Every key in the tree is clickable, so you can walk up to the epic and back
down into a sub-task without going through the list, and each step lands in the
URL like any other selection.

Children reached through the classic epic-link field rather than a real parent
are tagged `epic link`, because Jira models the hierarchy both ways and which
one is in use is worth seeing.

An item with no parent and no children shows no tree at all — that is most work
items, and an empty heading would be noise.

## Command palette

<kbd>⌘K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd> on Linux and Windows) opens a
palette over whatever you are looking at. Arrow keys move, <kbd>↵</kbd> opens,
<kbd>esc</kbd> closes.

It does three things:

- **Search** issues, pull requests and work items as you type, through the same
  ranked index as `devcontext search` — so a phrase that only appears in a
  comment still finds the ticket. Opening a result jumps to the right view with
  the item already open.
- **Jump to a page**, including the ones with filters already applied:
  "failing" reaches the failed workflow runs, "in progress" the work items
  being worked on.
- **Go to a reference** directly. Type `PLAT-42` or `acme/platform#42` and it
  offers to open exactly that, whether or not the search index has caught up.

Results are ranked by the server, so the palette does not re-filter them —
otherwise a hit whose match is in a comment would be hidden because the title
does not contain the words you typed. Pages are matched separately and stay
available while you type.

## Shareable URLs

Every filter, and which item is open, lives in the address bar:

```
#/issues?repo=acme/platform&state=all&search=rate%20limit
#/issues?state=all&open=acme%2Fplatform%2342
#/workitems?project=PLAT&category=In%20Progress&open=PLAT-42
#/insights?days=30&stale=14
```

So a link you paste into a chat opens the same list _and_ the same ticket for
whoever clicks it, and reloading the page keeps you where you were.

Two details make this comfortable rather than annoying: a filter left at its
default is dropped from the URL, so the common case stays short; and filter
changes replace the history entry instead of pushing one, so the back button
leaves the view rather than walking backwards through every keystroke you typed
into a search box. Switching views starts from clean filters.

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

| Endpoint                                                                                | Description                                                                                                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/status`                                                                       | Configuration, counts, recent runs, sync state                                                                           |
| `GET /api/github/repos`                                                                 | Synced repositories                                                                                                      |
| `GET /api/people`                                                                       | The configured people, bots and teams                                                                                    |
| `GET /api/people/teams`                                                                 | Teams with their resolved members                                                                                        |
| `GET /api/people/unmapped?limit=`                                                       | Names found in the data that belong to nobody, busiest first                                                             |
| `GET /api/history?from=&to=&source=&container=&kind=&assignee=&sprint=`                 | Open items per day over the window, plus a per-person snapshot at its end                                                |
| `GET /api/tickets?source=&container=&type=&state=&search=&person=&team=&limit=`         | GitHub issues and Jira work items as one list, plus the total the filters match                                          |
| `GET /api/tickets/types?...`                                                            | Every type present with its count, for the type filter. Honours every filter except `type`                               |
| `GET /api/tickets/containers?...`                                                       | Every repository and project present with its count                                                                      |
| `GET /api/github/issues?repo=&state=&label=&author=&person=&team=&bots=&search=&limit=` | Issue list. `bots=false` hides bot authored items, `bots=only` keeps only those                                          |
| `GET /api/github/issues/:owner/:repo/:number`                                           | One issue with comments and events                                                                                       |
| `GET /api/github/pulls?...`                                                             | Pull request list. `state` defaults to `all`, as it does for issues                                                      |
| `GET /api/github/pulls/:owner/:repo/:number`                                            | One pull request with reviews, commits and files                                                                         |
| `GET /api/github/workflows?repo=`                                                       | Workflows                                                                                                                |
| `GET /api/github/runs?repo=&conclusion=&branch=&workflow=`                              | Workflow runs                                                                                                            |
| `GET /api/github/runs/:id`                                                              | One run with jobs and steps                                                                                              |
| `GET /api/github/jobs?run=`                                                             | Jobs                                                                                                                     |
| `GET /api/github/steps?job=&run=`                                                       | Steps                                                                                                                    |
| `GET /api/github/logs/:jobId`                                                           | Stored job log                                                                                                           |
| `GET /api/jira/projects`                                                                | Jira projects                                                                                                            |
| `GET /api/jira/fields`                                                                  | Fields and their mapped names                                                                                            |
| `GET /api/jira/workitems?project=&type=&status=&category=&q=`                           | Work items (`q` searches comments too)                                                                                   |
| `GET /api/jira/workitems/:key`                                                          | One work item with comments and history                                                                                  |
| `GET /api/jira/tree/:key?depth=&ancestors=&links=`                                      | The hierarchy around one work item, with a roll-up                                                                       |
| `GET /api/jira/sprints?state=`                                                          | Sprints                                                                                                                  |
| `GET /api/jira/sprints/:id`                                                             | One sprint with its work items                                                                                           |
| `GET /api/insights`                                                                     | Every insight section at once                                                                                            |
| `GET /api/insights/{cycle-time,review-latency,wip,stale,flaky}`                         | One section                                                                                                              |
| `GET /api/insights/sprint/:id`                                                          | One sprint report                                                                                                        |
| `GET /api/digest?since=&until=&repo=&project=&person=&staleAfter=`                      | Activity digest for a window                                                                                             |
| `GET /api/search?q=&kind=&repo=&project=&exact=&limit=`                                 | Ranked full text search across both platforms                                                                            |
| `GET /api/links?limit=&offset=`                                                         | Cross references between GitHub and Jira                                                                                 |
| `GET /api/links/:ref`                                                                   | What references one item, and what it references. A GitHub reference is percent encoded: `/api/links/acme/platform%2342` |

```bash
curl -s "http://127.0.0.1:4173/api/jira/workitems?category=In%20Progress" | jq '.[].key'
```

## Developing the viewer

```bash
devcontext serve                 # terminal 1: API + data on :4173
npm run dev:web                # terminal 2: Vite with hot reload on :5173
```

Vite proxies `/api` to `http://127.0.0.1:4173`; set `DEVCONTEXT_API` to point it
somewhere else. `npm run build:web` type checks and writes `web/dist`, which is
what `devcontext serve` hands out in production. If the viewer has not been
built, the command still serves the API and says so.
