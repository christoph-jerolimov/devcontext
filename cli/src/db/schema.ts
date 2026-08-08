/**
 * The complete database schema.
 *
 * Conventions used throughout:
 *  - every table keeps a `raw` column with the untouched JSON payload of the API
 *    response, so nothing the platforms return is ever lost;
 *  - normalised columns exist for everything worth querying or indexing;
 *  - GitHub rows are keyed by (host, id), Jira rows by (site, id), so several
 *    GitHub Enterprise servers or Jira sites can live in the same database;
 *  - `synced_at` records when devcontext last wrote the row.
 */
export const SCHEMA_VERSION = 4;

export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Projects (mirrors the configuration file so the database is self describing)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_sources (
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  source      TEXT NOT NULL,            -- github | jira
  identifier  TEXT NOT NULL,            -- github.com/owner/repo | site/PROJECT
  config      TEXT,                     -- resolved target configuration as JSON
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (project_key, source, identifier)
);

-- ---------------------------------------------------------------------------
-- People, bots and teams (also a mirror of the configuration)
--
-- Every person column elsewhere in this database holds whatever string the API
-- returned — a GitHub login here, a Jira display name there — and nothing joins
-- them. These four tables are what does: one row per person, one row per name
-- they answer to, so a query can ask about the colleague rather than about one
-- of their spellings.
--
-- They are rewritten from devcontext.yaml on every sync and hold nothing that
-- was fetched, so dropping them loses no synced data.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS people (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,
  kind       TEXT NOT NULL,             -- person | bot
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person_identities (
  source    TEXT NOT NULL,              -- github | jira
  identity  TEXT NOT NULL,              -- lower cased, so a join needs no collation
  display   TEXT NOT NULL,              -- as written in the configuration
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (source, identity)
);

CREATE INDEX IF NOT EXISTS idx_person_identities_person
  ON person_identities (person_id, source);

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,           -- configuration order
  PRIMARY KEY (team_id, person_id)
);

-- ---------------------------------------------------------------------------
-- Sync bookkeeping
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sync_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key        TEXT,
  source             TEXT NOT NULL,     -- github | jira
  target             TEXT NOT NULL,     -- owner/repo | site/PROJECT
  mode               TEXT NOT NULL,     -- initial | incremental
  status             TEXT NOT NULL,     -- running | completed | failed | interrupted
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  duration_ms        INTEGER,
  api_calls          INTEGER NOT NULL DEFAULT 0,
  api_calls_expected INTEGER NOT NULL DEFAULT 0,
  items_synced       INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  details            TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_target ON sync_runs (source, target, started_at DESC);

CREATE TABLE IF NOT EXISTS sync_operations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  resource      TEXT NOT NULL,          -- issues | pull_requests | workflow_runs | workitems | ...
  scope         TEXT NOT NULL,          -- sync_state scope this operation advanced
  status        TEXT NOT NULL,          -- running | completed | failed | skipped
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  api_calls     INTEGER NOT NULL DEFAULT 0,
  items_synced  INTEGER NOT NULL DEFAULT 0,
  cursor_before TEXT,
  cursor_after  TEXT,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_operations_run ON sync_operations (run_id);

-- Where an incremental sync has to continue from.
CREATE TABLE IF NOT EXISTS sync_state (
  scope             TEXT PRIMARY KEY,   -- github:github.com/owner/repo:issues
  source            TEXT NOT NULL,
  target            TEXT NOT NULL,
  resource          TEXT NOT NULL,
  cursor            TEXT,               -- usually the newest "updated at" seen
  last_run_id       INTEGER,
  last_full_sync_at TEXT,
  updated_at        TEXT NOT NULL,
  details           TEXT
);

