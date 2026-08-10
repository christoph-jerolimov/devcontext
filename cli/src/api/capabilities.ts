/**
 * What each API capability actually does, typed against the shared contract.
 *
 * Every handler here is annotated with the payload type the viewer imports
 * from `@devcontext/shared`, which is the point of the exercise: the server
 * used to build its responses untyped, and the viewer's idea of them was a
 * hand-kept copy that drifted — `/api/status` grew a `links` block the
 * viewer's types never heard of. Now a handler that returns something the
 * contract does not promise, or stops returning something it does, fails to
 * compile.
 *
 * Endpoints the viewer does not consume are typed with the query layer's own
 * row interfaces instead; they are no less part of the API for it. The five
 * single-item document endpoints return `unknown`, because a document's JSON
 * is deliberately free-form — the shared `IssueDocument` is the viewer's
 * loose reading type, not a promise the server can keep field by field.
 *
 * Returning `undefined` means 404. A handler that returns `null` means it —
 * `null` is a payload, and `/api/insights/sprint/999` answers `null` for a
 * sprint that does not exist, as it always has.
 */

import type {
  ActivityResponse,
  WatchStatus,
  BurndownResponse,
  ClosedResponse,
  DigestResponse,
  HistoryResponse,
  InsightsResponse,
  LinksResponse,
  RunsResponse,
  SearchHit,
  StatusResponse,
  StatusTimesResponse,
  TicketContainer,
  TicketsResponse,
  TicketType,
  VelocityResponse,
  WorkitemTree,
  Issue,
  PullRequest,
  Repository,
  Sprint,
  Workitem,
  WorkflowRun,
} from '@devcontext/shared';

import type { Person, ResolvedConfig, Team } from '../config/types.js';
import type { Database } from '../db/database.js';
import type { SyncJournal } from '../db/journal.js';
import * as gh from '../db/queries/github.js';
import * as jira from '../db/queries/jira.js';
import * as crossLinks from '../db/queries/links.js';
import * as historyQueries from '../db/queries/history.js';
import * as ticketQueries from '../db/queries/tickets.js';
import * as peopleQueries from '../db/queries/people.js';
import * as activityQueries from '../db/queries/activity.js';
import * as contributorQueries from '../db/queries/contributors.js';
import { buildWorkitemTree, summariseTree } from '../db/queries/tree.js';
import { buildDigest } from '../insights/digest.js';
import * as insights from '../insights/index.js';
import type { Directory } from '../people/directory.js';
import { readRateLimits } from '../sync/rateLimitStore.js';
import { searchAll } from '../search/index.js';
import {
  buildIssueDocument,
  buildPullRequestDocument,
  buildWorkflowRunDocument,
} from '../documents/github.js';
import { buildSprintDocument, buildWorkitemDocument } from '../documents/jira.js';
import type { CrossLinkRow } from '../links/build.js';
import type { CapabilityName, InputOf, routes } from './routes.js';

export interface ApiContext {
  db: Database;
  journal: SyncJournal;
  config: ResolvedConfig;
  /**
   * Rebuilt from the configuration on every request rather than cached with
   * the server, so editing devcontext.yaml and reloading the page is enough —
   * the viewer never shows a mapping the file no longer contains.
   */
  directory: Directory;
  /** Non-null when the server is also syncing on an interval (`--watch`). */
  watch: WatchStatus | null;
}

