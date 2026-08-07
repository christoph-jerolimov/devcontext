import { Command } from 'commander';

import * as jira from '../db/queries/jira.js';
import { buildSprintDocument, buildWorkitemDocument } from '../documents/jira.js';
import { renderDocument } from '../output/document.js';
import { printOutput, renderTable, truncate } from '../output/format.js';
import type { Column } from '../output/format.js';
import { CliError } from '../util/errors.js';
import { formatRelative } from '../util/time.js';
import {
  addListOptions,
  addTimeFilterOptions,
  collect,
  openReadContext,
  parseLimit,
  readOffset,
  readTimeFilters,
} from './shared.js';

export function createJiraCommand(): Command {
  const command = new Command('jira').description('read Jira data from the local database');

  command.addCommand(workitemsCommand('workitems', ['workitem', 'items', 'item'], undefined));
  command.addCommand(workitemsCommand('stories', ['story'], ['Story']));
  command.addCommand(workitemsCommand('epics', ['epic'], ['Epic']));
  command.addCommand(workitemsCommand('features', ['feature'], ['Feature']));
  command.addCommand(workitemsCommand('bugs', ['bug'], ['Bug', 'Defect']));
  command.addCommand(workitemsCommand('tasks', ['task'], ['Task', 'Sub-task', 'Subtask']));
  command.addCommand(searchCommand());
  command.addCommand(sprintsCommand());
  command.addCommand(projectsCommand());
  command.addCommand(fieldsCommand());

  return command;
}

const WORKITEM_COLUMNS: Column<jira.WorkitemRow>[] = [
  { header: 'KEY', value: (row) => row.key },
  { header: 'TYPE', value: (row) => row.type, optional: true },
  { header: 'STATUS', value: (row) => row.status },
  { header: 'SUMMARY', value: (row) => truncate(row.summary, 60) },
  { header: 'ASSIGNEE', value: (row) => truncate(row.assignee, 18), optional: true },
  { header: 'POINTS', value: (row) => row.story_points, align: 'right', optional: true },
  { header: 'SPRINT', value: (row) => truncate(row.sprint_name, 18), optional: true },
  { header: 'UPDATED', value: (row) => formatRelative(row.updated_at) },
];

/**
 * `workitems` plus the type specific aliases (`stories`, `epics`, ...), which
 * are the same command with a preset `--type` filter.
 */
function workitemsCommand(
  name: string,
  aliases: string[],
  presetTypes: string[] | undefined,
): Command {
  const command = new Command(name)
    .aliases(aliases)
    .description(
      presetTypes
        ? `list ${name} (work items of type ${presetTypes.join(' / ')})`
        : 'list work items, or show one with comments and full history',
    )
    .argument('[key]', 'work item key (e.g. PROJ-123) to show in detail')
    .option('-p, --project <key>', 'Jira project key, repeatable', collect, [])
    .option('--site <name>', 'Jira site name from the configuration', collect, [])
    .option('--status <status>', 'status name, repeatable', collect, [])
    .option('--category <category>', '"To Do", "In Progress" or "Done"', collect, [])
    .option('--assignee <name>', 'assignee display name (substring match)')
    .option('--reporter <name>', 'reporter display name (substring match)')
    .option('-l, --label <label>', 'label filter, repeatable', collect, [])
    .option('--component <name>', 'component filter, repeatable', collect, [])
    .option('--sprint <name>', 'sprint name (substring match)')
    .option('--epic <key>', 'items belonging to this epic')
    .option('--parent <key>', 'items with this parent')
    .option('--open', 'only unresolved work items')
    .option('--resolved', 'only resolved work items')
    .option('--sort <field>', 'updated, created, key or status', 'updated')
    .option('--order <direction>', 'asc or desc', 'desc');

  if (!presetTypes) {
    command.option('-t, --type <type>', 'work item type, repeatable', collect, []);
  }
  addTimeFilterOptions(command);

  return addListOptions(command).action(
    (key: string | undefined, options: Record<string, unknown>, self: Command) => {
      const ctx = openReadContext(self);
      try {
        if (key !== undefined) {
          const workitem = jira.getWorkitem(ctx.db, key);
          if (!workitem) throw new CliError(`No work item "${key.toUpperCase()}" in the database.`);
          printOutput(renderDocument(buildWorkitemDocument(ctx.db, workitem), ctx.format));
          return;
        }

        const rows = jira.listWorkitems(ctx.db, {
          ...readWorkitemFilter(options, presetTypes),
          limit: parseLimit(options['limit'] as string | undefined),
          offset: readOffset(options),
        });

        printOutput(
          renderTable(rows, WORKITEM_COLUMNS, {
            format: ctx.format,
            list: ctx.list,
            listValue: (row) => row.key,
            title: presetTypes ? presetTypes.join(' / ') : 'Work items',
            emptyMessage: 'No work items match these filters.',
          }),
        );
      } finally {
        ctx.close();
      }
    },
  );
}

