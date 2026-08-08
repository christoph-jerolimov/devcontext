import type {
  GithubRepoTarget,
  JiraProjectTarget,
  ProjectConfig,
  ResolvedConfig,
} from '../config/types.js';
import { Database } from '../db/database.js';
import { SyncJournal } from '../db/journal.js';
import { exportOutputs } from '../exporters/index.js';
import type { ExportSummary } from '../exporters/index.js';
import { buildStateHistory } from '../history/build.js';
import type { StateHistoryStats } from '../history/build.js';
import { buildCrossLinks } from '../links/build.js';
import { storeDirectory } from '../people/store.js';
import { buildSearchIndex } from '../search/index.js';
import type { SearchIndexStats } from '../search/index.js';
import type { BuildLinksResult } from '../links/build.js';
import { CliError, errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { nowIso } from '../util/time.js';
import { planGithubRepository, syncGithubItem } from '../sources/github/sync.js';
import { planJiraProject, syncJiraWorkitem } from '../sources/jira/sync.js';
import { ProgressReporter } from './progress.js';
import { isSyncStopped, SyncStopped } from './stop.js';
import { SYNC_PHASES } from './types.js';
import type { SyncContext, TargetPlan, TargetSyncResult } from './types.js';

export type SyncSource = 'github' | 'jira';

export interface RunSyncOptions {
  config: ResolvedConfig;
  logger: Logger;
  /** Project keys from the configuration; empty means every project. */
  projects?: string[];
  sources?: SyncSource[];
  /** Repository full names or Jira project keys to restrict the run to. */
  targets?: string[];
  full: boolean;
  dryRun: boolean;
  progress: boolean;
  /** Skip the resources a failed or interrupted run already finished. */
  resume?: boolean;
  /** Stops the sync at the next request when it fires. */
  signal?: AbortSignal;
  /** Write the yaml / markdown / json outputs after syncing. */
  writeOutputs: boolean;
  /**
   * Sync these items first, before the regular sync. Each is either a GitHub
   * reference (`owner/repo#42`, or `42` when a single repository is configured)
   * or a Jira key (`PLAT-42`).
   */
  only?: string[];
  /** Skip the regular sync after the targeted one. */
  targetedOnly?: boolean;
}

export interface SyncSummary {
  results: TargetSyncResult[];
  /** True when the sync ended because it was asked to, not because it finished. */
  stopped?: boolean;
  apiCalls: number;
  items: number;
  durationMs: number;
  links?: BuildLinksResult;
  search?: SearchIndexStats;
  history?: StateHistoryStats;
  export?: ExportSummary;
}

export async function runSync(options: RunSyncOptions): Promise<SyncSummary> {
  const { config, logger } = options;
  const startedAt = Date.now();
  // Every row this run writes gets a `synced_at` at or after this, which is how
  // the search index knows what to reindex without rebuilding everything.
  const startedAtIso = new Date(startedAt).toISOString();

  const projects = selectProjects(config, options.projects);
  const sources = options.sources?.length ? options.sources : (['github', 'jira'] as SyncSource[]);

  const db = Database.openAndMigrate(config.databasePath);
  const journal = new SyncJournal(db);
  const interrupted = journal.markStaleRunsInterrupted();
  if (interrupted > 0) {
    logger.warn(
      `Marked ${interrupted} unfinished sync run(s) from an earlier process as interrupted.`,
    );
  }

  const progress = new ProgressReporter({ enabled: options.progress, logger });
  const results: TargetSyncResult[] = [];

  try {
    // --- targeted items first -------------------------------------------
    for (const reference of options.only ?? []) {
      results.push(...(await syncTargeted(reference, projects, db, journal, progress, options)));
    }

    if (options.targetedOnly === true) {
      progress.finish();
      const summary: SyncSummary = {
        results,
        apiCalls: progress.apiCallCount,
        items: progress.itemCount,
        durationMs: Date.now() - startedAt,
      };
      if (!options.dryRun) {
        summary.links = buildCrossLinks(db);
        summary.search = buildSearchIndex(db, { since: startedAtIso });
      }
      return summary;
    }

    // Mirrored once per run rather than per project: people and teams are
    // configured globally and belong to no single project.
    if (!options.dryRun) storeDirectory(db, config);

    const plans: Array<{ plan: TargetPlan; announce: string }> = [];

    for (const project of projects) {
      if (!options.dryRun) storeProject(db, project);

      /**
       * The context for one target.
       *
       * `alreadyDone` is looked up per target because resuming is per target:
       * one repository may have finished while the next never started.
       */
      const contextFor = (source: SyncSource, target: string): SyncContext => ({
        db,
        journal,
        progress,
        logger,
        config,
        full: options.full,
        dryRun: options.dryRun,
        projectKey: project.key,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.resume === true
          ? { alreadyDone: journal.resumableResources(source, target) }
          : {}),
      });

      if (sources.includes('github')) {
        for (const target of project.github) {
          if (!matchesTarget(options.targets, [target.fullName, target.repo])) continue;
          plans.push({
            plan: planGithubRepository(target, contextFor('github', target.fullName)),
            announce: `Syncing GitHub repository ${target.fullName} (project ${project.key}).`,
          });
        }
      }

      if (sources.includes('jira')) {
        for (const target of project.jira) {
          if (
            !matchesTarget(options.targets, [
              target.projectKey,
              `${target.site.name}/${target.projectKey}`,
            ])
          ) {
            continue;
          }
          const targetName = `${target.site.name}/${target.projectKey}`;
          plans.push({
            plan: planJiraProject(target, contextFor('jira', targetName)),
            announce: `Syncing Jira project ${target.projectKey} (project ${project.key}).`,
          });
        }
      }
    }

    /*
     * Size every target before syncing any of them.
     *
     * Each survey costs a handful of requests and buys an exact count of what
     * is there, so the expected total and the time remaining are meaningful
     * from the first percent. Without it the expectation climbed each time
     * another repository, or another resource within one, was reached, and an
     * estimate that keeps growing is worse than none.
     *
     * A survey that fails is not fatal: it only means that target's share of
     * the work gets discovered while it is done, exactly as it used to be.
     */
    if (plans.length > 0) {
      progress.setPhase('planning');
      for (const { plan } of plans) {
        try {
          await plan.survey();
        } catch (error) {
          logger.debug(`Could not size ${plan.label} up front: ${errorMessage(error)}`);
        }
      }
      logger.info(
        `Planned ${plans.length} target(s): about ${progress.expectedApiCallCount} API call(s).`,
      );
    }

    /*
     * Run the targets phase by phase rather than one target at a time.
     *
     * Everything is listed first, for every target, before anything a list only
     * named is fetched, and before anything hanging off an individual item is
     * fetched. That is the order the data becomes knowable in: after the lists
     * the counts are exact, so the two phases that dominate a large sync are
     * priced rather than guessed.
     *
     * A target that fails drops out and the rest carry on, which is the same
     * isolation running them one after another gave.
     */
    for (const { plan, announce } of plans) {
      logger.info(announce);
      plan.begin();
    }

    const failures = new Map<TargetPlan, unknown>();
    let stopped = false;

    for (const phase of SYNC_PHASES) {
      if (stopped) break;
      progress.setPhase(phase);
      for (const { plan } of plans) {
        if (failures.has(plan)) continue;
        try {
          await plan.runPhase(phase);
        } catch (error) {
          failures.set(plan, error);
          /*
           * A stop is not a failure. The first target to notice ends the whole
           * run rather than only itself, because the person asked for the sync
           * to end, not for this repository to be skipped.
           */
          if (isSyncStopped(error)) {
            stopped = true;
            break;
          }
          logger.debug(`${plan.label} failed during ${phase}: ${errorMessage(error)}`);
        }
      }
    }

    for (const { plan } of plans) {
      // Targets that never reached the failure are marked interrupted too:
      // their work is genuinely unfinished, and saying "completed" would let
      // the next --resume skip resources that never ran.
      const outcome = failures.get(plan) ?? (stopped ? new SyncStopped() : null);
      results.push(plan.finish(outcome));
    }

    if (stopped) {
      logger.warn('Stopped. Nothing was lost — run "devcontext sync --resume" to carry on.');
    }

    progress.finish();

    const summary: SyncSummary = {
      results,
      ...(stopped ? { stopped: true } : {}),
      apiCalls: progress.apiCallCount,
      items: progress.itemCount,
      durationMs: Date.now() - startedAt,
    };

    if (!options.dryRun) {
      // Cheap (one pass over text already in the database) and it has to happen
      // before the export so the documents carry the links.
      summary.links = buildCrossLinks(db);
      if (summary.links.links > 0) {
        logger.info(`Linked ${summary.links.links} GitHub and Jira reference(s).`);
      }

      // After the sync so "devcontext search" never answers from a stale index.
      // A full sync rewrote everything, so it rebuilds; an incremental one only
      // touches what it wrote, which keeps a three issue sync cheap on a large
      // repository. `devcontext search --rebuild` forces the full pass.
      summary.search = buildSearchIndex(db, options.full ? {} : { since: startedAtIso });
      if (summary.search.rows > 0) {
        logger.debug(`Indexed ${summary.search.rows} item(s) for search.`);
      }

      // Rebuilt rather than appended to: it is derived from the timelines and
      // changelogs, and a sync that filled in history the last one missed has
      // to change what the earlier days say.
      summary.history = buildStateHistory(db);
      if (summary.history.changes > 0) {
        logger.debug(
          `Tracked ${summary.history.changes} state change(s) across ${summary.history.items} item(s).`,
        );
      }
    }

    if (options.writeOutputs && !options.dryRun) {
      logger.info('Writing yaml / markdown / json outputs.');
      summary.export = await exportOutputs({ db, config, logger });
    }

    return summary;
  } finally {
    progress.finish();
    db.close();
  }
}

