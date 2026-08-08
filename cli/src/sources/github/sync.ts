import type { GithubRepoTarget } from '../../config/types.js';
import { SYNC_PHASES } from '../../sync/types.js';
import type { SyncContext, SyncPhase, TargetPlan, TargetSyncResult } from '../../sync/types.js';
import type { SyncMode } from '../../db/journal.js';
import { errorMessage } from '../../util/errors.js';
import { num, str } from '../../util/json.js';
import type { JsonObject } from '../../util/json.js';
import { nowIso } from '../../util/time.js';
import { jobsPerWorkflowRun } from '../../sync/estimates.js';
import { GithubClient } from './client.js';
import * as map from './map.js';
import type { RepoRef, Row } from './map.js';

interface OperationStats {
  items: number;
  cursor: string | null;
}

/**
 * Prepares one repository so it can be sized before anything is synced.
 *
 * The run is not opened in the journal until `run()`, so a survey that fails
 * leaves nothing half started behind it.
 */
export function planGithubRepository(target: GithubRepoTarget, ctx: SyncContext): TargetPlan {
  const client = new GithubClient({
    host: target.host,
    settings: ctx.config.sync,
    progress: ctx.progress,
    logger: ctx.logger,
  });

  const scopePrefix = `github:${target.host.name}/${target.fullName}`;
  const hasCursor = ctx.journal.getState(`${scopePrefix}:issues`) !== undefined;
  const mode: SyncMode = ctx.full || !hasCursor ? 'initial' : 'incremental';
  const syncer = new GithubRepoSyncer(client, target, ctx, mode, scopePrefix);

  let runId = 0;

  return {
    label: target.fullName,
    survey: () => syncer.survey(),

    begin: () => {
      runId = ctx.journal.startRun({
        projectKey: ctx.projectKey,
        source: 'github',
        target: target.fullName,
        mode,
      });
      syncer.attachRun(runId);
    },

    runPhase: (phase) => syncer.runPhase(phase),

    finish: (error) => {
      const base = {
        runId,
        source: 'github' as const,
        target: target.fullName,
        mode,
        apiCalls: syncer.apiCalls,
        items: syncer.items,
      };

      if (error !== null) {
        const message = errorMessage(error);
        syncer.abandonOpenOperations(error);
        ctx.journal.finishRun(runId, {
          status: 'failed',
          apiCalls: base.apiCalls,
          apiCallsExpected: ctx.progress.expectedApiCallCount,
          itemsSynced: base.items,
          error: message,
          details: syncer.summary,
        });
        return { ...base, status: 'failed', error: message };
      }

      ctx.journal.finishRun(runId, {
        status: 'completed',
        apiCalls: base.apiCalls,
        apiCallsExpected: ctx.progress.expectedApiCallCount,
        itemsSynced: base.items,
        details: syncer.summary,
      });
      return { ...base, status: 'completed' };
    },
  };
}

/** Syncs one GitHub repository into the database, sizing it first. */
export async function syncGithubRepository(
  target: GithubRepoTarget,
  ctx: SyncContext,
): Promise<TargetSyncResult> {
  const plan = planGithubRepository(target, ctx);
  await plan.survey();
  plan.begin();
  for (const phase of SYNC_PHASES) {
    try {
      await plan.runPhase(phase);
    } catch (error) {
      return plan.finish(error);
    }
  }
  return plan.finish(null);
}

/**
 * Syncs one issue or pull request immediately.
 *
 * No cursor is touched, so nothing the regular sync still has to fetch can be
 * skipped, and every write is an upsert, so the follow up run seeing the same
 * item again changes nothing.
 */
