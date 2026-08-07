import type { ProjectConfig, ResolvedConfig } from '../config/types.js';
import { Database } from '../db/database.js';
import { SyncJournal } from '../db/journal.js';
import { exportOutputs } from '../exporters/index.js';
import type { ExportSummary } from '../exporters/index.js';
import { buildCrossLinks } from '../links/build.js';
import type { BuildLinksResult } from '../links/build.js';
import { CliError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { nowIso } from '../util/time.js';
import { syncGithubRepository } from '../sources/github/sync.js';
import { syncJiraProject } from '../sources/jira/sync.js';
import { ProgressReporter } from './progress.js';
import type { SyncContext, TargetSyncResult } from './types.js';

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
  /** Write the yaml / markdown / json outputs after syncing. */
  writeOutputs: boolean;
}

export interface SyncSummary {
  results: TargetSyncResult[];
  apiCalls: number;
  items: number;
  durationMs: number;
  links?: BuildLinksResult;
  export?: ExportSummary;
}

export async function runSync(options: RunSyncOptions): Promise<SyncSummary> {
  const { config, logger } = options;
  const startedAt = Date.now();

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
    for (const project of projects) {
      if (!options.dryRun) storeProject(db, project);

      const ctx: SyncContext = {
        db,
        journal,
        progress,
        logger,
        config,
        full: options.full,
        dryRun: options.dryRun,
        projectKey: project.key,
      };

      if (sources.includes('github')) {
        for (const target of project.github) {
          if (!matchesTarget(options.targets, [target.fullName, target.repo])) continue;
          logger.info(`Syncing GitHub repository ${target.fullName} (project ${project.key}).`);
          results.push(await syncGithubRepository(target, ctx));
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
          logger.info(`Syncing Jira project ${target.projectKey} (project ${project.key}).`);
          results.push(await syncJiraProject(target, ctx));
        }
      }
    }

    progress.finish();

    const summary: SyncSummary = {
      results,
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