/** What each capability answers with. `unknown` means free-form JSON. */
export interface ApiOutputs {
  'people.list': { people: readonly Person[]; teams: readonly Team[] };
  'people.teams': Array<Team & { people: string[] }>;
  'people.unmapped': peopleQueries.UnmappedIdentity[];
  'activity.list': ActivityResponse;
  'activity.people': activityQueries.ActivityByActor[];
  status: StatusResponse;
  'insights.summary': InsightsResponse;
  'insights.cycleTime': InsightsResponse['cycleTime'];
  'insights.reviewLatency': InsightsResponse['reviewLatency'];
  'insights.wip': InsightsResponse['wip'];
  'insights.stale': InsightsResponse['stale'];
  'insights.flaky': InsightsResponse['flaky'];
  'insights.sprint': insights.SprintReport | null;
  'insights.burndown': BurndownResponse | null;
  'insights.flow': insights.CumulativeFlow;
  'insights.statusTime': StatusTimesResponse;
  'insights.velocity': VelocityResponse;
  'history.open': HistoryResponse;
  'history.closed': ClosedResponse;
  'history.runs': RunsResponse;
  'tickets.list': TicketsResponse;
  'tickets.types': TicketType[];
  'tickets.containers': TicketContainer[];
  search: SearchHit[];
  digest: DigestResponse;
  links: LinksResponse | CrossLinkRow[];
  'github.repos': Repository[];
  'github.issues.list': Issue[];
  'github.issues.get': unknown;
  'github.pulls.list': PullRequest[];
  'github.pulls.get': unknown;
  'github.workflows': gh.WorkflowRow[];
  'github.runs.list': WorkflowRun[];
  'github.runs.get': unknown;
  'github.jobs': gh.WorkflowJobRow[];
  'github.steps': gh.WorkflowStepRow[];
  'github.logs': ReturnType<typeof gh.getJobLog>;
  'jira.projects': jira.JiraProjectRow[];
  'jira.fields': ReturnType<typeof jira.listJiraFields>;
  'jira.workitems.list': Workitem[];
  'jira.workitems.get': unknown;
  'jira.tree': WorkitemTree;
  'jira.sprints.list': Sprint[];
  'jira.sprints.get': unknown;
}

type Routes = typeof routes;

export type ApiHandlers = {
  [K in CapabilityName]: (ctx: ApiContext, input: InputOf<Routes[K]>) => ApiOutputs[K] | undefined;
};

const DAY_MS = 86_400_000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/*
 * `?person=` and `?team=` on any list that has an author, resolved to the
 * identities a WHERE clause has to match.
 */
function selectionOf(
  ctx: ApiContext,
  input: { person?: string[]; team?: string[] },
): ReturnType<Directory['select']> {
  return ctx.directory.select({ people: input.person, teams: input.team });
}

function activityFilter(
  ctx: ApiContext,
  input: InputOf<Routes['activity.list']>,
): activityQueries.ActivityFilter {
  const selection = selectionOf(ctx, input);
  return {
    since: input.since ?? daysAgo(14),
    until: input.until,
    sources: input.source,
    containers: input.container,
    kinds: input.kind,
    excludeBots: input.bots === 'false',
    onlyBots: input.bots === 'only',
    bots: ctx.directory.botIdentities(),
    limit: input.limit ?? 100,
    offset: input.offset,
    ...(selection ? { people: { github: selection.github, jira: selection.jira } } : {}),
  };
}

function ticketFilter(
  ctx: ApiContext,
  input: InputOf<Routes['tickets.list']>,
): ticketQueries.TicketFilter {
  const selection = selectionOf(ctx, input);
  return {
    sources: input.source,
    containers: input.container,
    types: input.type,
    state: (input.state as 'open' | 'closed' | 'all') ?? 'all',
    assignee: input.assignee,
    search: input.search,
    limit: input.limit ?? 100,
    offset: input.offset,
    ...(selection ? { people: { github: selection.github, jira: selection.jira } } : {}),
  };
}

/**
 * Attaches the people who touched each row.
 *
 * The names are resolved here rather than in the viewer, which has the display
 * names but not the identities behind them — the same split the activity feed
 * uses. One query for the whole page, not one per row.
 */
function withContributors<T extends object>(
  db: Database,
  directory: Directory,
  rows: T[],
  refOf: (row: T) => string,
): Array<T & { contributors: Array<{ name: string; roles: string[]; events: number }> }> {
  const byRef = contributorQueries.contributorsByRef(db, rows.map(refOf));

  return rows.map((row) =>
    Object.assign(row, {
      contributors: (byRef.get(refOf(row)) ?? []).map((person) => ({
        name: directory.identify(person.source, person.identity)?.name ?? person.identity,
        roles: person.roles,
        events: person.events,
      })),
    }),
  );
}

