import type { BindValue } from '../../db/database.js';
import { arr, bool, isObject, num, str } from '../../util/json.js';
import type { JsonObject } from '../../util/json.js';
import { adfToMarkdown } from './adf.js';

export type Row = Record<string, BindValue>;

const json = (value: unknown): string => JSON.stringify(value ?? null);

/** Field ids devcontext understands without an explicit mapping. */
export const WELL_KNOWN_FIELD_ALIASES = ['storyPoints', 'epicLink', 'sprint'] as const;

/**
 * What Jira calls the fields devcontext understands, in preference order.
 *
 * Three of the columns devcontext fills — story points, the epic link and the
 * sprint — live in custom fields whose ids differ per site, so they can only be
 * reached through a mapping. Asking every user to write that mapping by hand is
 * a poor trade: the id is unguessable, but the *name* is not, and the field
 * catalogue devcontext already syncs carries it.
 *
 * Ordered rather than a set, because Jira Cloud commonly ships both
 * "Story Points" and "Story point estimate" on the same site — team-managed and
 * company-managed projects each get their own — and only one of them is
 * populated. First match wins, so the choice is deterministic and explainable
 * rather than whichever the API happened to list first.
 */
const ALIAS_NAMES: Record<(typeof WELL_KNOWN_FIELD_ALIASES)[number], string[]> = {
  storyPoints: ['Story Points', 'Story point estimate', 'Story Points estimate'],
  epicLink: ['Epic Link'],
  sprint: ['Sprint'],
};

/** The little of a Jira field that naming it requires. */
export interface FieldCandidate {
  id: string;
  name: string | null;
}

/**
 * The mappings the field catalogue implies, minus the ones already configured.
 *
 * Returns only additions, and never contradicts `configured`: an explicit
 * mapping is somebody who looked at their own site, which beats a name match
 * every time. Two ways it defers — an alias already claimed is left alone, and
 * a field id already mapped to something else is not stolen.
 */
export function detectFieldAliases(
  candidates: readonly FieldCandidate[],
  configured: Record<string, string>,
): Record<string, string> {
  const claimed = new Set(Object.values(configured));
  const found: Record<string, string> = {};

  for (const [alias, names] of Object.entries(ALIAS_NAMES)) {
    if (claimed.has(alias)) continue;

    for (const name of names) {
      const match = candidates.find(
        (candidate) => candidate.name?.trim().toLowerCase() === name.toLowerCase(),
      );
      if (match && !(match.id in configured) && !(match.id in found)) {
        found[match.id] = alias;
        break;
      }
    }
  }

  return found;
}

export interface JiraContext {
  site: string;
  projectKey: string;
  baseUrl: string;
  /** Custom field id (`customfield_10016`) -> friendly name (`storyPoints`). */
  fields: Record<string, string>;
}