-- ---------------------------------------------------------------------------
-- GitHub
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gh_repositories (
  host           TEXT NOT NULL,
  id             INTEGER NOT NULL,
  node_id        TEXT,
  owner          TEXT NOT NULL,
  name           TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  private        INTEGER NOT NULL DEFAULT 0,
  fork           INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0,
  description    TEXT,
  homepage       TEXT,
  language       TEXT,
  default_branch TEXT,
  visibility     TEXT,
  stars          INTEGER,
  forks          INTEGER,
  open_issues    INTEGER,
  html_url       TEXT,
  created_at     TEXT,
  updated_at     TEXT,
  pushed_at      TEXT,
  synced_at      TEXT NOT NULL,
  raw            TEXT NOT NULL,
  PRIMARY KEY (host, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_repositories_full_name
  ON gh_repositories (host, full_name);

CREATE TABLE IF NOT EXISTS gh_users (
  host       TEXT NOT NULL,
  id         INTEGER NOT NULL,
  login      TEXT NOT NULL,
  name       TEXT,
  type       TEXT,
  site_admin INTEGER,
  avatar_url TEXT,
  html_url   TEXT,
  synced_at  TEXT NOT NULL,
  raw        TEXT NOT NULL,
  PRIMARY KEY (host, id)
);

CREATE INDEX IF NOT EXISTS idx_gh_users_login ON gh_users (host, login);

CREATE TABLE IF NOT EXISTS gh_labels (
  host        TEXT NOT NULL,
  id          INTEGER NOT NULL,
  repo_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  color       TEXT,
  description TEXT,
  is_default  INTEGER,
  synced_at   TEXT NOT NULL,
  raw         TEXT NOT NULL,
  PRIMARY KEY (host, id)
);

CREATE INDEX IF NOT EXISTS idx_gh_labels_repo ON gh_labels (host, repo_id, name);

CREATE TABLE IF NOT EXISTS gh_milestones (
  host         TEXT NOT NULL,
  id           INTEGER NOT NULL,
  repo_id      INTEGER NOT NULL,
  number       INTEGER,
  title        TEXT,
  description  TEXT,
  state        TEXT,
  open_issues  INTEGER,
  closed_issues INTEGER,
  created_at   TEXT,
  updated_at   TEXT,
  due_on       TEXT,
  closed_at    TEXT,
  synced_at    TEXT NOT NULL,
  raw          TEXT NOT NULL,
  PRIMARY KEY (host, id)
);

CREATE INDEX IF NOT EXISTS idx_gh_milestones_repo ON gh_milestones (host, repo_id);

CREATE TABLE IF NOT EXISTS gh_issues (
  host             TEXT NOT NULL,
  id               INTEGER NOT NULL,
  repo_id          INTEGER NOT NULL,
  repo_full_name   TEXT NOT NULL,
  number           INTEGER NOT NULL,
  node_id          TEXT,
  title            TEXT,
  body             TEXT,
  state            TEXT,                -- open | closed
  state_reason     TEXT,
  locked           INTEGER,
  author           TEXT,
  author_association TEXT,
  assignees        TEXT,                -- JSON array of logins
  labels           TEXT,                -- JSON array of names
  milestone        TEXT,
  comment_count    INTEGER,
  reactions        TEXT,                -- JSON
  is_pull_request  INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT,
  updated_at       TEXT,
  closed_at        TEXT,
  closed_by        TEXT,
  html_url         TEXT,
  -- Which per-item resources have been fetched for this row, and when.
  --
  -- What decides whether the next sync spends a request on it. Comparing the
  -- listed updated_at against the stored one says whether the item moved; this
  -- says whether a resource that was switched on since is still missing, which
  -- a timestamp cannot. See sources/github/refresh.ts.
  --
  -- Kept here for pull requests too: GitHub models them as issues and the sync
  -- walks the issue endpoint, so every pull request has a row in this table and
  -- one place to look beats two that can disagree.
  details_parts    TEXT,                -- JSON array: comments, timeline, ...
  details_synced_at TEXT,
  synced_at        TEXT NOT NULL,
  raw              TEXT NOT NULL,
  PRIMARY KEY (host, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_issues_number
  ON gh_issues (host, repo_id, number);
CREATE INDEX IF NOT EXISTS idx_gh_issues_state ON gh_issues (state, updated_at DESC);

-- GitHub's own issue type ("Bug", "Feature", ...), which only newer
-- repositories set. It has no column of its own because adding one would need
-- a migration and a resync to fill it, while the payload it comes from is
-- already stored on every row. An expression index makes reading it out of
-- that payload as cheap as a column would be, and CREATE INDEX IF NOT EXISTS
-- reaches databases synced before this existed, because the schema is applied
-- on every open.
CREATE INDEX IF NOT EXISTS idx_gh_issues_type
  ON gh_issues (json_extract(raw, '$.type.name'));
CREATE INDEX IF NOT EXISTS idx_gh_issues_repo_updated
  ON gh_issues (repo_full_name, updated_at DESC);

CREATE TABLE IF NOT EXISTS gh_issue_labels (
  host       TEXT NOT NULL,
  issue_id   INTEGER NOT NULL,
  label_name TEXT NOT NULL,
  PRIMARY KEY (host, issue_id, label_name)
);

CREATE TABLE IF NOT EXISTS gh_issue_assignees (
  host      TEXT NOT NULL,
  issue_id  INTEGER NOT NULL,
  login     TEXT NOT NULL,
  PRIMARY KEY (host, issue_id, login)
);

CREATE TABLE IF NOT EXISTS gh_comments (
  host           TEXT NOT NULL,
  id             INTEGER NOT NULL,
  repo_id        INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  issue_id       INTEGER,
  issue_number   INTEGER,
  author         TEXT,
  body           TEXT,
  reactions      TEXT,
  created_at     TEXT,
  updated_at     TEXT,
  html_url       TEXT,
  synced_at      TEXT NOT NULL,
  raw            TEXT NOT NULL,
  PRIMARY KEY (host, id)
);

CREATE INDEX IF NOT EXISTS idx_gh_comments_issue ON gh_comments (host, issue_id, created_at);

-- Every timeline event: label added/removed, assigned, closed, reopened,
-- renamed, referenced, review requested, ...
CREATE TABLE IF NOT EXISTS gh_events (
  host           TEXT NOT NULL,
  uid            TEXT NOT NULL,         -- stable id, falls back to a content hash
  id             INTEGER,
  node_id        TEXT,
  repo_id        INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  issue_id       INTEGER NOT NULL,
  issue_number   INTEGER,
  event          TEXT NOT NULL,
  actor          TEXT,
  created_at     TEXT,
  label          TEXT,
  assignee       TEXT,
  milestone      TEXT,
  from_value     TEXT,                  -- e.g. previous title on "renamed"
  to_value       TEXT,
  commit_sha     TEXT,
  synced_at      TEXT NOT NULL,
  raw            TEXT NOT NULL,
  PRIMARY KEY (host, uid)
);

CREATE INDEX IF NOT EXISTS idx_gh_events_issue ON gh_events (host, issue_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gh_events_type ON gh_events (event, created_at);

CREATE TABLE IF NOT EXISTS gh_pull_requests (
  host             TEXT NOT NULL,
  id               INTEGER NOT NULL,
  repo_id          INTEGER NOT NULL,
  repo_full_name   TEXT NOT NULL,
  number           INTEGER NOT NULL,
  node_id          TEXT,
  title            TEXT,
  body             TEXT,
  state            TEXT,                -- open | closed
  draft            INTEGER,
  merged           INTEGER,
  mergeable        TEXT,
  mergeable_state  TEXT,
  author           TEXT,
  assignees        TEXT,
  requested_reviewers TEXT,
  labels           TEXT,
  milestone        TEXT,
  head_ref         TEXT,
  head_sha         TEXT,
  head_repo        TEXT,
  base_ref         TEXT,
  base_sha         TEXT,
  merge_commit_sha TEXT,
  additions        INTEGER,
  deletions        INTEGER,
  changed_files    INTEGER,
  commit_count     INTEGER,
  comment_count    INTEGER,
  review_comment_count INTEGER,
  created_at       TEXT,
  updated_at       TEXT,
  closed_at        TEXT,
  merged_at        TEXT,
  merged_by        TEXT,
  html_url         TEXT,
  synced_at        TEXT NOT NULL,
  raw              TEXT NOT NULL,
  PRIMARY KEY (host, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_pull_requests_number
  ON gh_pull_requests (host, repo_id, number);
CREATE INDEX IF NOT EXISTS idx_gh_pull_requests_state
  ON gh_pull_requests (state, updated_at DESC);

CREATE TABLE IF NOT EXISTS gh_reviews (
  host           TEXT NOT NULL,
  id             INTEGER NOT NULL,
  repo_id        INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  pr_id          INTEGER NOT NULL,
  pr_number      INTEGER,
  author         TEXT,
  state          TEXT,                  -- APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED
  body           TEXT,
  commit_id      TEXT,
  submitted_at   TEXT,
  html_url       TEXT,
  synced_at      TEXT NOT NULL,
  raw            TEXT NOT NULL,
  PRIMARY KEY (host, id)
);

CREATE INDEX IF NOT EXISTS idx_gh_reviews_pr ON gh_reviews (host, pr_id, submitted_at);

CREATE TABLE IF NOT EXISTS gh_review_comments (
  host            TEXT NOT NULL,
  id              INTEGER NOT NULL,
  repo_id         INTEGER NOT NULL,
  repo_full_name  TEXT NOT NULL,
  pr_id           INTEGER NOT NULL,
  pr_number       INTEGER,
  review_id       INTEGER,
  in_reply_to_id  INTEGER,
  author          TEXT,
  body            TEXT,
  path            TEXT,
  diff_hunk       TEXT,
  line            INTEGER,
  original_line   INTEGER,
  start_line      INTEGER,
  side            TEXT,
  commit_id       TEXT,
  created_at      TEXT,
  updated_at      TEXT,
  html_url        TEXT,
  synced_at       TEXT NOT NULL,
  raw             TEXT NOT NULL,
  PRIMARY KEY (host, id)
);

CREATE INDEX IF NOT EXISTS idx_gh_review_comments_pr
  ON gh_review_comments (host, pr_id, created_at);

CREATE TABLE IF NOT EXISTS gh_commits (
  host           TEXT NOT NULL,
  repo_id        INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  sha            TEXT NOT NULL,
  pr_id          INTEGER,
  pr_number      INTEGER,
  message        TEXT,
  author_name    TEXT,
  author_email   TEXT,
  author_login   TEXT,
  authored_at    TEXT,
  committer_name TEXT,
  committed_at   TEXT,
  parents        TEXT,                  -- JSON array of sha
  html_url       TEXT,
  synced_at      TEXT NOT NULL,
  raw            TEXT NOT NULL,
  PRIMARY KEY (host, repo_id, sha, pr_id)
);

CREATE INDEX IF NOT EXISTS idx_gh_commits_pr ON gh_commits (host, pr_id, committed_at);

CREATE TABLE IF NOT EXISTS gh_pull_request_files (
  host           TEXT NOT NULL,
  repo_id        INTEGER NOT NULL,
  pr_id          INTEGER NOT NULL,
  filename       TEXT NOT NULL,
  status         TEXT,
  additions      INTEGER,
  deletions      INTEGER,
  changes        INTEGER,
  previous_filename TEXT,
  patch          TEXT,
  synced_at      TEXT NOT NULL,
  raw            TEXT NOT NULL,
  PRIMARY KEY (host, pr_id, filename)
);

CREATE TABLE IF NOT EXISTS gh_workflows (
  host           TEXT NOT NULL,
  id             INTEGER NOT NULL,
  repo_id        INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  name           TEXT,
  path           TEXT,
  state          TEXT,
  created_at     TEXT,
  updated_at     TEXT,
  html_url       TEXT,
  synced_at      TEXT NOT NULL,
  raw            TEXT NOT NULL,
  PRIMARY KEY (host, id)
);

CREATE INDEX IF NOT EXISTS idx_gh_workflows_repo ON gh_workflows (host, repo_id);

CREATE TABLE IF NOT EXISTS gh_workflow_runs (
  host           TEXT NOT NULL,
  id             INTEGER NOT NULL,
  repo_id        INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  workflow_id    INTEGER,
  workflow_name  TEXT,
  name           TEXT,
  run_number     INTEGER,
  run_attempt    INTEGER,
  event          TEXT,
  status         TEXT,
  conclusion     TEXT,
  head_branch    TEXT,
  head_sha       TEXT,
  actor          TEXT,
  triggering_actor TEXT,
  pr_numbers     TEXT,                  -- JSON array
  created_at     TEXT,
  updated_at     TEXT,
  run_started_at TEXT,
  html_url       TEXT,
  synced_at      TEXT NOT NULL,
  raw            TEXT NOT NULL,
  PRIMARY KEY (host, id)
);

CREATE INDEX IF NOT EXISTS idx_gh_workflow_runs_repo
  ON gh_workflow_runs (host, repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gh_workflow_runs_conclusion
  ON gh_workflow_runs (conclusion, created_at DESC);

CREATE TABLE IF NOT EXISTS gh_workflow_jobs (
  host           TEXT NOT NULL,
  id             INTEGER NOT NULL,
  repo_id        INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  run_id         INTEGER NOT NULL,
  run_attempt    INTEGER,
  name           TEXT,
  status         TEXT,
  conclusion     TEXT,
  started_at     TEXT,
  completed_at   TEXT,
  duration_ms    INTEGER,
  runner_name    TEXT,
  runner_group   TEXT,
  labels         TEXT,
  html_url       TEXT,
  synced_at      TEXT NOT NULL,
  raw            TEXT NOT NULL,
  PRIMARY KEY (host, id)
);

CREATE INDEX IF NOT EXISTS idx_gh_workflow_jobs_run ON gh_workflow_jobs (host, run_id);

CREATE TABLE IF NOT EXISTS gh_workflow_steps (
  host         TEXT NOT NULL,
  job_id       INTEGER NOT NULL,
  number       INTEGER NOT NULL,
  run_id       INTEGER,
  name         TEXT,
  status       TEXT,
  conclusion   TEXT,
  started_at   TEXT,
  completed_at TEXT,
  duration_ms  INTEGER,
  synced_at    TEXT NOT NULL,
  raw          TEXT NOT NULL,
  PRIMARY KEY (host, job_id, number)
);

CREATE TABLE IF NOT EXISTS gh_job_logs (
  host       TEXT NOT NULL,
  job_id     INTEGER NOT NULL,
  repo_id    INTEGER NOT NULL,
  run_id     INTEGER,
  size_bytes INTEGER,
  truncated  INTEGER NOT NULL DEFAULT 0,
  content    TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (host, job_id)
);

CREATE TABLE IF NOT EXISTS gh_releases (
  host           TEXT NOT NULL,
  id             INTEGER NOT NULL,
  repo_id        INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  tag_name       TEXT,
  name           TEXT,
  body           TEXT,
  draft          INTEGER,
  prerelease     INTEGER,
  author         TEXT,
  created_at     TEXT,
  published_at   TEXT,
  html_url       TEXT,
  synced_at      TEXT NOT NULL,
  raw            TEXT NOT NULL,
  PRIMARY KEY (host, id)
);

-- ---------------------------------------------------------------------------
-- Cross references between GitHub and Jira
-- ---------------------------------------------------------------------------

-- One row per detected reference, e.g. the pull request acme/platform#42
-- mentioning PLAT-7 in its branch name. Rebuilt from the synced text, so it can
-- always be recomputed and never needs to be migrated.
CREATE TABLE IF NOT EXISTS cross_links (
  uid         TEXT PRIMARY KEY,   -- from_ref|to_ref|via
  from_source TEXT NOT NULL,      -- github | jira
  from_kind   TEXT NOT NULL,      -- issue | pull_request | workitem
  from_ref    TEXT NOT NULL,      -- acme/platform#42 | PLAT-7
  to_source   TEXT NOT NULL,
  to_kind     TEXT NOT NULL,
  to_ref      TEXT NOT NULL,
  via         TEXT NOT NULL,      -- branch | title | body | commit | comment | jira-field
  detail      TEXT,               -- the text that produced the match
  confidence  TEXT NOT NULL,      -- high | medium
  synced_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cross_links_from ON cross_links (from_ref);
CREATE INDEX IF NOT EXISTS idx_cross_links_to ON cross_links (to_ref);
CREATE INDEX IF NOT EXISTS idx_cross_links_sources ON cross_links (from_source, to_source);

-- ---------------------------------------------------------------------------
-- State over time
-- ---------------------------------------------------------------------------

-- How many issues were open last Tuesday, how many were assigned to somebody
-- in a given sprint, how the backlog moved over a month — none of it can be
-- read off the current state of a row, because an item can be closed,
-- reopened, reassigned and moved between sprints any number of times and the
-- row only remembers where it ended up.
--
-- So each of those histories is stored as the changes that produced it: one
-- row per transition, +1 when the item enters a state and -1 when it leaves.
-- The count at any moment is then the sum of every delta up to that moment,
-- and two dimensions intersect by summing each and joining on the item.
--
-- Rebuilt from the timelines and changelogs already synced, so like the cross
-- references it is derived and never needs to be migrated.
CREATE TABLE IF NOT EXISTS state_changes (
  source     TEXT NOT NULL,       -- github | jira
  ref        TEXT NOT NULL,       -- acme/platform#42 | PLAT-7
  kind       TEXT NOT NULL,       -- issue | pull_request | workitem
  container  TEXT NOT NULL,       -- acme/platform | PLAT
  dimension  TEXT NOT NULL,       -- state | assignee | sprint | points
  value      TEXT NOT NULL,       -- open | alice | 33 | 5
  at         TEXT NOT NULL,       -- ISO 8601, when the transition happened
  delta      INTEGER NOT NULL,    -- +1 entering, -1 leaving
  -- Two transitions can share a timestamp; the order they were replayed in
  -- keeps them distinct and keeps the primary key honest.
  seq        INTEGER NOT NULL,
  PRIMARY KEY (source, ref, dimension, value, at, seq)
);

CREATE INDEX IF NOT EXISTS idx_state_changes_when ON state_changes (dimension, at);
CREATE INDEX IF NOT EXISTS idx_state_changes_item ON state_changes (source, ref);
CREATE INDEX IF NOT EXISTS idx_state_changes_container ON state_changes (container, dimension, at);

-- ---------------------------------------------------------------------------
-- Who worked on what
-- ---------------------------------------------------------------------------

-- Who touched an item, and in what capacity.
--
-- "Who worked on this" is a question the stored rows can nearly answer and
-- never quite do: the author is a column on the item, the reviewers are rows in
-- another table, the commenters in a third, and the people who actually wrote
-- the commits in a fourth. Answering it meant a join nobody wants to write
-- twice, so in practice it was answered with the author column alone — which
-- names the one person guaranteed not to have done the reviewing.
--
-- One row per (item, person, capacity). The capacity is the point: "involved"
-- flattens the person who wrote it, the person who reviewed it and the person
-- who left one drive-by comment into the same word, and they are not the same
-- contribution.
--
-- Derived from tables already synced, and rebuilt on every sync like the cross
-- references and the state history, so it never needs migrating and an existing
-- database gets it without fetching anything.
CREATE TABLE IF NOT EXISTS contributors (
  source    TEXT NOT NULL,        -- github | jira
  ref       TEXT NOT NULL,        -- acme/platform#42 | PLAT-7
  kind      TEXT NOT NULL,        -- issue | pull_request | workitem
  container TEXT NOT NULL,        -- acme/platform | PLAT
  identity  TEXT NOT NULL,        -- the login or display name as stored
  -- author | reporter | assignee | committer | reviewer | review_requested |
  -- commenter | merged_by | worked
  role      TEXT NOT NULL,
  -- How many times: 1 for an author, 9 for somebody who commented nine times.
  -- The difference between having been present and having carried it.
  events    INTEGER NOT NULL,
  first_at  TEXT,
  last_at   TEXT,
  PRIMARY KEY (source, ref, identity, role)
);

CREATE INDEX IF NOT EXISTS idx_contributors_item ON contributors (source, ref);
CREATE INDEX IF NOT EXISTS idx_contributors_identity ON contributors (source, identity, role);
CREATE INDEX IF NOT EXISTS idx_contributors_container ON contributors (container, role);

-- ---------------------------------------------------------------------------
-- Jira
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jira_projects (
  site         TEXT NOT NULL,
  id           TEXT NOT NULL,
  key          TEXT NOT NULL,
  name         TEXT,
  project_type TEXT,
  lead         TEXT,
  url          TEXT,
  synced_at    TEXT NOT NULL,
  raw          TEXT NOT NULL,
  PRIMARY KEY (site, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jira_projects_key ON jira_projects (site, key);

-- Field catalogue including the friendly names configured by the user.
CREATE TABLE IF NOT EXISTS jira_fields (
  site        TEXT NOT NULL,
  id          TEXT NOT NULL,            -- customfield_10016
  key         TEXT,
  name        TEXT,                     -- name as reported by Jira
  mapped_name TEXT,                     -- name configured in devcontext.yaml
  custom      INTEGER NOT NULL DEFAULT 0,
  schema_type TEXT,
  synced_at   TEXT NOT NULL,
  raw         TEXT NOT NULL,
  PRIMARY KEY (site, id)
);

CREATE TABLE IF NOT EXISTS jira_workitems (
  site            TEXT NOT NULL,
  id              TEXT NOT NULL,
  key             TEXT NOT NULL,
  project_key     TEXT NOT NULL,
  summary         TEXT,
  description     TEXT,                 -- rendered to markdown
  type            TEXT,                 -- Story | Bug | Epic | Feature | Task | ...
  status          TEXT,
  status_category TEXT,                 -- To Do | In Progress | Done
  resolution      TEXT,
  priority        TEXT,
  assignee        TEXT,
  assignee_id     TEXT,
  reporter        TEXT,
  creator         TEXT,
  parent_key      TEXT,
  epic_key        TEXT,
  story_points    REAL,
  sprint_id       INTEGER,
  sprint_name     TEXT,
  labels          TEXT,                 -- JSON array
  components      TEXT,                 -- JSON array
  fix_versions    TEXT,                 -- JSON array
  votes           INTEGER,
  watchers        INTEGER,
  created_at      TEXT,
  updated_at      TEXT,
  resolved_at     TEXT,
  due_date        TEXT,
  url             TEXT,
  custom_fields   TEXT,                 -- JSON object keyed by mapped field name
  synced_at       TEXT NOT NULL,
  raw             TEXT NOT NULL,
  PRIMARY KEY (site, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jira_workitems_key ON jira_workitems (site, key);
CREATE INDEX IF NOT EXISTS idx_jira_workitems_project
  ON jira_workitems (project_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jira_workitems_type ON jira_workitems (type, status);

CREATE TABLE IF NOT EXISTS jira_workitem_labels (
  site        TEXT NOT NULL,
  workitem_id TEXT NOT NULL,
  workitem_key TEXT NOT NULL,
  label       TEXT NOT NULL,
  PRIMARY KEY (site, workitem_id, label)
);

CREATE TABLE IF NOT EXISTS jira_comments (
  site         TEXT NOT NULL,
  id           TEXT NOT NULL,
  workitem_id  TEXT NOT NULL,
  workitem_key TEXT NOT NULL,
  author       TEXT,
  author_id    TEXT,
  body         TEXT,
  visibility   TEXT,
  created_at   TEXT,
  updated_at   TEXT,
  synced_at    TEXT NOT NULL,
  raw          TEXT NOT NULL,
  PRIMARY KEY (site, id)
);

CREATE INDEX IF NOT EXISTS idx_jira_comments_workitem
  ON jira_comments (site, workitem_id, created_at);

-- One row per changed field per history entry: status changes, label changes,
-- sprint moves, assignee changes, ... over the full life of the work item.
CREATE TABLE IF NOT EXISTS jira_changelog (
  site         TEXT NOT NULL,
  uid          TEXT NOT NULL,           -- historyId:itemIndex
  history_id   TEXT NOT NULL,
  workitem_id  TEXT NOT NULL,
  workitem_key TEXT NOT NULL,
  author       TEXT,
  author_id    TEXT,
  created_at   TEXT,
  field        TEXT,
  field_type   TEXT,
  field_id     TEXT,
  from_value   TEXT,
  from_string  TEXT,
  to_value     TEXT,
  to_string    TEXT,
  synced_at    TEXT NOT NULL,
  raw          TEXT NOT NULL,
  PRIMARY KEY (site, uid)
);

CREATE INDEX IF NOT EXISTS idx_jira_changelog_workitem
  ON jira_changelog (site, workitem_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jira_changelog_field ON jira_changelog (field, created_at);

CREATE TABLE IF NOT EXISTS jira_worklogs (
  site         TEXT NOT NULL,
  id           TEXT NOT NULL,
  workitem_id  TEXT NOT NULL,
  workitem_key TEXT NOT NULL,
  author       TEXT,
  comment      TEXT,
  started_at   TEXT,
  time_spent_seconds INTEGER,
  created_at   TEXT,
  updated_at   TEXT,
  synced_at    TEXT NOT NULL,
  raw          TEXT NOT NULL,
  PRIMARY KEY (site, id)
);

CREATE TABLE IF NOT EXISTS jira_links (
  site           TEXT NOT NULL,
  id             TEXT NOT NULL,
  workitem_id    TEXT NOT NULL,
  workitem_key   TEXT NOT NULL,
  type           TEXT,
  direction      TEXT,                  -- inward | outward
  related_key    TEXT,
  related_summary TEXT,
  related_status TEXT,
  synced_at      TEXT NOT NULL,
  raw            TEXT NOT NULL,
  PRIMARY KEY (site, id, direction)
);

CREATE TABLE IF NOT EXISTS jira_attachments (
  site         TEXT NOT NULL,
  id           TEXT NOT NULL,
  workitem_id  TEXT NOT NULL,
  workitem_key TEXT NOT NULL,
  filename     TEXT,
  mime_type    TEXT,
  size_bytes   INTEGER,
  author       TEXT,
  created_at   TEXT,
  content_url  TEXT,
  synced_at    TEXT NOT NULL,
  raw          TEXT NOT NULL,
  PRIMARY KEY (site, id)
);

CREATE TABLE IF NOT EXISTS jira_boards (
  site        TEXT NOT NULL,
  id          INTEGER NOT NULL,
  name        TEXT,
  type        TEXT,
  project_key TEXT,
  synced_at   TEXT NOT NULL,
  raw         TEXT NOT NULL,
  PRIMARY KEY (site, id)
);

CREATE TABLE IF NOT EXISTS jira_sprints (
  site         TEXT NOT NULL,
  id           INTEGER NOT NULL,
  board_id     INTEGER,
  name         TEXT,
  state        TEXT,                    -- future | active | closed
  goal         TEXT,
  start_date   TEXT,
  end_date     TEXT,
  complete_date TEXT,
  synced_at    TEXT NOT NULL,
  raw          TEXT NOT NULL,
  PRIMARY KEY (site, id)
);

CREATE INDEX IF NOT EXISTS idx_jira_sprints_board ON jira_sprints (site, board_id, state);

CREATE TABLE IF NOT EXISTS jira_sprint_workitems (
  site         TEXT NOT NULL,
  sprint_id    INTEGER NOT NULL,
  workitem_id  TEXT NOT NULL,
  workitem_key TEXT NOT NULL,
  PRIMARY KEY (site, sprint_id, workitem_id)
);

-- "What did the last sync write?" is asked after every run to reindex only
-- that; without these it is a full scan of the largest tables.
CREATE INDEX IF NOT EXISTS idx_gh_issues_synced ON gh_issues (synced_at);
CREATE INDEX IF NOT EXISTS idx_gh_comments_synced ON gh_comments (synced_at);
CREATE INDEX IF NOT EXISTS idx_gh_pull_requests_synced ON gh_pull_requests (synced_at);
CREATE INDEX IF NOT EXISTS idx_gh_reviews_synced ON gh_reviews (synced_at);
CREATE INDEX IF NOT EXISTS idx_jira_workitems_synced ON jira_workitems (synced_at);
CREATE INDEX IF NOT EXISTS idx_jira_comments_synced ON jira_comments (synced_at);

-- The activity feed unions eight tables and orders the result by time, so each
-- of them is asked for its newest rows. gh_events and jira_changelog already
-- have an index leading with the column they are filtered on.
CREATE INDEX IF NOT EXISTS idx_gh_issues_created ON gh_issues (created_at);
CREATE INDEX IF NOT EXISTS idx_gh_comments_created ON gh_comments (created_at);
CREATE INDEX IF NOT EXISTS idx_gh_review_comments_created ON gh_review_comments (created_at);
CREATE INDEX IF NOT EXISTS idx_gh_reviews_submitted ON gh_reviews (submitted_at);
CREATE INDEX IF NOT EXISTS idx_jira_workitems_created ON jira_workitems (created_at);
CREATE INDEX IF NOT EXISTS idx_jira_comments_created ON jira_comments (created_at);
`;

/**
 * The full text index, one row per issue, pull request or work item, with its
 * comments folded in — a result is an *item*, not a fragment.
 *
 * Kept out of `SCHEMA_SQL` and applied separately because FTS5 is a compile
 * time option: a SQLite build without it must degrade to scanning, not fail to
 * open the database. `searchIndexAvailable` is how the rest of the code asks.
 */
export const SEARCH_SCHEMA_SQL = /* sql */ `
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  -- Indexed columns come first because bm25() assigns its weights by column
  -- position; putting them last would weight the UNINDEXED ones instead.
  ref,                     -- PLAT-42 or acme/platform#42; people search for these
  title,
  body,
  comments,
  people,
  labels,
  kind UNINDEXED,          -- issue | pull-request | workitem
  source UNINDEXED,        -- github | jira
  container UNINDEXED,     -- repository full name or Jira project key
  state UNINDEXED,
  updated_at UNINDEXED,
  url UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2"
);
`;
