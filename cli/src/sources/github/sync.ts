import type { GithubRepoTarget } from '../../config/types.js';
import type { SyncContext, TargetPlan, TargetSyncResult } from '../../sync/types.js';
import type { SyncMode } from '../../db/journal.js';
import { errorMessage } from '../../util/errors.js';
import { num, str } from '../../util/json.js';
import type { JsonObject } from '../../util/json.js';
import { nowIso } from '../../util/time.js';
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

  return {
    label: target.fullName,
    survey: () => syncer.survey(),
    run: () => runGithubRepository(target, ctx, syncer, mode),
  };
}

/** Syncs one GitHub repository into the database, sizing it first. */
export async function syncGithubRepository(
  target: GithubRepoTarget,
  ctx: SyncContext,
): Promise<TargetSyncResult> {
  const plan = planGithubRepository(target, ctx);
  await plan.survey();
  return plan.run();
}

async function runGithubRepository(
  target: GithubRepoTarget,
  ctx: SyncContext,
  syncer: GithubRepoSyncer,
  mode: SyncMode,
): Promise<TargetSyncResult> {
  const runId = ctx.journal.startRun({
    projectKey: ctx.projectKey,
    source: 'github',
    target: target.fullName,
    mode,
  });
  syncer.attachRun(runId);

  const callsAtStart = ctx.progress.apiCallCount;
  const itemsAtStart = ctx.progress.itemCount;

  try {
    await syncer.run();
    const result: TargetSyncResult = {
      runId,
      source: 'github',
      target: target.fullName,
      mode,
      status: 'completed',
      apiCalls: ctx.progress.apiCallCount - callsAtStart,
      items: ctx.progress.itemCount - itemsAtStart,
    };
    ctx.journal.finishRun(runId, {
      status: 'completed',
      apiCalls: result.apiCalls,
      apiCallsExpected: ctx.progress.expectedApiCallCount,
      itemsSynced: result.items,
      details: syncer.summary,
    });
    return result;
  } catch (error) {
    const message = errorMessage(error);
    ctx.journal.finishRun(runId, {
      status: 'failed',
      apiCalls: ctx.progress.apiCallCount - callsAtStart,
      apiCallsExpected: ctx.progress.expectedApiCallCount,
      itemsSynced: ctx.progress.itemCount - itemsAtStart,
      error: message,
      details: syncer.summary,
    });
    return {
      runId,
      source: 'github',
      target: target.fullName,
      mode,
      status: 'failed',
      apiCalls: ctx.progress.apiCallCount - callsAtStart,
      items: ctx.progress.itemCount - itemsAtStart,
      error: message,
    };
  }
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

class GithubRepoSyncer {
  private ref: RepoRef;
  readonly summary: Record<string, number> = {};
  /** Pull requests discovered while walking the issue list. */
  private readonly pendingPullRequests = new Map<number, JsonObject>();
  /** What the survey predicted per slice, so a partial walk cannot undercut it. */
  private readonly surveyed = new Map<string, number>();

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
        // One list page per `pageSize` runs, plus one job call per run. The
        // logs are per job, which only the run itself reveals.
        /*
         * List pages, one job call per run, and — when logs are on — one log
         * per job. How many jobs a run has is only known once it is fetched,
         * so one per run is the assumption; the walk corrects it.
         */
        this.seed(
          key('workflow_runs'),
          Math.max(1, Math.ceil(runs / pageSize)) +
            (sync.workflowJobs ? runs : 0) +
            (sync.workflowJobs && sync.workflowLogs ? runs : 0),
        );
      }
    }
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

  async run(): Promise<void> {
    const { sync } = this.target;

    this.ctx.progress.setPhase(`${this.target.fullName}: repository`);
    await this.syncRepository();

    if (sync.labels) await this.operation('labels', () => this.syncLabels());
    if (sync.milestones) await this.operation('milestones', () => this.syncMilestones());
    if (sync.releases) await this.operation('releases', () => this.syncReleases());
    if (sync.issues) await this.operation('issues', () => this.syncIssues());
    if (sync.pullRequests) await this.operation('pull_requests', () => this.syncPullRequests());
    if (sync.workflows) await this.operation('workflows', () => this.syncWorkflows());
    if (sync.workflowRuns) await this.operation('workflow_runs', () => this.syncWorkflowRuns());
  }

  /** Wraps a resource sync in journal bookkeeping and cursor handling. */
  private async operation(resource: string, fn: () => Promise<OperationStats>): Promise<void> {
    const scope = `${this.scopePrefix}:${resource}`;
    const cursorBefore = this.ctx.journal.getCursor(scope);
    const operationId = this.ctx.journal.startOperation({
      runId: this.runId,
      resource,
      scope,
      cursorBefore,
    });
    const callsBefore = this.ctx.progress.apiCallCount;
    this.ctx.progress.setPhase(`${this.target.fullName}: ${resource.replace(/_/g, ' ')}`);

    try {
      const stats = await fn();
      this.summary[resource] = stats.items;
      this.ctx.journal.finishOperation(operationId, {
        status: 'completed',
        apiCalls: this.ctx.progress.apiCallCount - callsBefore,
        itemsSynced: stats.items,
        cursorAfter: stats.cursor ?? cursorBefore,
      });
      if (!this.ctx.dryRun) {
        this.ctx.journal.setState({
          scope,
          source: 'github',
          target: this.target.fullName,
          resource,
          cursor: stats.cursor ?? cursorBefore,
          runId: this.runId,
          fullSync: this.mode === 'initial',
        });
      }
    } catch (error) {
      this.ctx.journal.finishOperation(operationId, {
        status: 'failed',
        apiCalls: this.ctx.progress.apiCallCount - callsBefore,
        itemsSynced: 0,
        error: errorMessage(error),
      });
      throw error;
    }
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
   * Walks the issue list (which contains pull requests as well). For every item
   * the comments and the complete timeline are downloaded, so label changes,
   * assignments, closes and reopens are all preserved.
   */
  private async syncIssues(): Promise<OperationStats> {
    const scope = `${this.scopePrefix}:issues`;
    const since = this.resolveSince(scope);
    const { sync } = this.target;
    const perItemCalls = (sync.issueComments ? 1 : 0) + (sync.issueTimeline ? 1 : 0);

    let items = 0;
    let newestUpdate = since;
    let seen = 0;
    let pages = 0;

    for await (const page of this.client.issues(this.target.owner, this.target.repo, {
      since,
      state: 'all',
    })) {
      pages += 1;
      if (page.length === 0) continue;
      seen += page.length;

      // Replaces the survey's figure rather than adding to it: the same slice
      // of work, now counted exactly as far as the walk has got.
      this.reviseAtLeast(scope, pages + seen * perItemCalls);

      for (const raw of page) {
        const updatedAt = await this.writeIssuePayload(raw);
        if (updatedAt && (!newestUpdate || updatedAt > newestUpdate)) newestUpdate = updatedAt;
        items += 1;
        this.countItem();
      }
    }

    return { items, cursor: newestUpdate ?? nowIso() };
  }

  /**
   * Writes one issue (or the issue side of a pull request) with its comments
   * and its timeline. Shared by the list walk and by a targeted sync of a
   * single item, so both store exactly the same rows.
   */
  private async writeIssuePayload(raw: JsonObject): Promise<string | null> {
    const { sync } = this.target;
    const issueId = num(raw, 'id') ?? 0;
    const issueNumber = num(raw, 'number') ?? 0;
    const syncedAt = nowIso();

    this.write('gh_issues', map.mapIssue(raw, this.ref, syncedAt));
    for (const row of map.issueLabelRows(raw, this.ref.host)) {
      this.write('gh_issue_labels', row);
    }
    for (const row of map.issueAssigneeRows(raw, this.ref.host)) {
      this.write('gh_issue_assignees', row);
    }
    this.writeUser(raw['user'], syncedAt);

    if (map.isPullRequest(raw)) {
      this.pendingPullRequests.set(issueNumber, raw);
    }

    if (sync.issueComments) {
      const comments = await this.client.issueComments(
        this.target.owner,
        this.target.repo,
        issueNumber,
      );
      const commentsSyncedAt = nowIso();
      for (const comment of comments) {
        this.write(
          'gh_comments',
          map.mapComment(comment, this.ref, { id: issueId, number: issueNumber }, commentsSyncedAt),
        );
        this.writeUser(comment['user'], commentsSyncedAt);
      }
    }

    if (sync.issueTimeline) {
      const timeline = await this.client.issueTimeline(
        this.target.owner,
        this.target.repo,
        issueNumber,
      );
      const timelineSyncedAt = nowIso();
      timeline.forEach((event, index) => {
        this.write(
          'gh_events',
          map.mapTimelineEvent(
            event,
            this.ref,
            { id: issueId, number: issueNumber },
            index,
            timelineSyncedAt,
          ),
        );
      });
    }

    return str(raw, 'updated_at');
  }

  /**
   * Pull requests found in the issue phase are fetched in full: the detailed
   * payload (additions, merge state, ...), every review, every review comment,
   * the commit list and the changed files.
   */
  private async syncPullRequests(): Promise<OperationStats> {
    const numbers = [...this.pendingPullRequests.keys()].toSorted((a, b) => a - b);

    // The survey could only bound this; the issue walk has since produced the
    // exact set, so the estimate is replaced with the real figure.
    this.ctx.progress.expectFor(
      `${this.scopePrefix}:pull_requests`,
      this.pullRequestCalls(numbers.length),
    );

    let items = 0;
    let newestUpdate: string | null = null;

    for (const number of numbers) {
      const updatedAt = await this.writePullRequestPayload(number);
      if (updatedAt && (!newestUpdate || updatedAt > newestUpdate)) newestUpdate = updatedAt;
      items += 1;
      this.countItem();
    }

    return { items, cursor: newestUpdate ?? nowIso() };
  }

  /**
   * Fetches and writes one pull request in full. Shared by the list walk and by
   * a targeted sync, so a single pull request lands with exactly the same rows.
   */
  private async writePullRequestPayload(number: number): Promise<string | null> {
    const { sync } = this.target;
    const raw = await this.client.pullRequest(this.target.owner, this.target.repo, number);
    const syncedAt = nowIso();
    const pr = { id: num(raw, 'id') ?? 0, number };

    this.write('gh_pull_requests', map.mapPullRequest(raw, this.ref, syncedAt));
    this.writeUser(raw['user'], syncedAt);

    if (sync.pullRequestReviews) {
      const reviews = await this.client.pullRequestReviews(
        this.target.owner,
        this.target.repo,
        number,
      );
      for (const review of reviews) {
        this.write('gh_reviews', map.mapReview(review, this.ref, pr, nowIso()));
        this.writeUser(review['user'], syncedAt);
      }
    }

    if (sync.pullRequestComments) {
      const comments = await this.client.pullRequestReviewComments(
        this.target.owner,
        this.target.repo,
        number,
      );
      for (const comment of comments) {
        this.write('gh_review_comments', map.mapReviewComment(comment, this.ref, pr, nowIso()));
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

    return str(raw, 'updated_at');
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
    await this.writeIssuePayload(raw);
    this.countItem();

    if (map.isPullRequest(raw) && this.target.sync.pullRequests) {
      await this.writePullRequestPayload(number);
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
   * Workflow runs are listed newest first. Every run gets its jobs (which carry
   * the steps) and, when enabled, the complete log of each job.
   */
  private async syncWorkflowRuns(): Promise<OperationStats> {
    const scope = `${this.scopePrefix}:workflow_runs`;
    const since = this.resolveSince(scope);
    const { sync } = this.target;

    let items = 0;
    let newest: string | null = null;
    let processed = 0;
    let pages = 0;

    outer: for await (const page of this.client.workflowRuns(this.target.owner, this.target.repo, {
      created: since,
    })) {
      pages += 1;
      // The list calls made so far, plus one job call for each run they
      // yielded. The walk stops at maxWorkflowRuns or at the cursor, neither
      // of which a count of runs can know, so this replaces the survey's
      // figure once it grows past it.
      const seenRuns = processed + page.length;
      this.reviseAtLeast(scope, pages + (sync.workflowJobs ? seenRuns : 0));

      for (const raw of page) {
        const createdAt = str(raw, 'created_at');
        if (since && createdAt && createdAt < since && !this.ctx.full) break outer;
        if (processed >= this.target.maxWorkflowRuns) {
          this.ctx.progress.log(
            `Stopping after ${this.target.maxWorkflowRuns} workflow runs for ${this.target.fullName} (maxWorkflowRuns).`,
          );
          break outer;
        }

        const runId = num(raw, 'id') ?? 0;
        this.write('gh_workflow_runs', map.mapWorkflowRun(raw, this.ref, nowIso()));
        processed += 1;
        items += 1;
        this.countItem();

        if (sync.workflowJobs) {
          const jobs = await this.client.workflowRunJobs(
            this.target.owner,
            this.target.repo,
            runId,
          );
          if (sync.workflowLogs) this.ctx.progress.expect(jobs.length);

          for (const job of jobs) {
            const jobSyncedAt = nowIso();
            this.write('gh_workflow_jobs', map.mapWorkflowJob(job, this.ref, jobSyncedAt));
            for (const step of map.mapWorkflowSteps(job, this.ref.host, jobSyncedAt)) {
              this.write('gh_workflow_steps', step);
            }

            if (sync.workflowLogs) {
              await this.syncJobLog(num(job, 'id') ?? 0, runId);
            }
          }
        }

        if (createdAt && (!newest || createdAt > newest)) newest = createdAt;
      }
    }

    return { items, cursor: newest ?? since };
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