export function mapProject(raw: JsonObject, site: string, syncedAt: string): Row {
  return {
    site,
    id: str(raw, 'id') ?? '',
    key: str(raw, 'key') ?? '',
    name: str(raw, 'name'),
    project_type: str(raw, 'projectTypeKey'),
    lead: str(raw, 'lead', 'displayName'),
    url: str(raw, 'self'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function mapField(
  raw: JsonObject,
  site: string,
  mapping: Record<string, string>,
  syncedAt: string,
): Row {
  const id = str(raw, 'id') ?? '';
  return {
    site,
    id,
    key: str(raw, 'key'),
    name: str(raw, 'name'),
    mapped_name: mapping[id] ?? null,
    custom: bool(raw, 'custom') ?? false,
    schema_type: str(raw, 'schema', 'type'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

/** Reduces a Jira field value to something readable and stable. */
export function simplifyFieldValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(simplifyFieldValue);
  if (isObject(value)) {
    const preferred =
      str(value, 'displayName') ??
      str(value, 'value') ??
      str(value, 'name') ??
      str(value, 'text') ??
      null;
    if (preferred !== null) return preferred;
    if (str(value, 'type') === 'doc') return adfToMarkdown(value);
    return value;
  }
  return value;
}

/** Sprint fields come back as objects or as the old "com.atlassian...[id=1,...]" strings. */
export function parseSprintValue(value: unknown): { id: number | null; name: string | null } {
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    return last === undefined ? { id: null, name: null } : parseSprintValue(last);
  }
  if (isObject(value)) {
    return { id: num(value, 'id'), name: str(value, 'name') };
  }
  if (typeof value === 'string') {
    const id = /id=(\d+)/.exec(value);
    const name = /name=([^,\]]+)/.exec(value);
    return {
      id: id ? Number(id[1]) : null,
      name: name ? (name[1] ?? null) : value,
    };
  }
  return { id: null, name: null };
}

export function mapWorkitem(raw: JsonObject, ctx: JiraContext, syncedAt: string): Row {
  const fields = (raw['fields'] ?? {}) as JsonObject;
  const key = str(raw, 'key') ?? '';

  const custom: Record<string, unknown> = {};
  for (const [fieldId, friendlyName] of Object.entries(ctx.fields)) {
    if (!(fieldId in fields)) continue;
    custom[friendlyName] = simplifyFieldValue(fields[fieldId]);
  }

  const storyPointsFieldId = findFieldId(ctx.fields, 'storyPoints');
  const epicFieldId = findFieldId(ctx.fields, 'epicLink');
  const sprintFieldId = findFieldId(ctx.fields, 'sprint');

  const sprint = sprintFieldId ? parseSprintValue(fields[sprintFieldId]) : { id: null, name: null };

  const labels = arr(fields, 'labels').filter(
    (label): label is string => typeof label === 'string',
  );
  const components = arr(fields, 'components')
    .map((component) => str(component, 'name'))
    .filter((name): name is string => name !== null);
  const fixVersions = arr(fields, 'fixVersions')
    .map((version) => str(version, 'name'))
    .filter((name): name is string => name !== null);

  return {
    site: ctx.site,
    id: str(raw, 'id') ?? '',
    key,
    project_key: str(fields, 'project', 'key') ?? ctx.projectKey,
    summary: str(fields, 'summary'),
    description: adfToMarkdown(fields['description']),
    type: str(fields, 'issuetype', 'name'),
    status: str(fields, 'status', 'name'),
    status_category: str(fields, 'status', 'statusCategory', 'name'),
    resolution: str(fields, 'resolution', 'name'),
    priority: str(fields, 'priority', 'name'),
    assignee: str(fields, 'assignee', 'displayName'),
    assignee_id: str(fields, 'assignee', 'accountId') ?? str(fields, 'assignee', 'name'),
    reporter: str(fields, 'reporter', 'displayName'),
    creator: str(fields, 'creator', 'displayName'),
    parent_key: str(fields, 'parent', 'key'),
    epic_key:
      str(fields, 'parent', 'fields', 'issuetype', 'name') === 'Epic'
        ? str(fields, 'parent', 'key')
        : epicFieldId
          ? (simplifyFieldValue(fields[epicFieldId]) as string | null)
          : null,
    story_points: storyPointsFieldId ? num(fields, storyPointsFieldId) : null,
    sprint_id: sprint.id,
    sprint_name: sprint.name,
    labels: json(labels),
    components: json(components),
    fix_versions: json(fixVersions),
    votes: num(fields, 'votes', 'votes'),
    watchers: num(fields, 'watches', 'watchCount'),
    created_at: str(fields, 'created'),
    updated_at: str(fields, 'updated'),
    resolved_at: str(fields, 'resolutiondate'),
    due_date: str(fields, 'duedate'),
    url: `${ctx.baseUrl}/browse/${key}`,
    custom_fields: json(custom),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function workitemLabelRows(raw: JsonObject, ctx: JiraContext): Row[] {
  const fields = (raw['fields'] ?? {}) as JsonObject;
  const workitemId = str(raw, 'id') ?? '';
  const workitemKey = str(raw, 'key') ?? '';
  return arr(fields, 'labels')
    .filter((label): label is string => typeof label === 'string')
    .map((label) => ({
      site: ctx.site,
      workitem_id: workitemId,
      workitem_key: workitemKey,
      label,
    }));
}

export function mapComment(
  raw: JsonObject,
  ctx: JiraContext,
  workitem: { id: string; key: string },
  syncedAt: string,
): Row {
  return {
    site: ctx.site,
    id: str(raw, 'id') ?? '',
    workitem_id: workitem.id,
    workitem_key: workitem.key,
    author: str(raw, 'author', 'displayName'),
    author_id: str(raw, 'author', 'accountId') ?? str(raw, 'author', 'name'),
    body: adfToMarkdown(raw['body']),
    visibility: str(raw, 'visibility', 'value'),
    created_at: str(raw, 'created'),
    updated_at: str(raw, 'updated'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

/**
 * Expands one changelog entry into one row per changed field, so queries like
 * "when did this move to In Progress" or "who removed the label" stay trivial.
 */
export function mapChangelogEntry(
  raw: JsonObject,
  ctx: JiraContext,
  workitem: { id: string; key: string },
  syncedAt: string,
): Row[] {
  const historyId = str(raw, 'id') ?? '';
  const author = str(raw, 'author', 'displayName');
  const authorId = str(raw, 'author', 'accountId') ?? str(raw, 'author', 'name');
  const createdAt = str(raw, 'created');

  return arr(raw, 'items').map((item, index) => ({
    site: ctx.site,
    uid: `${historyId}:${index}`,
    history_id: historyId,
    workitem_id: workitem.id,
    workitem_key: workitem.key,
    author,
    author_id: authorId,
    created_at: createdAt,
    field: str(item, 'field'),
    field_type: str(item, 'fieldtype'),
    field_id: str(item, 'fieldId'),
    from_value: str(item, 'from'),
    from_string: str(item, 'fromString'),
    to_value: str(item, 'to'),
    to_string: str(item, 'toString'),
    synced_at: syncedAt,
    raw: json(item),
  }));
}

export function mapLinks(
  raw: JsonObject,
  ctx: JiraContext,
  workitem: { id: string; key: string },
  syncedAt: string,
): Row[] {
  const fields = (raw['fields'] ?? {}) as JsonObject;
  const rows: Row[] = [];

  for (const link of arr(fields, 'issuelinks')) {
    const id = str(link, 'id') ?? '';
    const type = str(link, 'type', 'name');

    for (const direction of ['inward', 'outward'] as const) {
      const related = link && isObject(link) ? link[`${direction}Issue`] : undefined;
      if (!isObject(related)) continue;
      rows.push({
        site: ctx.site,
        id,
        workitem_id: workitem.id,
        workitem_key: workitem.key,
        type: str(link, 'type', direction) ?? type,
        direction,
        related_key: str(related, 'key'),
        related_summary: str(related, 'fields', 'summary'),
        related_status: str(related, 'fields', 'status', 'name'),
        synced_at: syncedAt,
        raw: json(link),
      });
    }
  }
  return rows;
}

export function mapAttachments(
  raw: JsonObject,
  ctx: JiraContext,
  workitem: { id: string; key: string },
  syncedAt: string,
): Row[] {
  const fields = (raw['fields'] ?? {}) as JsonObject;
  return arr(fields, 'attachment').map((attachment) => ({
    site: ctx.site,
    id: str(attachment, 'id') ?? '',
    workitem_id: workitem.id,
    workitem_key: workitem.key,
    filename: str(attachment, 'filename'),
    mime_type: str(attachment, 'mimeType'),
    size_bytes: num(attachment, 'size'),
    author: str(attachment, 'author', 'displayName'),
    created_at: str(attachment, 'created'),
    content_url: str(attachment, 'content'),
    synced_at: syncedAt,
    raw: json(attachment),
  }));
}

export function mapBoard(
  raw: JsonObject,
  site: string,
  projectKey: string | null,
  syncedAt: string,
): Row {
  return {
    site,
    id: num(raw, 'id') ?? 0,
    name: str(raw, 'name'),
    type: str(raw, 'type'),
    project_key: str(raw, 'location', 'projectKey') ?? projectKey,
    synced_at: syncedAt,
    raw: json(raw),
  };
}

export function mapSprint(raw: JsonObject, site: string, boardId: number, syncedAt: string): Row {
  return {
    site,
    id: num(raw, 'id') ?? 0,
    board_id: num(raw, 'originBoardId') ?? boardId,
    name: str(raw, 'name'),
    state: str(raw, 'state'),
    goal: str(raw, 'goal'),
    start_date: str(raw, 'startDate'),
    end_date: str(raw, 'endDate'),
    complete_date: str(raw, 'completeDate'),
    synced_at: syncedAt,
    raw: json(raw),
  };
}

/** Finds the field id that was mapped to `alias` (e.g. `storyPoints`). */
export function findFieldId(fields: Record<string, string>, alias: string): string | null {
  for (const [fieldId, name] of Object.entries(fields)) {
    if (name === alias) return fieldId;
  }
  return null;
}