function searchCommand(): Command {
  const command = new Command('search')
    .description('search work items by key, summary, description and comments')
    .argument('<query>', 'text to look for')
    .option('-p, --project <key>', 'Jira project key, repeatable', collect, [])
    .option('-t, --type <type>', 'work item type, repeatable', collect, [])
    .option('--status <status>', 'status name, repeatable', collect, [])
    .option('--assignee <name>', 'assignee display name (substring match)')
    .option('--open', 'only unresolved work items')
    .option('--resolved', 'only resolved work items');

  addTimeFilterOptions(command);

  return addListOptions(command).action(
    (query: string, options: Record<string, unknown>, self: Command) => {
      const ctx = openReadContext(self);
      try {
        const rows = jira.searchWorkitems(ctx.db, query, {
          ...readWorkitemFilter(options, undefined),
          limit: parseLimit(options['limit'] as string | undefined),
          offset: readOffset(options),
        });

        printOutput(
          renderTable(rows, WORKITEM_COLUMNS, {
            format: ctx.format,
            list: ctx.list,
            listValue: (row) => row.key,
            title: `Search results for "${query}"`,
            emptyMessage: `Nothing matches "${query}".`,
          }),
        );
      } finally {
        ctx.close();
      }
    },
  );
}

function sprintsCommand(): Command {
  const command = new Command('sprints')
    .alias('sprint')
    .description('list sprints, or show one sprint with its work items')
    .argument('[id]', 'sprint id to show in detail')
    .option('--site <name>', 'Jira site name, repeatable', collect, [])
    .option('--board <id>', 'board id, repeatable', collect, [])
    .option('--state <state>', 'future, active or closed, repeatable', collect, []);

  return addListOptions(command).action(
    (id: string | undefined, options: Record<string, unknown>, self: Command) => {
      const ctx = openReadContext(self);
      try {
        if (id !== undefined) {
          const sprint = ctx.db.get<jira.SprintRow>('SELECT * FROM jira_sprints WHERE id = ?', [
            Number(id),
          ]);
          if (!sprint) throw new CliError(`No sprint with id ${id} in the database.`);
          printOutput(renderDocument(buildSprintDocument(ctx.db, sprint), ctx.format));
          return;
        }

        const boards = (options['board'] as string[]).map(Number).filter(Number.isFinite);
        const rows = jira.listSprints(ctx.db, {
          sites:
            (options['site'] as string[]).length > 0 ? (options['site'] as string[]) : undefined,
          boardIds: boards.length > 0 ? boards : undefined,
          states:
            (options['state'] as string[]).length > 0 ? (options['state'] as string[]) : undefined,
          search: options['search'] as string | undefined,
          limit: parseLimit(options['limit'] as string | undefined),
          offset: readOffset(options),
        });

        const columns: Column<jira.SprintRow>[] = [
          { header: 'ID', value: (row) => row.id, align: 'right' },
          { header: 'NAME', value: (row) => truncate(row.name, 40) },
          { header: 'STATE', value: (row) => row.state },
          { header: 'START', value: (row) => (row.start_date ?? '').slice(0, 10) },
          { header: 'END', value: (row) => (row.end_date ?? '').slice(0, 10) },
          { header: 'ITEMS', value: (row) => row.workitem_count ?? 0, align: 'right' },
          { header: 'GOAL', value: (row) => truncate(row.goal, 40), optional: true },
        ];

        printOutput(
          renderTable(rows, columns, {
            format: ctx.format,
            list: ctx.list,
            listValue: (row) => row.id,
            title: 'Sprints',
            emptyMessage: 'No sprints synced yet.',
          }),
        );
      } finally {
        ctx.close();
      }
    },
  );
}