export const handlers: ApiHandlers = {
  'people.list': (ctx) => ({ people: ctx.directory.people, teams: ctx.directory.teams }),

  'people.teams': (ctx) =>
    ctx.directory.teams.map((team) => ({
      ...team,
      people: ctx.directory.membersOf(team).map((person) => person.id),
    })),

  'people.unmapped': (ctx, input) => {
    const mapped = new Set<string>();
    for (const person of ctx.directory.people) {
      for (const login of person.github) mapped.add(`github:${login.trim().toLowerCase()}`);
      for (const name of person.jira) mapped.add(`jira:${name.trim().toLowerCase()}`);
    }
    return peopleQueries.unmappedIdentities(ctx.db, mapped, { limit: input.limit ?? 100 });
  },

  /*
   * What people did, as opposed to what the state of things is. The two
   * cannot be derived from each other: an issue opened, argued over and
   * closed looks, in the issue list, exactly like one nobody touched.
   */
  'activity.list': (ctx, input) => {
    const filter = activityFilter(ctx, input);
    return {
      // The person is resolved here rather than in the viewer, which has the
      // names but not the identities behind them.
      events: activityQueries.listActivity(ctx.db, filter).map((event) => {
        const person = ctx.directory.identify(event.source, event.actor);
        return Object.assign(event, {
          person: person ? { id: person.id, name: person.name, kind: person.kind } : null,
        });
      }),
      total: activityQueries.countActivity(ctx.db, filter),
      kinds: [...activityQueries.ACTIVITY_KINDS],
    } satisfies ActivityResponse;
  },

  'activity.people': (ctx, input) =>
    activityQueries.activityByActor(ctx.db, activityFilter(ctx, input)),

  status: (ctx) =>
    ({
      config: {
        path: ctx.config.configPath,
        database: ctx.config.databasePath,
        projects: ctx.config.projects.map((project) => ({
          key: project.key,
          name: project.name,
          description: project.description,
          github: project.github.map((repo) => repo.fullName),
          jira: project.jira.map((entry) => `${entry.site.name}/${entry.projectKey}`),
        })),
      },
      github: gh.githubStats(ctx.db),
      jira: jira.jiraStats(ctx.db),
      // The same totals broken down, so the Overview can say which repository
      // or project the rows came from rather than only how many there are.
      githubByRepository: gh.githubStatsByRepository(ctx.db),
      jiraByProject: jira.jiraStatsByProject(ctx.db),
      links: crossLinks.linkStats(ctx.db),
      // Served rather than duplicated in the viewer, so the dropdown and the
      // grouping that backs it cannot drift apart.
      filters: {
        workitemTypes: [...jira.WORKITEM_TYPES],
        /*
         * The repositories and Jira projects the activity filter offers.
         *
         * Read from the data rather than from the configuration: a repository
         * configured but never synced has nothing to filter to, and offering
         * it means a dropdown choice that always returns an empty feed.
         */
        containers: {
          github: gh.githubStatsByRepository(ctx.db).map((row) => row.repository),
          jira: jira.jiraStatsByProject(ctx.db).map((row) => row.project),
        },
        // Sent with the status the viewer already fetches, so a person or team
        // dropdown costs no extra request. Only what a dropdown needs — the
        // identities behind each entry are the server's business.
        people: ctx.directory.people.map((person) => ({
          id: person.id,
          name: person.name,
          kind: person.kind,
        })),
        teams: ctx.directory.teams.map((team) => ({ id: team.id, name: team.name })),
      },
      runs: ctx.journal.listRuns({ limit: 20 }),
      state: ctx.journal.listState(),
      watch: ctx.watch,
      // Persisted by the last sync; during a run the live numbers travel in
      // watch.progress.rateLimits instead.
      rateLimits: readRateLimits(ctx.db),
    }) satisfies StatusResponse,

  'insights.summary': (ctx, input) => {
    const filter = insightFilter(input);
    return {
      cycleTime: insights.cycleTime(ctx.db, filter),
      reviewLatency: insights.reviewLatency(ctx.db, filter),
      wip: insights.wip(ctx.db, filter),
      stale: insights.staleItems(ctx.db, input.staleAfter ?? daysAgo(30), filter),
      flaky: insights.flakySteps(ctx.db, {
        since: filter.since,
        repos: filter.repos,
        limit: filter.limit,
      }),
    };
  },
  'insights.cycleTime': (ctx, input) => insights.cycleTime(ctx.db, insightFilter(input)),
  'insights.reviewLatency': (ctx, input) => insights.reviewLatency(ctx.db, insightFilter(input)),
  'insights.wip': (ctx, input) => insights.wip(ctx.db, insightFilter(input)),
  'insights.stale': (ctx, input) =>
    insights.staleItems(ctx.db, input.staleAfter ?? daysAgo(30), insightFilter(input)),
  'insights.flaky': (ctx, input) =>
    insights.flakySteps(ctx.db, {
      since: input.since ?? daysAgo(90),
      repos: input.repo,
      limit: input.limit ?? 100,
    }),
  'insights.sprint': (ctx, input) => {
    const id = input.sprint !== undefined ? Number(input.sprint) : input.id;
    return id === undefined || Number.isNaN(id) ? undefined : insights.sprintReport(ctx.db, id);
  },
  /*
   * The two reports that read `state_changes` rather than the current
   * tables — the shape a sprint took, not the shape it is in. See
   * docs/sprints.md.
   */
  'insights.burndown': (ctx, input) => {
    const id = input.id !== undefined ? Number(input.id) : input.sprint;
    return id === undefined || Number.isNaN(id) ? undefined : insights.sprintBurndown(ctx.db, id);
  },
  'insights.flow': (ctx, input) =>
    insights.cumulativeFlow(ctx.db, {
      from: input.since ?? daysAgo(90),
      to: input.until,
      ...(input.project === undefined ? {} : { containers: input.project }),
    }),
  'insights.statusTime': (ctx, input) =>
    insights.statusTimes(ctx.db, {
      from: input.since ?? daysAgo(90),
      to: input.until,
      ...(input.project === undefined ? {} : { containers: input.project }),
      limit: input.limit ?? 100,
    }),
  'insights.velocity': (ctx, input) =>
    insights.sprintVelocity(ctx.db, {
      limit: input.limit ?? 100,
      ...(input.board === undefined ? {} : { board: input.board }),
    }),

  /*
   * How many items were open per day, which no other endpoint can answer:
   * the current tables know where an item ended up, not the shape it took
   * getting there. See docs/history.md.
   */
  'history.open': (ctx, input) => {
    const { from, to } = historyWindow(input);
    return {
      from,
      to,
      days: historyQueries.openByDay(ctx.db, {
        from,
        to,
        source: input.source,
        container: input.container,
        kind: input.kind,
        assignee: input.assignee,
        sprint: input.sprint,
      }),
    } satisfies HistoryResponse;
  },
  /*
   * Two series that do not come from `state_changes`, because they are not
   * balances. "How many were open on Tuesday" needs everything that carried
   * in from before the window; "how many finished on Tuesday" is a count of
   * events inside it, and the two are different questions with different
   * right answers.
   */
  'history.closed': (ctx, input) => {
    const { from, to } = historyWindow(input);
    const selection = selectionOf(ctx, input);
    return {
      from,
      to,
      days: gh.closedByDay(ctx.db, {
        from,
        to,
        ...(input.container ? { repos: input.container } : {}),
        ...(selection ? { people: selection.github } : {}),
        excludeBots: input.bots === 'false',
        bots: ctx.directory.botIdentities(),
      }),
    } satisfies ClosedResponse;
  },
  'history.runs': (ctx, input) => {
    const { from, to } = historyWindow(input);
    return {
      from,
      to,
      days: gh.runsByDay(ctx.db, {
        from,
        to,
        ...(input.container ? { repos: input.container } : {}),
      }),
    } satisfies RunsResponse;
  },

  /*
   * GitHub issues and Jira work items as one list, plus the two things a
   * filter bar needs to describe itself: which types exist and which
   * repositories and projects exist. Both are read off the data, so a
   * project that invents a type gets a filter entry without a redeploy.
   */
  'tickets.list': (ctx, input) => {
    const filter = ticketFilter(ctx, input);
    const rows = ticketQueries.listTickets(ctx.db, filter);
    return {
      tickets: withContributors(ctx.db, ctx.directory, rows, (row) => row.ref),
      // So the viewer can say "showing 100 of 4,312" rather than implying the
      // page it got is everything there is.
      total: ticketQueries.countTickets(ctx.db, filter),
    } satisfies TicketsResponse;
  },
  'tickets.types': (ctx, input) => ticketQueries.ticketTypes(ctx.db, ticketFilter(ctx, input)),
  'tickets.containers': (ctx, input) =>
    ticketQueries.ticketContainers(ctx.db, ticketFilter(ctx, input)),

  search: (ctx, input) => {
    const text = input.q ?? input.search ?? '';
    if (text.trim() === '') return [];
    return searchAll(ctx.db, text, {
      kinds: input.kind as Array<'issue' | 'pull-request' | 'workitem'> | undefined,
      containers: [...(input.repo ?? []), ...(input.project ?? [])],
      limit: input.limit ?? 100,
      offset: input.offset,
      prefix: input.exact !== 'true',
    });
  },

  digest: (ctx, input) =>
    buildDigest(ctx.db, {
      since: input.since ?? daysAgo(7),
      until: input.until,
      repos: input.repo,
      projects: input.project,
      people: input.person,
      staleAfter: input.staleAfter ?? daysAgo(30),
      limit: input.limit ?? 100,
    }),

  links: (ctx, input) => {
    // The path wins over `?ref=`; the router only forwards the query value
    // when no segments followed /api/links.
    if (input.ref) {
      return {
        ref: crossLinks.normaliseRef(input.ref),
        links: crossLinks.linksFor(ctx.db, input.ref),
      } satisfies LinksResponse;
    }
    return crossLinks.listLinks(ctx.db, { limit: input.limit ?? 100, offset: input.offset });
  },

  'github.repos': (ctx, input) =>
    gh.listRepositories(ctx.db, {
      search: input.search,
      limit: input.limit ?? 100,
      offset: input.offset,
    }),

  'github.issues.list': (ctx, input) => {
    const selection = selectionOf(ctx, input);
    return gh.listIssues(ctx.db, {
      repos: input.repo,
      // Every state by default, as pull requests do: see the `issues`
      // command for why.
      state: (input.state as 'open' | 'closed' | 'all') ?? 'all',
      labels: input.label,
      author: input.author,
      assignee: input.assignee,
      people: selection?.github,
      excludeBots: input.bots === 'false',
      onlyBots: input.bots === 'only',
      bots: ctx.directory.botIdentities('github'),
      search: input.search,
      updatedBefore: input.updatedBefore,
      updatedSince: input.updatedSince,
      limit: input.limit ?? 100,
      offset: input.offset,
    });
  },
  'github.issues.get': (ctx, input) => {
    const issue = gh.getIssue(ctx.db, `${input.owner}/${input.name}`, Number(input.number));
    return issue ? buildIssueDocument(ctx.db, issue).data : undefined;
  },

  'github.pulls.list': (ctx, input) => {
    const selection = selectionOf(ctx, input);
    return withContributors(
      ctx.db,
      ctx.directory,
      gh.listPullRequests(ctx.db, {
        repos: input.repo,
        // All states by default: see the `prs` command.
        state: (input.state as 'open' | 'closed' | 'all') ?? 'all',
        labels: input.label,
        author: input.author,
        people: selection?.github,
        excludeBots: input.bots === 'false',
        onlyBots: input.bots === 'only',
        bots: ctx.directory.botIdentities('github'),
        search: input.search,
        limit: input.limit ?? 100,
        offset: input.offset,
      }),
      (row) => `${row.repo_full_name}#${String(row.number)}`,
    );
  },
  'github.pulls.get': (ctx, input) => {
    const pr = gh.getPullRequest(ctx.db, `${input.owner}/${input.name}`, Number(input.number));
    return pr ? buildPullRequestDocument(ctx.db, pr).data : undefined;
  },

  'github.workflows': (ctx, input) =>
    gh.listWorkflows(ctx.db, {
      repos: input.repo,
      search: input.search,
      limit: input.limit ?? 100,
      offset: input.offset,
    }),

  'github.runs.list': (ctx, input) =>
    gh.listWorkflowRuns(ctx.db, {
      repos: input.repo,
      workflow: input.workflow,
      status: input.status,
      conclusion: input.conclusion,
      branch: input.branch,
      search: input.search,
      limit: input.limit ?? 100,
      offset: input.offset,
    }),
  'github.runs.get': (ctx, input) => {
    const run = ctx.db.get<gh.WorkflowRunRow>('SELECT * FROM gh_workflow_runs WHERE id = ?', [
      Number(input.id),
    ]);
    return run ? buildWorkflowRunDocument(ctx.db, run).data : undefined;
  },

  'github.jobs': (ctx, input) =>
    gh.listWorkflowJobs(ctx.db, {
      repos: input.repo,
      runId: input.run,
      conclusion: input.conclusion,
      search: input.search,
      limit: input.limit ?? 100,
      offset: input.offset,
    }),
  'github.steps': (ctx, input) =>
    gh.listWorkflowSteps(ctx.db, {
      jobId: input.job,
      runId: input.run,
      search: input.search,
      limit: input.limit ?? 100,
      offset: input.offset,
    }),
  'github.logs': (ctx, input) => gh.getJobLog(ctx.db, Number(input.id)),

  'jira.projects': (ctx) => jira.listJiraProjects(ctx.db),
  'jira.fields': (ctx, input) => jira.listJiraFields(ctx.db, { search: input.search }),

  'jira.workitems.list': (ctx, input) => {
    const filter = {
      projects: input.project,
      types: input.type,
      statuses: input.status,
      statusCategories: input.category,
      labels: input.label,
      assignee: input.assignee,
      sprint: input.sprint,
      epic: input.epic,
      updatedBefore: input.updatedBefore,
      updatedSince: input.updatedSince,
      search: input.search,
      limit: input.limit ?? 100,
      offset: input.offset,
    };
    return input.q
      ? jira.searchWorkitems(ctx.db, input.q, filter)
      : jira.listWorkitems(ctx.db, filter);
  },
  'jira.workitems.get': (ctx, input) => {
    const workitem = jira.getWorkitem(ctx.db, input.key);
    return workitem ? buildWorkitemDocument(ctx.db, workitem).data : undefined;
  },

  'jira.tree': (ctx, input) => {
    const tree = buildWorkitemTree(ctx.db, input.key, {
      maxDepth: input.depth !== undefined && input.depth > 0 ? Math.floor(input.depth) : undefined,
      // Ancestors are context you always want when looking at one item.
      // Links cost a query per node, so they stay opt in, as in the CLI.
      ancestors: input.ancestors !== 'false',
      withLinks: input.links === 'true',
    });
    return tree ? { ...tree, summary: summariseTree(tree) } : undefined;
  },

  'jira.sprints.list': (ctx, input) =>
    jira.listSprints(ctx.db, {
      states: input.state,
      search: input.search,
      limit: input.limit ?? 100,
      offset: input.offset,
    }),
  'jira.sprints.get': (ctx, input) => {
    const sprint = ctx.db.get<jira.SprintRow>('SELECT * FROM jira_sprints WHERE id = ?', [
      Number(input.id),
    ]);
    return sprint ? buildSprintDocument(ctx.db, sprint).data : undefined;
  },
};

function insightFilter(input: {
  since?: string;
  repo?: string[];
  project?: string[];
  limit?: number;
}): insights.InsightFilter {
  return {
    since: input.since ?? daysAgo(90),
    repos: input.repo,
    projects: input.project,
    limit: input.limit ?? 100,
  };
}

function historyWindow(input: { from?: string; to?: string }): { from: string; to: string } {
  return {
    to: input.to ?? new Date().toISOString(),
    from: input.from ?? daysAgo(29),
  };
}