/**
 * Resolves a reference to the project and target it belongs to and syncs just
 * that item. Cursors are untouched, so the regular sync afterwards still covers
 * the whole window and nothing can be skipped.
 */
async function syncTargeted(
  reference: string,
  projects: ProjectConfig[],
  db: Database,
  journal: SyncJournal,
  progress: ProgressReporter,
  options: RunSyncOptions,
): Promise<TargetSyncResult[]> {
  const parsed = parseReference(reference, projects);

  const ctx: SyncContext = {
    db,
    journal,
    progress,
    logger: options.logger,
    config: options.config,
    full: options.full,
    dryRun: options.dryRun,
    projectKey: parsed.project.key,
  };

  if (parsed.kind === 'github') {
    options.logger.info(`Syncing ${parsed.target.fullName}#${parsed.number} directly.`);
    return [await syncGithubItem(parsed.target, ctx, parsed.number)];
  }

  options.logger.info(`Syncing ${parsed.key} directly.`);
  return [await syncJiraWorkitem(parsed.target, ctx, parsed.key)];
}

type ParsedReference =
  | { kind: 'github'; project: ProjectConfig; target: GithubRepoTarget; number: number }
  | { kind: 'jira'; project: ProjectConfig; target: JiraProjectTarget; key: string };

/** `owner/repo#42`, `42` (single repository) or `PLAT-42`. */
export function parseReference(reference: string, projects: ProjectConfig[]): ParsedReference {
  const trimmed = reference.trim();

  const jiraKey = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(trimmed);
  if (jiraKey) {
    const projectKey = (jiraKey[1] ?? '').toUpperCase();
    for (const project of projects) {
      const target = project.jira.find((entry) => entry.projectKey === projectKey);
      if (target) {
        return { kind: 'jira', project, target, key: `${projectKey}-${jiraKey[2]}` };
      }
    }
    throw new CliError(`No Jira project "${projectKey}" is configured.`, {
      hint: `Configured Jira projects: ${projects.flatMap((p) => p.jira.map((j) => j.projectKey)).join(', ') || '(none)'}`,
    });
  }

  const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(trimmed);
  if (qualified) {
    const fullName = qualified[1] ?? '';
    for (const project of projects) {
      const target = project.github.find((entry) => entry.fullName === fullName);
      if (target) {
        return { kind: 'github', project, target, number: Number(qualified[2]) };
      }
    }
    throw new CliError(`No GitHub repository "${fullName}" is configured.`, {
      hint: `Configured repositories: ${projects.flatMap((p) => p.github.map((g) => g.fullName)).join(', ') || '(none)'}`,
    });
  }

  const bare = /^#?(\d+)$/.exec(trimmed);
  if (bare) {
    const repositories = projects.flatMap((project) =>
      project.github.map((target) => ({ project, target })),
    );
    const [only, ...rest] = repositories;
    if (!only) throw new CliError('No GitHub repository is configured.');
    if (rest.length > 0) {
      throw new CliError(
        `"${trimmed}" is ambiguous: ${repositories.length} repositories are configured.`,
        { hint: 'Use owner/name#number.' },
      );
    }
    return { kind: 'github', project: only.project, target: only.target, number: Number(bare[1]) };
  }

  throw new CliError(`Cannot understand "${reference}".`, {
    hint: 'Expected owner/name#42, 42 (with a single repository) or PLAT-42.',
  });
}

