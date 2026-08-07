import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import type { OutputTargets, ResolvedConfig } from '../config/types.js';
import type { Database } from '../db/database.js';
import * as gh from '../db/queries/github.js';
import * as jira from '../db/queries/jira.js';
import {
  buildIssueDocument,
  buildPullRequestDocument,
  buildWorkflowRunDocument,
} from '../documents/github.js';
import { buildSprintDocument, buildWorkitemDocument } from '../documents/jira.js';
import { renderDocument } from '../output/document.js';
import type { Document } from '../output/document.js';
import { padNumber, slugify, writeTextFile } from '../util/fs.js';
import type { Logger } from '../util/logger.js';

export interface ExportOptions {
  db: Database;
  config: ResolvedConfig;
  logger: Logger;
  /** Restrict the export to these GitHub repositories (full names). */
  repos?: string[] | undefined;
  /** Restrict the export to these Jira project keys. */
  jiraProjects?: string[] | undefined;
  /** Skip writing workflow run documents (they are the bulkiest output). */
  includeWorkflowRuns?: boolean;
}

export interface ExportSummary {
  files: number;
  byTarget: Record<string, number>;
}

/**
 * Writes the yaml / markdown / json mirrors of the database.
 *
 * These files exist for grepping and for reading in an editor; the database
 * stays the primary target, and everything written here is derived from it,
 * so the export can be re-run at any time.
 */
export async function exportOutputs(options: ExportOptions): Promise<ExportSummary> {
  const { db, config, logger } = options;
  const enabled = enabledTargets(config.outputs);
  const summary: ExportSummary = { files: 0, byTarget: {} };

  if (enabled.length === 0) {
    logger.debug('All outputs are disabled; nothing to export.');
    return summary;
  }

  const writer = new DocumentWriter(config.outputs, summary);

  const repositories = gh
    .listRepositories(db)
    .filter((repo) => !options.repos || options.repos.includes(repo.full_name));

  for (const repository of repositories) {
    const base = join('github', slugify(repository.full_name));

    await writer.write(join(base, 'repository'), {
      title: repository.full_name,
      subtitle: repository.description ?? '',
      url: repository.html_url,
      meta: [
        ['Default branch', repository.default_branch],
        ['Stars', repository.stars],
        ['Open issues', repository.open_issues],
        ['Updated', repository.updated_at],
        ['Synced', repository.synced_at],
      ],
      sections: [],
      data: repository,
    });

    const issues = gh.listIssues(db, { repos: [repository.full_name] });
    for (const issue of issues) {
      await writer.write(
        join(base, 'issues', padNumber(issue.number)),
        buildIssueDocument(db, issue),
      );
    }

    const pullRequests = gh.listPullRequests(db, { repos: [repository.full_name] });
    for (const pullRequest of pullRequests) {
      await writer.write(
        join(base, 'pulls', padNumber(pullRequest.number)),
        buildPullRequestDocument(db, pullRequest),
      );
    }

    if (options.includeWorkflowRuns !== false) {
      const runs = gh.listWorkflowRuns(db, { repos: [repository.full_name] });
      for (const run of runs) {
        await writer.write(
          join(base, 'workflow-runs', String(run.id)),
          buildWorkflowRunDocument(db, run),
        );
      }
    }

    await writer.writeIndex(join(base, 'index'), `${repository.full_name}`, [
      {
        heading: `Issues (${issues.length})`,
        table: {
          columns: ['Number', 'State', 'Updated', 'Title'],
          rows: issues.map((issue) => [issue.number, issue.state, issue.updated_at, issue.title]),
        },
      },
      {
        heading: `Pull requests (${pullRequests.length})`,
        table: {
          columns: ['Number', 'State', 'Updated', 'Title'],
          rows: pullRequests.map((pullRequest) => [
            pullRequest.number,
            pullRequest.merged ? 'merged' : pullRequest.state,
            pullRequest.updated_at,
            pullRequest.title,
          ]),
        },
      },
    ]);
  }

  const projects = jira
    .listJiraProjects(db)
    .filter((project) => !options.jiraProjects || options.jiraProjects.includes(project.key));

  for (const project of projects) {
    const base = join('jira', slugify(project.site), project.key);
    const workitems = jira.listWorkitems(db, { projects: [project.key] });

    for (const workitem of workitems) {
      await writer.write(
        join(base, 'workitems', workitem.key),
        buildWorkitemDocument(db, workitem),
      );
    }

    const sprints = jira.listSprints(db, { sites: [project.site] });
    for (const sprint of sprints) {
      await writer.write(join(base, 'sprints', String(sprint.id)), buildSprintDocument(db, sprint));
    }

    await writer.writeIndex(join(base, 'index'), `${project.key} — ${project.name ?? ''}`, [
      {
        heading: `Work items (${workitems.length})`,
        table: {
          columns: ['Key', 'Type', 'Status', 'Assignee', 'Updated', 'Summary'],
          rows: workitems.map((workitem) => [
            workitem.key,
            workitem.type,
            workitem.status,
            workitem.assignee,
            workitem.updated_at,
            workitem.summary,
          ]),
        },
      },
      {
        heading: `Sprints (${sprints.length})`,
        table: {
          columns: ['Id', 'Name', 'State', 'Start', 'End', 'Items'],
          rows: sprints.map((sprint) => [
            sprint.id,
            sprint.name,
            sprint.state,
            sprint.start_date,
            sprint.end_date,
            sprint.workitem_count ?? 0,
          ]),
        },
      },
    ]);
  }

  logger.debug(`Exported ${summary.files} file(s) to ${enabled.join(', ')}.`);
  return summary;
}

class DocumentWriter {
  constructor(
    private readonly outputs: OutputTargets,
    private readonly summary: ExportSummary,
  ) {}

  async write(relativePath: string, document: Document): Promise<void> {
    if (this.outputs.yaml.enabled) {
      await this.emit('yaml', join(this.outputs.yaml.path, `${relativePath}.yaml`), () =>
        stringifyYaml(document.data, { lineWidth: 0 }),
      );
    }
    if (this.outputs.json.enabled) {
      await this.emit('json', join(this.outputs.json.path, `${relativePath}.json`), () =>
        JSON.stringify(document.data, null, 2),
      );
    }
    if (this.outputs.markdown.enabled) {
      await this.emit('markdown', join(this.outputs.markdown.path, `${relativePath}.md`), () =>
        renderDocument(document, 'markdown'),
      );
    }
  }

  /** Index files only make sense as markdown; yaml/json get the same data. */
  async writeIndex(
    relativePath: string,
    title: string,
    sections: Document['sections'],
  ): Promise<void> {
    if (!this.outputs.markdown.enabled) return;
    await this.emit('markdown', join(this.outputs.markdown.path, `${relativePath}.md`), () =>
      renderDocument({ title, meta: [], sections, data: {} }, 'markdown'),
    );
  }

  private async emit(target: string, path: string, render: () => string): Promise<void> {
    await writeTextFile(path, render());
    this.summary.files += 1;
    this.summary.byTarget[target] = (this.summary.byTarget[target] ?? 0) + 1;
  }
}

function enabledTargets(outputs: OutputTargets): string[] {
  return Object.entries(outputs)
    .filter(([, target]) => target.enabled)
    .map(([name]) => name);
}
