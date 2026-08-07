import type { GithubRepoTarget } from '../../config/types.js';
import type { SyncContext, TargetSyncResult } from '../../sync/types.js';
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

/** Syncs one GitHub repository into the database. */
export async function syncGithubRepository(
  target: GithubRepoTarget,
  ctx: SyncContext,
): Promise<TargetSyncResult> {
  const client = new GithubClient({
    host: target.host,
    settings: ctx.config.sync,
    progress: ctx.progress,
    logger: ctx.logger,
  });

  const scopePrefix = `github:${target.host.name}/${target.fullName}`;
  const hasCursor = ctx.journal.getState(`${scopePrefix}:issues`) !== undefined;
  const mode: SyncMode = ctx.full || !hasCursor ? 'initial' : 'incremental';

  const runId = ctx.journal.startRun({
    projectKey: ctx.projectKey,
    source: 'github',
    target: target.fullName,
    mode,
  });

  const callsAtStart = ctx.progress.apiCallCount;
  const itemsAtStart = ctx.progress.itemCount;

  const syncer = new GithubRepoSyncer(client, target, ctx, runId, mode, scopePrefix);

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

class GithubRepoSyncer {
  private ref: RepoRef;
  readonly summary: Record<string, number> = {};
  /** Pull requests discovered while walking the issue list. */
  private readonly pendingPullRequests = new Map<number, JsonObject>();

  constructor(
    private readonly client: GithubClient,
    private readonly target: GithubRepoTarget,
    private readonly ctx: SyncContext,
    private readonly runId: number,
    private readonly mode: SyncMode,
    private readonly scopePrefix: string,
  ) {
    this.ref = { host: target.host.name, repoId: 0, fullName: target.fullName };
  }

  async run(): Promise<void> {
    const { sync } = this.target;

    this.ctx.progress.setPhase(`${this.target.fullName}: repository`);
    this.ctx.progress.expect(1);
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

    for await (const page of this.client.issues(this.target.owner, this.target.repo, {
      since,
      state: 'all',
    })) {
      if (page.length === 0) continue;
      // Every issue on this page needs its own follow up calls.
      this.ctx.progress.expect(page.length * perItemCalls);

      for (const raw of page) {
        const issueId = num(raw, 'id') ?? 0;
        const issueNumber = num(raw, 'number') ?? 0;
        const updatedAt = str(raw, 'updated_at');
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
              map.mapComment(
                comment,
                this.ref,
                { id: issueId, number: issueNumber },
                commentsSyncedAt,
              ),
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

        if (updatedAt && (!newestUpdate || updatedAt > newestUpdate)) newestUpdate = updatedAt;
        items += 1;
        this.countItem();
      }
    }

    return { items, cursor: newestUpdate ?? nowIso() };
  }

  /**
   * Pull requests found in the issue phase are fetched in full: the detailed
   * payload (additions, merge state, ...), every review, every review comment,
   * the commit list and the changed files.
   */
  private async syncPullRequests(): Promise<OperationStats> {
    const { sync } = this.target;
    const numbers = [...this.pendingPullRequests.keys()].toSorted((a, b) => a - b);

    const perItemCalls =
      1 +
      (sync.pullRequestReviews ? 1 : 0) +
      (sync.pullRequestComments ? 1 : 0) +
      (sync.pullRequestCommits ? 1 : 0) +
      (sync.pullRequestFiles ? 1 : 0);
    this.ctx.progress.expect(numbers.length * perItemCalls);

    let items = 0;
    let newestUpdate: string | null = null;

    for (const number of numbers) {
      const raw = await this.client.pullRequest(this.target.owner, this.target.repo, number);
      const syncedAt = nowIso();
      const prId = num(raw, 'id') ?? 0;
      const pr = { id: prId, number };

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
        const files = await this.client.pullRequestFiles(
          this.target.owner,
          this.target.repo,
          number,
        );
        for (const file of files) {
          this.write('gh_pull_request_files', map.mapPullRequestFile(file, this.ref, pr, nowIso()));
        }
      }

      const updatedAt = str(raw, 'updated_at');
      if (updatedAt && (!newestUpdate || updatedAt > newestUpdate)) newestUpdate = updatedAt;
      items += 1;
      this.countItem();
    }

    return { items, cursor: newestUpdate ?? nowIso() };
  }

  private async syncWorkflows(): Promise<OperationStats> {
    this.ctx.progress.expect(1);
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

    outer: for await (const page of this.client.workflowRuns(this.target.owner, this.target.repo, {
      created: since,
    })) {
      if (sync.workflowJobs) this.ctx.progress.expect(page.length);

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