export function selectProjects(config: ResolvedConfig, keys?: string[]): ProjectConfig[] {
  if (!keys || keys.length === 0) return config.projects;

  const selected: ProjectConfig[] = [];
  for (const key of keys) {
    const project = config.projects.find((candidate) => candidate.key === key);
    if (!project) {
      throw new CliError(`Unknown project "${key}".`, {
        hint: `Configured projects: ${config.projects.map((entry) => entry.key).join(', ')}`,
      });
    }
    selected.push(project);
  }
  return selected;
}

function matchesTarget(targets: string[] | undefined, candidates: string[]): boolean {
  if (!targets || targets.length === 0) return true;
  return targets.some((target) =>
    candidates.some((candidate) => candidate.toLowerCase() === target.toLowerCase()),
  );
}

/** Mirrors the configured project into the database so it is self describing. */
function storeProject(db: Database, project: ProjectConfig): void {
  const updatedAt = nowIso();
  db.upsert('projects', {
    key: project.key,
    name: project.name,
    description: project.description,
    updated_at: updatedAt,
  });

  for (const target of project.github) {
    db.upsert('project_sources', {
      project_key: project.key,
      source: 'github',
      identifier: `${target.host.name}/${target.fullName}`,
      config: JSON.stringify({
        repo: target.fullName,
        host: target.host.name,
        since: target.since,
        sync: target.sync,
      }),
      updated_at: updatedAt,
    });
  }

  for (const target of project.jira) {
    db.upsert('project_sources', {
      project_key: project.key,
      source: 'jira',
      identifier: `${target.site.name}/${target.projectKey}`,
      config: JSON.stringify({
        project: target.projectKey,
        site: target.site.name,
        filter: target.filter,
        since: target.since,
        fields: target.fields,
        sync: target.sync,
      }),
      updated_at: updatedAt,
    });
  }
}
