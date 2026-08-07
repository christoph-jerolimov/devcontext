import type { Database } from '../db/database.js';
import { parseJsonColumn } from '../db/database.js';
import * as jira from '../db/queries/jira.js';
import type { Document } from '../output/document.js';
import { formatTimestamp } from './github.js';

const list = (value: string | null): string[] => parseJsonColumn<string[]>(value, []);

/** Everything devcontext knows about one Jira work item. */
export function buildWorkitemDocument(db: Database, workitem: jira.WorkitemRow): Document {
  const comments = jira.listJiraComments(db, workitem.key);
  const changelog = jira.listChangelog(db, workitem.key);
  const links = jira.listLinks(db, workitem.key);
  const customFields = parseJsonColumn<Record<string, unknown>>(workitem.custom_fields, {});

  const data = {
    kind: 'jira-workitem',
    site: workitem.site,
    key: workitem.key,
    project: workitem.project_key,
    summary: workitem.summary,
    type: workitem.type,
    status: workitem.status,
    statusCategory: workitem.status_category,
    resolution: workitem.resolution,
    priority: workitem.priority,
    assignee: workitem.assignee,
    reporter: workitem.reporter,
    parent: workitem.parent_key,
    epic: workitem.epic_key,
    storyPoints: workitem.story_points,
    sprint: workitem.sprint_name,
    labels: list(workitem.labels),
    components: list(workitem.components),
    fixVersions: list(workitem.fix_versions),
    createdAt: workitem.created_at,
    updatedAt: workitem.updated_at,
    resolvedAt: workitem.resolved_at,
    dueDate: workitem.due_date,
    url: workitem.url,
    customFields,
    description: workitem.description,
    links,
    comments: comments.map((comment) => ({
      id: comment.id,
      author: comment.author,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      body: comment.body,
    })),
    history: changelog.map((entry) => ({
      author: entry.author,
      createdAt: entry.created_at,
      field: entry.field,
      from: entry.from_string,
      to: entry.to_string,
    })),
  };

  return {
    title: `${workitem.key} ${workitem.summary ?? ''}`.trim(),
    subtitle: [workitem.type, workitem.status, workitem.resolution].filter(Boolean).join(' · '),
    url: workitem.url,
    meta: [
      ['Project', workitem.project_key],
      ['Type', workitem.type],
      ['Status', workitem.status],
      ['Category', workitem.status_category],
      ['Priority', workitem.priority],
      ['Assignee', workitem.assignee],
      ['Reporter', workitem.reporter],
      ['Parent', workitem.parent_key],
      ['Epic', workitem.epic_key],
      ['Story points', workitem.story_points],
      ['Sprint', workitem.sprint_name],
      ['Labels', list(workitem.labels).join(', ')],
      ['Components', list(workitem.components).join(', ')],
      ['Fix versions', list(workitem.fix_versions).join(', ')],
      ['Created', formatTimestamp(workitem.created_at)],
      ['Updated', formatTimestamp(workitem.updated_at)],
      ['Resolved', formatTimestamp(workitem.resolved_at)],
      ['Due', workitem.due_date],
      ...Object.entries(customFields).map(
        ([name, value]) => [name, formatCustomValue(value)] as [string, string],
      ),
    ],
    body: workitem.description,
    sections: [
      {
        heading: `Links (${links.length})`,
        table: {
          columns: ['Type', 'Direction', 'Key', 'Summary'],
          rows: links.map((link) => [
            link.type,
            link.direction,
            link.related_key,
            link.related_summary,
          ]),
        },
      },
      {
        heading: `Comments (${comments.length})`,
        entries: comments.map((comment) => ({
          title: comment.author ?? 'unknown',
          meta: formatTimestamp(comment.created_at),
          body: comment.body,
        })),
      },
      {
        heading: `History (${changelog.length})`,
        table: {
          columns: ['When', 'Author', 'Field', 'From', 'To'],
          rows: changelog.map((entry) => [
            formatTimestamp(entry.created_at),
            entry.author,
            entry.field,
            entry.from_string,
            entry.to_string,
          ]),
        },
      },
    ],
    data,
  };
}

/** One sprint with the work items it contains. */
export function buildSprintDocument(db: Database, sprint: jira.SprintRow): Document {
  const workitems = jira.listSprintWorkitems(db, sprint.id);
  const points = workitems.reduce((sum, item) => sum + (item.story_points ?? 0), 0);
  const done = workitems.filter((item) => item.status_category === 'Done');

  return {
    title: `Sprint ${sprint.name ?? sprint.id}`,
    subtitle: sprint.state ?? '',
    meta: [
      ['Board', sprint.board_id],
      ['State', sprint.state],
      ['Goal', sprint.goal],
      ['Start', sprint.start_date],
      ['End', sprint.end_date],
      ['Completed', sprint.complete_date],
      ['Work items', workitems.length],
      ['Done', `${done.length}/${workitems.length}`],
      ['Story points', points || null],
    ],
    sections: [
      {
        heading: `Work items (${workitems.length})`,
        table: {
          columns: ['Key', 'Type', 'Status', 'Assignee', 'Points', 'Summary'],
          rows: workitems.map((item) => [
            item.key,
            item.type,
            item.status,
            item.assignee,
            item.story_points,
            item.summary,
          ]),
        },
      },
    ],
    data: {
      kind: 'jira-sprint',
      site: sprint.site,
      id: sprint.id,
      boardId: sprint.board_id,
      name: sprint.name,
      state: sprint.state,
      goal: sprint.goal,
      startDate: sprint.start_date,
      endDate: sprint.end_date,
      completeDate: sprint.complete_date,
      storyPoints: points,
      workitems: workitems.map((item) => ({
        key: item.key,
        type: item.type,
        status: item.status,
        statusCategory: item.status_category,
        assignee: item.assignee,
        storyPoints: item.story_points,
        summary: item.summary,
      })),
    },
  };
}

function formatCustomValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((item) => formatCustomValue(item)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