export async function syncGithubItem(
  target: GithubRepoTarget,
  ctx: SyncContext,
  number: number,
): Promise<TargetSyncResult> {
  const client = new GithubClient({
    host: target.host,
    settings: ctx.config.sync,
    progress: ctx.progress,
    logger: ctx.logger,
  });

  const runId = ctx.journal.startRun({
    projectKey: ctx.projectKey,
    source: 'github',
    target: target.fullName,
    mode: 'targeted',
  });

  const callsAtStart = ctx.progress.apiCallCount;
  const itemsAtStart = ctx.progress.itemCount;
  const syncer = new GithubRepoSyncer(
    client,
    target,
    ctx,
    'targeted',
    `github:${target.host.name}/${target.fullName}`,
  );
  syncer.attachRun(runId);

  const base = {
    runId,
    source: 'github' as const,
    target: `${target.fullName}#${number}`,
    mode: 'targeted' as const,
  };

  try {
    const { kind } = await syncer.syncSingleItem(number);
    const result: TargetSyncResult = {
      ...base,
      status: 'completed',
      apiCalls: ctx.progress.apiCallCount - callsAtStart,
      items: ctx.progress.itemCount - itemsAtStart,
    };
    ctx.journal.finishRun(runId, {
      status: 'completed',
      apiCalls: result.apiCalls,
      apiCallsExpected: ctx.progress.expectedApiCallCount,
      itemsSynced: result.items,
      details: { number, kind },
    });
    return result;
  } catch (error) {
    const message = errorMessage(error);
    ctx.journal.finishRun(runId, {
      status: 'failed',
      apiCalls: ctx.progress.apiCallCount - callsAtStart,
      apiCallsExpected: ctx.progress.expectedApiCallCount,
      itemsSynced: 0,
      error: message,
    });
    return {
      ...base,
      status: 'failed',
      apiCalls: ctx.progress.apiCallCount - callsAtStart,
      items: 0,
      error: message,
    };
  }
}

/** A resource whose work spans more than one phase, still being accounted. */
interface OpenOperation {
  id: number;
  cursorBefore: string | null;
  /** Accumulated across phases: the global counter also moves for other targets. */
  calls: number;
}

class GithubRepoSyncer {
  private ref: RepoRef;
  readonly summary: Record<string, number> = {};
  /** What the survey predicted per slice, so a partial walk cannot undercut it. */
  private readonly surveyed = new Map<string, number>();

  /** Numbers the list phase found, for the phases that fetch what hangs off them. */
  private readonly issueRefs: Array<{ id: number; number: number }> = [];
  private readonly pullRequestNumbers: number[] = [];
  /** Filled in the item phase: a pull request's own id, which reviews key on. */
  private readonly pullRequestIds = new Map<number, number>();
  private readonly workflowRunIds: number[] = [];
  /** List pages walked, so the detail phase can restate the whole slice. */
  private workflowRunPages = 0;

  /** Cursors computed while listing, written only once the details are in. */
  private issuesCursor: string | null = null;
  private pullRequestsCursor: string | null = null;
  private workflowRunsCursor: string | null = null;

  private readonly openOperations = new Map<string, OpenOperation>();

  /*
   * The progress counters are global, and the phases of every target now
   * interleave, so a delta taken across a phase would bill this target for
   * everything the others did in between. Both are accumulated per slice of
   * work instead.
   */
  private ownCalls = 0;
  private ownItems = 0;

  get apiCalls(): number {
    return this.ownCalls;
  }

  get items(): number {
    return this.ownItems;
  }

  /** Set once the journal run exists, which is after the survey. */
  private runId = 0;

  constructor(
    private readonly client: GithubClient,
    private readonly target: GithubRepoTarget,
    private readonly ctx: SyncContext,
    private readonly mode: SyncMode,
    private readonly scopePrefix: string,
  ) {
    this.ref = { host: target.host.name, repoId: 0, fullName: target.fullName };
  }

  attachRun(runId: number): void {
    this.runId = runId;
  }

