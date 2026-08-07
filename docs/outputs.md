# Outputs

Besides the database, devcontext writes yaml, markdown and (optionally) json
mirrors. They are **derived data**: written from the database after a sync,
never read back. Delete them at any time and run `devcontext export` to
recreate them.

They exist for three things: grepping without SQL, reading a ticket in an
editor, and handing a complete, offline copy of a discussion to a tool or an AI
assistant.

```yaml
outputs:
  yaml:
    enabled: true
    path: .devcontext/yaml
  markdown:
    enabled: true
    path: .devcontext/markdown
  json:
    enabled: false
    path: .devcontext/json
```

## Layout

The three targets share one layout; only the extension differs.

```
.devcontext/markdown/
├── github/
│   └── acme__platform/                 owner/repo, "/" replaced by "__"
│       ├── repository.md
│       ├── index.md                    issue and pull request tables
│       ├── issues/
│       │   ├── 000012.md               zero padded, so listings sort naturally
│       │   └── 000013.md
│       ├── pulls/
│       │   └── 000042.md
│       └── workflow-runs/
│           └── 1001.md
└── jira/
    └── acme/                           the site name
        └── PLAT/
            ├── index.md                work item and sprint tables
            ├── workitems/
            │   ├── PLAT-42.md
            │   └── PLAT-43.md
            └── sprints/
                └── 33.md
```

`index.md` files are written for the markdown target only — for yaml and json
the same information is a database query away.

## What one document contains

Each file is the _complete_ item, not a summary:

- **GitHub issue** — metadata, body, every comment with author and date, and the
  full timeline (labels, assignments, closes, reopens, renames).
- **GitHub pull request** — metadata, body, commits, changed files, every review
  with its inline comments, every conversation comment and the timeline.
- **Workflow run** — metadata plus one table per job with all of its steps.
- **Jira work item** — metadata including your mapped custom fields, the
  description as markdown, links, every comment and the complete field history.
- **Sprint** — metadata, story point sum, done count and the work item table.

## Formats

**Markdown** is written for reading: headings, a metadata list, the body and one
section per comment / review / history table.

```markdown
# PLAT-42 Improve the sync

_Story · In Progress_

- **Project**: PLAT
- **Assignee**: Alice
- **Story points**: 5
- **Sprint**: Sprint 7
- **teamName**: Platform

[https://acme.atlassian.net/browse/PLAT-42](https://acme.atlassian.net/browse/PLAT-42)

The sync should batch its API calls …

## Comments (1)

### Bob

_2026-02-01 00:00 (6mo ago)_

The rate limit is the problem.

## History (1)

…
```

**yaml** and **json** contain the same structured document that
`devcontext gh issues 12 -o json` prints, which makes them easy to feed into
other tools:

```yaml
kind: jira-workitem
key: PLAT-42
summary: Improve the sync
status: In Progress
storyPoints: 5
customFields:
  teamName: Platform
comments:
  - author: Bob
    createdAt: 2026-02-01T00:00:00.000Z
    body: The rate limit is the problem.
history:
  - author: Alice
    field: status
    from: To Do
    to: In Progress
```

## Regenerating

```bash
devcontext export                       # everything
devcontext export --repo acme/platform  # one repository
devcontext export --project PLAT        # one Jira project
devcontext export --no-workflow-runs    # skip the bulkiest documents
devcontext sync --no-outputs            # sync without touching the mirrors
```

## Grepping

```bash
grep -rl "rate limit" .devcontext/markdown/jira
grep -rn "force-pushed" .devcontext/markdown/github/*/pulls
rg --type yaml "storyPoints: 8" .devcontext/yaml
```

## Should they be committed?

`.devcontext/` is git ignored by default, and that is the recommended setup:
the mirrors can be large and change on every sync. If you do want them in a
repository, point the outputs somewhere outside `.devcontext/` and be aware that
they contain everything the tokens could read.
