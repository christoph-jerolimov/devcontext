# Troubleshooting

## "No devcontext configuration file found."

devcontext looks for `devcontext.yaml` in the current directory and every parent
directory. Run `devcontext init`, or pass `--config <path>` / set
`$DEVCONTEXT_CONFIG`.

## "No devcontext database at …"

The read commands never create a database. Run `devcontext sync` first, or point
`--db` at an existing file.

## "Invalid configuration in …"

The error names the exact path, e.g.

```
Invalid configuration in /work/devcontext.yaml:
  - projects.0.github.0.syncs: Unrecognized key(s) in object: "syncs"
```

Unknown keys are rejected on purpose so a typo cannot silently disable a sync.

## GitHub: 401 or empty results for private repositories

The token in `$GITHUB_TOKEN` (or your `tokenEnv`) is missing, expired or lacks
scope. A classic token needs `repo` (or `public_repo`), plus `workflow` for
Actions data. A fine grained token needs _Contents: read_, _Issues: read_,
_Pull requests: read_ and _Actions: read_ for the organisation that owns the
repository — and it must be approved by that organisation.

Without a token devcontext keeps going unauthenticated and warns; you then get
public data only and 60 requests per hour.

## GitHub: "rate limit" warnings, sync slows down

Expected on a first sync of a large repository. devcontext reads the rate limit
headers and waits for the window to reset instead of failing. It also honours
secondary rate limits (GitHub's abuse detection) with a one minute backoff.

To be gentler from the start:

```bash
devcontext sync --delay 1000     # one API call per second
```

or set `sync.minDelayMs` in the configuration. Reduce the amount of work with
`since`, `maxWorkflowRuns` and by turning off `workflowLogs`.

## GitHub: older workflow runs are missing

`/actions/runs` stops paginating after 400 pages — 40,000 runs. A repository
with more than that cannot be synced completely in one pass, whatever
`maxWorkflowRuns` says, and the sync warns when it reaches the ceiling.

Use `since` to sync a specific earlier window rather than raising the cap: a
number above 40,000 is refused when the configuration loads, because it cannot
be honoured. See
[maxWorkflowRuns](configuration.md#the-ceiling-github-imposes).

## GitHub: workflow logs are missing

`workflowLogs` is `false` by default. Enable it per repository:

```yaml
github:
  - repo: acme/platform
    sync:
      workflowLogs: true
```

GitHub also expires logs (90 days by default). Expired logs answer with 410 and
are skipped silently. Logs larger than `maxLogBytes` are truncated, which is
recorded in `gh_job_logs.truncated`.

## Jira: "No API token for the Jira site …"

Export the token named by `tokenEnv` (default `JIRA_API_TOKEN`). Jira Cloud
tokens are created at
<https://id.atlassian.com/manage-profile/security/api-tokens> and used together
with your account e-mail (`auth: basic`). Jira Data Center uses a personal
access token with `auth: bearer` and usually `apiVersion: '2'`.

## Jira: 400 on the search

Almost always the `filter`. Run with `--verbose`; the exact JQL is logged:

```
info:  JQL: project = "PLAT" AND (labels != security) AND updated >= "2026-08-01 10:15" ORDER BY updated ASC
```

Paste it into the Jira issue navigator to see the real error. Field names with
spaces need quotes (`"Story Points" > 3`), and `!=` excludes issues where the
field is empty — `(labels != security OR labels IS EMPTY)` is often what you
actually want.

## Jira: story points, epic or sprint are empty

Those live in custom fields whose ids differ per site. Run

```bash
devcontext jira fields --search point
```

and map the id you find:

```yaml
jira:
  sites:
    - name: acme
      fields:
        customfield_10016: storyPoints
```

Then re-sync the affected work items with `devcontext sync --full --source jira`.

## Jira: descriptions look like `{"type":"doc",...}`

That should not happen — devcontext converts Atlassian Document Format to
markdown. If you see raw ADF, the field is a custom field: its value is stored
as returned. The original payload is always in `raw`.

## The sync stopped halfway

Every resource commits its cursor when it completes, so just run
`devcontext sync` again: finished resources are skipped, the interrupted one is
retried. The killed run is marked `interrupted` in `sync_runs`.

## Numbers look stale after changing sync flags

Cursors only fetch _changes_. After enabling a resource that was off before, run

```bash
devcontext sync --full --target acme/platform
```

## "The web viewer is not built"

`devcontext serve` serves `web/dist`. Run `npm run build:web` (or `npm run build`)
in the repository root. Until then the JSON API under `/api` still works.

## `ExperimentalWarning: SQLite is an experimental feature`

The CLI suppresses this warning. Scripts that import the package directly can
call `silenceSqliteExperimentalWarning()` from `cli/src/util/warnings.ts`, or
run node with `--no-warnings=ExperimentalWarning`.

## Node.js is too old

`node:sqlite` needs Node.js 22.5 or newer. Check with `node --version`.

## "What exactly is in this database?"

Usually asked by somebody who has to approve devcontext being used on work
data. `devcontext audit` answers it from the data itself — what is stored,
whose names are in it, where the files are, whether git would track them, and
what a sync fetches. `-o markdown` gives you a document to hand over.

## A credential ended up in the database

Someone pasted a token into a ticket or a CI log, and devcontext mirrored it
like any other text. Find it with:

```bash
devcontext audit secrets
```

The report never prints the value, only where it is. **Rotate the credential**:
it was already in GitHub or Jira before devcontext copied it, so the exposure
is not local. Deleting the local database does not undo it.

## Starting over

The database and the mirrors can always be rebuilt:

```bash
rm -rf .devcontext
devcontext sync
```