  /**
   * Sizes the job before doing it, so the total is right from the first
   * percent rather than climbing as each resource is reached.
   *
   * One request per collection buys an exact item count (see
   * `client.countItems`), and every follow up call an item implies is known
   * from the configuration — so the arithmetic below is the whole sync, priced
   * up front. The survey's own requests are part of the sync's cost and are
   * counted like any other.
   *
   * Everything here is an estimate that the syncers revise through the same
   * keys as they learn the truth. Where a count cannot be had at all, the
   * expectation stays where the walk puts it.
   */
  async survey(): Promise<void> {
    const { sync } = this.target;
    const pageSize = 100;
    const key = (resource: string): string => `${this.scopePrefix}:${resource}`;
    let probes = 0;
    const probe = async (
      path: string,
      query: Record<string, string | number | boolean | undefined>,
    ): Promise<number | null> => {
      probes += 1;
      // The probes are requests like any other, so they belong in the total
      // they are being used to produce.
      this.seed(key('survey'), probes);
      return this.client.countItems(path, query);
    };

    // The repository itself, plus the small single page lists. Probing these
    // would cost as much as fetching them.
    this.seed(key('repository'), 1);
    if (sync.labels) this.seed(key('labels'), 1);
    if (sync.milestones) this.seed(key('milestones'), 1);
    if (sync.releases) this.seed(key('releases'), 1);
    if (sync.workflows) this.seed(key('workflows'), 1);

    if (sync.issues) {
      const since = this.resolveSince(key('issues'));
      const total = await probe(`/repos/${this.target.owner}/${this.target.repo}/issues`, {
        state: 'all',
        ...(since ? { since } : {}),
      });
      if (total !== null) {
        this.seed(key('issues'), this.issueCalls(total, pageSize));

        if (sync.pullRequests) {
          /*
           * Pull requests are a subset of that issue list, and which ones
           * cannot be known without walking it. The repository's pull request
           * count bounds the answer: on a first sync it *is* the answer, and
           * on an incremental one it is usually far larger than the handful of
           * items that changed, so the smaller of the two is the better guess.
           * The walk replaces this with the real number either way.
           */
          const pulls = await probe(`/repos/${this.target.owner}/${this.target.repo}/pulls`, {
            state: 'all',
          });
          if (pulls !== null) {
            this.seed(key('pull_requests'), this.pullRequestCalls(Math.min(total, pulls)));
          }
        }
      }
    }

    if (sync.workflowRuns) {
      const total = await probe(`/repos/${this.target.owner}/${this.target.repo}/actions/runs`, {});
      if (total !== null) {
        const runs = Math.min(total, this.target.maxWorkflowRuns);
        /*
         * List pages, one jobs call per run, and — when logs are on — one log
         * call per *job*.
         *
         * Neither API can be asked how many jobs a run has without listing
         * them, but the database was told last time. A repository whose runs
         * averaged four jobs yesterday will not average one today, so the
         * stored ratio prices the logs; the walk corrects it either way.
         */
        this.seed(
          key('workflow_runs'),
          Math.max(1, Math.ceil(runs / pageSize)) +
            (sync.workflowJobs ? runs : 0) +
            (sync.workflowJobs && sync.workflowLogs
              ? Math.round(runs * this.jobsPerRunEstimate())
              : 0),
        );
      }
    }
  }

  /** Jobs per run as the last sync saw it, or one when there is no history. */
  private jobsPerRunEstimate(): number {
    return jobsPerWorkflowRun(this.ctx.db, this.target.host.name, this.target.fullName) ?? 1;
  }

  /** Seeds a slice from the survey, remembering the figure for later. */
  private seed(key: string, calls: number): void {
    this.surveyed.set(key, calls);
    this.ctx.progress.expectFor(key, calls);
  }

  /**
   * Revises a slice from what the walk has actually seen, but never below what
   * the survey predicted.
   *
   * Half way through the pages the walk has only counted half the work, while
   * the survey already knew the total — dropping to the walk's figure there
   * would make the bar jump forward and then stall.
   */
  private reviseAtLeast(key: string, calls: number): void {
    this.ctx.progress.expectFor(key, Math.max(calls, this.surveyed.get(key) ?? 0));
  }

  /** List pages plus the comments and timeline of every issue. */
  private issueCalls(total: number, pageSize: number): number {
    const { sync } = this.target;
    const perItem = (sync.issueComments ? 1 : 0) + (sync.issueTimeline ? 1 : 0);
    return Math.max(1, Math.ceil(total / pageSize)) + total * perItem;
  }

  private pullRequestCalls(total: number): number {
    const { sync } = this.target;
    const perItem =
      1 +
      (sync.pullRequestReviews ? 1 : 0) +
      (sync.pullRequestComments ? 1 : 0) +
      (sync.pullRequestCommits ? 1 : 0) +
      (sync.pullRequestFiles ? 1 : 0);
    return total * perItem;
  }