function projectsCommand(): Command {
  const command = new Command('projects')
    .alias('project')
    .description('list the Jira projects that have been synced');

  return addListOptions(command).action((_options: unknown, self: Command) => {
    const ctx = openReadContext(self);
    try {
      const rows = jira.listJiraProjects(ctx.db);
      const columns: Column<jira.JiraProjectRow>[] = [
        { header: 'KEY', value: (row) => row.key },
        { header: 'NAME', value: (row) => row.name },
        { header: 'SITE', value: (row) => row.site, optional: true },
        { header: 'TYPE', value: (row) => row.project_type, optional: true },
        { header: 'LEAD', value: (row) => row.lead, optional: true },
        { header: 'ITEMS', value: (row) => row.workitem_count ?? 0, align: 'right' },
      ];

      printOutput(
        renderTable(rows, columns, {
          format: ctx.format,
          list: ctx.list,
          listValue: (row) => row.key,
          title: 'Jira projects',
          emptyMessage: 'No Jira projects synced yet.',
        }),
      );
    } finally {
      ctx.close();
    }
  });
}

function fieldsCommand(): Command {
  const command = new Command('fields')
    .alias('field')
    .description('list Jira fields and the friendly names configured for them')
    .option('--mapped', 'only fields with a configured name');

  return addListOptions(command).action((options: Record<string, unknown>, self: Command) => {
    const ctx = openReadContext(self);
    try {
      const rows = jira.listJiraFields(ctx.db, {
        onlyMapped: Boolean(options['mapped']),
        search: options['search'] as string | undefined,
      });

      printOutput(
        renderTable(
          rows,
          [
            { header: 'ID', value: (row) => row.id },
            { header: 'NAME', value: (row) => row.name },
            { header: 'MAPPED NAME', value: (row) => row.mapped_name },
            { header: 'CUSTOM', value: (row) => (row.custom ? 'yes' : 'no'), optional: true },
            { header: 'TYPE', value: (row) => row.schema_type, optional: true },
          ],
          {
            format: ctx.format,
            list: ctx.list,
            listValue: (row) => row.id,
            title: 'Jira fields',
            emptyMessage: 'No Jira fields synced yet.',
          },
        ),
      );
    } finally {
      ctx.close();
    }
  });
}

/** Repeatable options collect into an array; an empty one means "no filter". */
function optional(values: unknown): string[] | undefined {
  const list = (values as string[] | undefined) ?? [];
  return list.length > 0 ? list : undefined;
}

function readWorkitemFilter(
  options: Record<string, unknown>,
  presetTypes: string[] | undefined,
): jira.WorkitemFilter {
  const resolved =
    options['resolved'] === true ? true : options['open'] === true ? false : undefined;

  return {
    projects: optional(options['project']),
    sites: optional(options['site']),
    types: presetTypes ?? optional(options['type']),
    statuses: optional(options['status']),
    statusCategories: optional(options['category']),
    labels: optional(options['label']),
    components: optional(options['component']),
    assignee: options['assignee'] as string | undefined,
    reporter: options['reporter'] as string | undefined,
    sprint: options['sprint'] as string | undefined,
    epic: options['epic'] as string | undefined,
    parent: options['parent'] as string | undefined,
    resolved,
    search: options['search'] as string | undefined,
    sort: options['sort'] as 'updated' | 'created' | 'key' | 'status' | undefined,
    order: options['order'] as 'asc' | 'desc' | undefined,
    ...readTimeFilters(options),
  };
}