  async runPhase(phase: SyncPhase): Promise<void> {
    if (phase === 'lists') return this.listEverything();
    if (phase === 'items') return this.fetchNamedItems();
    return this.fetchItemDetails();
  }

  /**
   * Phase one: every collection, and everything its pages already carry.
   *
   * Nothing here costs a request per item. When it finishes, the exact number
   * of issues, pull requests and workflow runs this run will touch is known.
   */
  private async listEverything(): Promise<void> {
    const { sync } = this.target;

    this.announce('repository');
    await this.slice('repository', () => this.syncRepository());

    if (sync.labels) await this.wholeOperation('labels', () => this.syncLabels());
    if (sync.milestones) await this.wholeOperation('milestones', () => this.syncMilestones());
    if (sync.releases) await this.wholeOperation('releases', () => this.syncReleases());
    if (sync.workflows) await this.wholeOperation('workflows', () => this.syncWorkflows());

    if (sync.issues) {
      this.announce('issues');
      this.beginOperation('issues');
      await this.slice('issues', () => this.listIssues());
    }

    if (sync.workflowRuns) {
      this.announce('workflow runs');
      this.beginOperation('workflow_runs');
      await this.slice('workflow_runs', () => this.listWorkflowRuns());
    }
  }

  /** Phase two: the individual things the lists only named. */
  private async fetchNamedItems(): Promise<void> {
    if (!this.target.sync.pullRequests) return;

    this.announce('pull requests');
    this.beginOperation('pull_requests');
    await this.slice('pull_requests', () => this.fetchPullRequests());
  }

  /** Phase three: what hangs off an individual item. */
  private async fetchItemDetails(): Promise<void> {
    const { sync } = this.target;

    if (sync.issues) {
      this.announce('comments and timelines');
      await this.slice('issues', () => this.fetchIssueDetails());
      this.endOperation('issues', { items: this.issueRefs.length, cursor: this.issuesCursor });
    }

    if (sync.pullRequests) {
      this.announce('reviews, commits and files');
      await this.slice('pull_requests', () => this.fetchPullRequestDetails());
      this.endOperation('pull_requests', {
        items: this.pullRequestNumbers.length,
        cursor: this.pullRequestsCursor,
      });
    }

    if (sync.workflowRuns) {
      if (sync.workflowJobs) {
        this.announce('workflow jobs');
        await this.slice('workflow_runs', () => this.fetchWorkflowJobs());
      }
      this.endOperation('workflow_runs', {
        items: this.workflowRunIds.length,
        cursor: this.workflowRunsCursor,
      });
    }
  }

  private announce(what: string): void {
    this.ctx.progress.setPhase(`${this.target.fullName}: ${what}`);
  }

  /**
   * Runs a slice of one resource's work, billing its cost to that resource and
   * to this target.
   *
   * The counters it reads from are global and every target now moves them, so
   * only the delta across this call is this target's.
   */
  private async slice<T>(resource: string, fn: () => Promise<T>): Promise<T> {
    const callsBefore = this.ctx.progress.apiCallCount;
    const itemsBefore = this.ctx.progress.itemCount;
    try {
      return await fn();
    } finally {
      const calls = this.ctx.progress.apiCallCount - callsBefore;
      this.ownCalls += calls;
      this.ownItems += this.ctx.progress.itemCount - itemsBefore;
      const open = this.openOperations.get(resource);
      if (open) open.calls += calls;
    }
  }

  /** A resource that begins and ends inside a single phase. */
  private async wholeOperation(resource: string, fn: () => Promise<OperationStats>): Promise<void> {
    this.announce(resource.replace(/_/g, ' '));
    this.beginOperation(resource);
    const stats = await this.slice(resource, fn);
    this.endOperation(resource, stats);
  }

  private beginOperation(resource: string): void {
    if (this.openOperations.has(resource)) return;
    const scope = `${this.scopePrefix}:${resource}`;
    const cursorBefore = this.ctx.journal.getCursor(scope);
    this.openOperations.set(resource, {
      id: this.ctx.journal.startOperation({
        runId: this.runId,
        resource,
        scope,
        cursorBefore,
      }),
      cursorBefore,
      calls: 0,
    });
  }

  /**
   * Closes a resource and advances its cursor.
   *
   * The cursor moves here and nowhere else, which is why a resource spanning
   * phases only ends in the last one: a cursor written after the list phase
   * would claim items are synced whose comments were never fetched.
   */
  private endOperation(resource: string, stats: OperationStats): void {
    const open = this.openOperations.get(resource);
    if (!open) return;
    this.openOperations.delete(resource);

    const scope = `${this.scopePrefix}:${resource}`;
    const cursor = stats.cursor ?? open.cursorBefore;
    this.summary[resource] = stats.items;

    this.ctx.journal.finishOperation(open.id, {
      status: 'completed',
      apiCalls: open.calls,
      itemsSynced: stats.items,
      cursorAfter: cursor,
    });
    if (!this.ctx.dryRun) {
      this.ctx.journal.setState({
        scope,
        source: 'github',
        target: this.target.fullName,
        resource,
        cursor,
        runId: this.runId,
        fullSync: this.mode === 'initial',
      });
    }
  }

  /**
   * Marks whatever was still in flight as failed, without moving its cursor.
   *
   * A phase now throws out to the runner rather than being caught here, so this
   * is what keeps a half finished resource from being recorded as complete.
   */
  abandonOpenOperations(error: unknown): void {
    const message = errorMessage(error);
    for (const open of this.openOperations.values()) {
      this.ctx.journal.finishOperation(open.id, {
        status: 'failed',
        apiCalls: open.calls,
        itemsSynced: 0,
        error: message,
      });
    }
    this.openOperations.clear();
  }

  private write(table: string, row: Row | null): void {
    if (!row || this.ctx.dryRun) return;
    this.ctx.db.upsert(table, row);
  }

  private countItem(count = 1): void {
    this.ctx.progress.recordItems(count);
  }

  private async syncRepository(): Promise<void> {
    const raw = await this.client.getRepository(this.target.owner, this.target.repo);
    const syncedAt = nowIso();
    const repoId = num(raw, 'id') ?? 0;
    this.ref = {
      host: this.target.host.name,
      repoId,
      fullName: str(raw, 'full_name') ?? this.target.fullName,
    };
    this.write('gh_repositories', map.mapRepository(raw, this.ref.host, syncedAt));
    this.countItem();
  }

  private async syncLabels(): Promise<OperationStats> {
    const labels = await this.client.labels(this.target.owner, this.target.repo);
    const syncedAt = nowIso();
    for (const label of labels) {
      this.write('gh_labels', map.mapLabel(label, this.ref, syncedAt));
    }
    this.countItem(labels.length);
    return { items: labels.length, cursor: syncedAt };
  }

  private async syncMilestones(): Promise<OperationStats> {
    const milestones = await this.client.milestones(this.target.owner, this.target.repo);
    const syncedAt = nowIso();
    for (const milestone of milestones) {
      this.write('gh_milestones', map.mapMilestone(milestone, this.ref, syncedAt));
    }
    this.countItem(milestones.length);
    return { items: milestones.length, cursor: syncedAt };
  }

  private async syncReleases(): Promise<OperationStats> {
    const releases = await this.client.releases(this.target.owner, this.target.repo);
    const syncedAt = nowIso();
    for (const release of releases) {
      this.write('gh_releases', map.mapRelease(release, this.ref, syncedAt));
    }
    this.countItem(releases.length);
    return { items: releases.length, cursor: syncedAt };
  }

  /**
   * Walks the issue list, which contains pull requests as well.
   *
   * Only what the pages already carry is written. The comments and the
   * timeline of each item cost a request each and belong to the last phase;
   * what this leaves behind is the exact set of numbers they will be fetched
   * for.
   */
  private async listIssues(): Promise<void> {
    const scope = `${this.scopePrefix}:issues`;
    const since = this.resolveSince(scope);

    let newestUpdate = since;
    let pages = 0;

    for await (const page of this.client.issues(this.target.owner, this.target.repo, {
      since,
      state: 'all',
    })) {
      pages += 1;
      if (page.length === 0) continue;

      for (const raw of page) {
        const issueNumber = num(raw, 'number') ?? 0;
        this.writeIssueRow(raw);
        this.issueRefs.push({ id: num(raw, 'id') ?? 0, number: issueNumber });
        if (map.isPullRequest(raw)) this.pullRequestNumbers.push(issueNumber);

        const updatedAt = str(raw, 'updated_at');
        if (updatedAt && (!newestUpdate || updatedAt > newestUpdate)) newestUpdate = updatedAt;
        this.countItem();
      }

      // The list is walked here and only the list; the per item calls the
      // survey folded into the same slice are still ahead.
      this.reviseAtLeast(scope, pages + this.issueRefs.length * this.perIssueCalls());
    }

    this.issuesCursor = newestUpdate ?? nowIso();
  }

  private perIssueCalls(): number {
    const { sync } = this.target;
    return (sync.issueComments ? 1 : 0) + (sync.issueTimeline ? 1 : 0);
  }

  /** The parts of an issue that arrive with the list page, for free. */
  private writeIssueRow(raw: JsonObject): void {
    const syncedAt = nowIso();
    this.write('gh_issues', map.mapIssue(raw, this.ref, syncedAt));
    for (const row of map.issueLabelRows(raw, this.ref.host)) {
      this.write('gh_issue_labels', row);
    }
    for (const row of map.issueAssigneeRows(raw, this.ref.host)) {
      this.write('gh_issue_assignees', row);
    }
    this.writeUser(raw['user'], syncedAt);
  }

  /** The comments and the timeline of every issue the list phase found. */
  private async fetchIssueDetails(): Promise<void> {
    for (const issue of this.issueRefs) {
      await this.writeIssueDetails(issue);
    }
  }

  /**
   * Comments and the complete timeline of one issue, so label changes,
   * assignments, closes and reopens are all preserved. Shared with the targeted
   * sync of a single item, so both store exactly the same rows.
   */
  private async writeIssueDetails(issue: { id: number; number: number }): Promise<void> {
    const { sync } = this.target;

    if (sync.issueComments) {
      const comments = await this.client.issueComments(
        this.target.owner,
        this.target.repo,
        issue.number,
      );
      const syncedAt = nowIso();
      for (const comment of comments) {
        this.write('gh_comments', map.mapComment(comment, this.ref, issue, syncedAt));
        this.writeUser(comment['user'], syncedAt);
      }
    }

    if (sync.issueTimeline) {
      const timeline = await this.client.issueTimeline(
        this.target.owner,
        this.target.repo,
        issue.number,
      );
      const syncedAt = nowIso();
      timeline.forEach((event, index) => {
        this.write('gh_events', map.mapTimelineEvent(event, this.ref, issue, index, syncedAt));
      });
    }
  }

  /**
   * The detailed payload of every pull request the issue list named: additions,
   * deletions, merge state — none of which the issue form carries.
   */
  private async fetchPullRequests(): Promise<void> {
    // The survey could only bound this from the repository's total. The issue
    // walk has since produced the exact set, so the estimate is replaced.
    this.ctx.progress.expectFor(
      `${this.scopePrefix}:pull_requests`,
      this.pullRequestCalls(this.pullRequestNumbers.length),
    );

    let newestUpdate: string | null = null;

    for (const number of this.pullRequestNumbers) {
      const raw = await this.client.pullRequest(this.target.owner, this.target.repo, number);
      const syncedAt = nowIso();
      this.write('gh_pull_requests', map.mapPullRequest(raw, this.ref, syncedAt));
      this.writeUser(raw['user'], syncedAt);
      this.pullRequestIds.set(number, num(raw, 'id') ?? 0);
      this.countItem();

      const updatedAt = str(raw, 'updated_at');
      if (updatedAt && (!newestUpdate || updatedAt > newestUpdate)) newestUpdate = updatedAt;
    }

    this.pullRequestsCursor = newestUpdate ?? nowIso();
  }

  private async fetchPullRequestDetails(): Promise<void> {
    for (const number of this.pullRequestNumbers) {
      await this.writePullRequestDetails(number);
    }
  }

  /**
   * Every review, every inline review comment, the commit list and the changed
   * files of one pull request. Shared with the targeted sync.
   */
  private async writePullRequestDetails(number: number): Promise<void> {
    const { sync } = this.target;
    // A pull request's own id is not its issue id, and the review rows key on
    // it. Phase two learned it; carrying it here beats reading it back.
    const pr = { id: this.pullRequestIds.get(number) ?? 0, number };

    if (sync.pullRequestReviews) {
      const reviews = await this.client.pullRequestReviews(
        this.target.owner,
        this.target.repo,
        number,
      );
      const syncedAt = nowIso();
      for (const review of reviews) {
        this.write('gh_reviews', map.mapReview(review, this.ref, pr, syncedAt));
        this.writeUser(review['user'], syncedAt);
      }
    }

    if (sync.pullRequestComments) {
      const comments = await this.client.pullRequestReviewComments(
        this.target.owner,
        this.target.repo,
        number,
      );
      const syncedAt = nowIso();
      for (const comment of comments) {
        this.write('gh_review_comments', map.mapReviewComment(comment, this.ref, pr, syncedAt));
        this.writeUser(comment['user'], syncedAt);
      }
    }

    if (sync.pullRequestCommits) {
      const commits = await this.client.pullRequestCommits(
        this.target.owner,
        this.target.repo,
        number,
      );
      for (const commit of commits) {
        this.write('gh_commits', map.mapCommit(commit, this.ref, pr, nowIso()));
      }
    }

    if (sync.pullRequestFiles) {
      const files = await this.client.pullRequestFiles(this.target.owner, this.target.repo, number);
      for (const file of files) {
        this.write('gh_pull_request_files', map.mapPullRequestFile(file, this.ref, pr, nowIso()));
      }
    }
  }

  /**
   * Syncs a single issue or pull request, without touching any cursor.
   *
   * Leaving the cursors alone is the whole point: the item may have been
   * updated after things the regular sync has not fetched yet, and advancing a
   * cursor to its timestamp would skip everything in between, permanently. The
   * follow up sync therefore still starts from the old cursor and simply writes
   * this item again, which is a no-op because every write is an upsert.
   */
  async syncSingleItem(number: number): Promise<{ kind: 'issue' | 'pull_request' }> {
    this.ctx.progress.setPhase(`${this.target.fullName}#${number}`);
    this.ctx.progress.expect(4);

    await this.syncRepository();

    const raw = await this.client.issue(this.target.owner, this.target.repo, number);
    const issue = { id: num(raw, 'id') ?? 0, number };
    this.writeIssueRow(raw);
    await this.writeIssueDetails(issue);
    this.countItem();

    if (map.isPullRequest(raw) && this.target.sync.pullRequests) {
      const pull = await this.client.pullRequest(this.target.owner, this.target.repo, number);
      const syncedAt = nowIso();
      this.write('gh_pull_requests', map.mapPullRequest(pull, this.ref, syncedAt));
      this.writeUser(pull['user'], syncedAt);
      this.pullRequestIds.set(number, num(pull, 'id') ?? 0);
      await this.writePullRequestDetails(number);
      return { kind: 'pull_request' };
    }
    return { kind: 'issue' };
  }

  private async syncWorkflows(): Promise<OperationStats> {
    const workflows = await this.client.workflows(this.target.owner, this.target.repo);
    const syncedAt = nowIso();
    for (const workflow of workflows) {
      this.write('gh_workflows', map.mapWorkflow(workflow, this.ref, syncedAt));
    }
    this.countItem(workflows.length);
    return { items: workflows.length, cursor: syncedAt };
  }

  /**
   * Walks the workflow run list, newest first, and stops at the cursor or at
   * `maxWorkflowRuns`. The jobs of each run are a request each and belong to
   * the last phase.
   */
  private async listWorkflowRuns(): Promise<void> {
    const scope = `${this.scopePrefix}:workflow_runs`;
    const since = this.resolveSince(scope);
    const { sync } = this.target;

    let newest: string | null = null;

    outer: for await (const page of this.client.workflowRuns(this.target.owner, this.target.repo, {
      created: since,
    })) {
      this.workflowRunPages += 1;

      for (const raw of page) {
        const createdAt = str(raw, 'created_at');
        if (since && createdAt && createdAt < since && !this.ctx.full) break outer;
        if (this.workflowRunIds.length >= this.target.maxWorkflowRuns) {
          this.ctx.progress.log(
            `Stopping after ${this.target.maxWorkflowRuns} workflow runs for ${this.target.fullName} (maxWorkflowRuns).`,
          );
          break outer;
        }

        this.write('gh_workflow_runs', map.mapWorkflowRun(raw, this.ref, nowIso()));
        this.workflowRunIds.push(num(raw, 'id') ?? 0);
        this.countItem();

        if (createdAt && (!newest || createdAt > newest)) newest = createdAt;
      }

      // The walk stops at maxWorkflowRuns or at the cursor, neither of which a
      // count of runs can know, so this replaces the survey's figure once it
      // grows past it. The logs, priced per job, are still ahead.
      this.reviseAtLeast(
        scope,
        this.workflowRunPages +
          (sync.workflowJobs ? this.workflowRunIds.length : 0) +
          (sync.workflowJobs && sync.workflowLogs
            ? Math.round(this.workflowRunIds.length * this.jobsPerRunEstimate())
            : 0),
      );
    }

    this.workflowRunsCursor = newest ?? since;
  }

  /** The jobs of every run listed, which carry the steps, and their logs. */
  private async fetchWorkflowJobs(): Promise<void> {
    const { sync } = this.target;
    const runs = this.workflowRunIds.length;
    let jobsSeen = 0;
    let runsDone = 0;

    for (const runId of this.workflowRunIds) {
      const jobs = await this.client.workflowRunJobs(this.target.owner, this.target.repo, runId);
      jobsSeen += jobs.length;
      runsDone += 1;

      if (sync.workflowLogs) {
        /*
         * The whole slice, restated: the list pages, one jobs call per run,
         * and one log per job — with the runs not yet reached priced from the
         * ones that have been.
         *
         * This is set rather than raised, because by now the walk knows better
         * than the survey did. Yesterday's ratio got the first percent right;
         * today's, measured on this run, gets the rest right.
         */
        this.ctx.progress.expectFor(
          `${this.scopePrefix}:workflow_runs`,
          this.workflowRunPages + runs + Math.round((runs * jobsSeen) / runsDone),
        );
      }

      for (const job of jobs) {
        const syncedAt = nowIso();
        this.write('gh_workflow_jobs', map.mapWorkflowJob(job, this.ref, syncedAt));
        for (const step of map.mapWorkflowSteps(job, this.ref.host, syncedAt)) {
          this.write('gh_workflow_steps', step);
        }
        if (sync.workflowLogs) await this.syncJobLog(num(job, 'id') ?? 0, runId);
      }
    }
  }

  private async syncJobLog(jobId: number, runId: number): Promise<void> {
    if (jobId === 0) return;
    const existing = this.ctx.db.get<{ job_id: number }>(
      'SELECT job_id FROM gh_job_logs WHERE host = ? AND job_id = ?',
      [this.ref.host, jobId],
    );
    if (existing && !this.ctx.full) return;

    const log = await this.client.jobLogs(this.target.owner, this.target.repo, jobId);
    if (log === null) return;

    const truncated = log.length > this.target.maxLogBytes;
    this.write('gh_job_logs', {
      host: this.ref.host,
      job_id: jobId,
      repo_id: this.ref.repoId,
      run_id: runId,
      size_bytes: log.length,
      truncated,
      content: truncated ? log.slice(0, this.target.maxLogBytes) : log,
      fetched_at: nowIso(),
    });
  }

  private writeUser(raw: unknown, syncedAt: string): void {
    if (!raw || typeof raw !== 'object') return;
    const row = map.mapUser(raw as JsonObject, this.ref.host, syncedAt);
    this.write('gh_users', row);
  }

  /** The stored cursor, unless the user asked for a full sync. */
  private resolveSince(scope: string): string | null {
    if (this.ctx.full) return this.target.since;
    return this.ctx.journal.getCursor(scope) ?? this.target.since;
  }
}
