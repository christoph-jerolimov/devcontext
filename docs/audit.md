# Audit

```bash
devcontext audit                # everything
devcontext audit secrets        # credentials pasted into tickets and CI logs
devcontext audit config         # what a sync would fetch, before you run one
devcontext audit storage        # where the data is and whether git would take it
devcontext audit -o markdown    # a document to hand to somebody who has to approve this
```

devcontext copies private issue text, review discussions and CI logs onto your
laptop. That is the whole point, and it is also the thing a security team will
ask about. `audit` answers their questions from the data itself rather than
from a promise.

## Sections

### `storage` — where it is

Every path devcontext writes, its size, its POSIX mode, and whether **git would
track it**. That last column is the one that matters: committing
`.devcontext/` publishes every issue, comment and log the database holds. If
anything is not ignored, the report says so in a sentence rather than a column.

### `content` — what is stored

Row counts per kind of thing, and for each one the columns that hold free text
somebody wrote — those are the ones carrying anything confidential.

It also states the thing that is easy to forget: every row keeps the untouched
API payload in its `raw` column, so anything the API returned is present even
when no column names it.

### `people` — whose data it is

Everybody the database names, and why they are in it ("issue author",
"reviewer", "changed a field"). Commit author email addresses are counted
separately, because those are personal data under GDPR and similar regimes and
are the most likely thing to be asked about.

`--list` prints just the names.

### `secrets` — credentials in the synced text

Scans issue bodies, comments, pull request descriptions, reviews, work item
descriptions and **job logs** for things that look like credentials: GitHub and
Atlassian tokens, AWS access keys, Slack and Google keys, private key blocks,
JSON web tokens, and credentials embedded in URLs.

This is worth running even if you never adopt anything else. A token in a CI
log is a token in your database and, if the markdown mirrors are on, in a file
that could be committed by accident.

**The values are never printed.** The report gives the reference, the field,
the line and a masked fingerprint (`ghp…aa (40 chars)`). Printing a live
credential into a terminal or a CI log would leak it a second time, which is
the opposite of the point.

Findings are marked `high` or `low` confidence. High means the shape is
specific enough to be a credential on its own. Low means a keyword heuristic
(`password = "..."`) that needs a human, and is left out unless you pass
`--all`.

Two judgement calls worth knowing about:

- A high confidence match is **not** filtered by its content. A real key whose
  random middle happens to spell `test` or `example` still gets reported —
  missing a credential is a far worse outcome than one you wave away.
- The handful of keys that appear in AWS's own documentation are the exception,
  as an exact list, because they turn up in enough tickets to be pure noise.

If something is real: **rotate it**. devcontext only mirrors what GitHub or
Jira already stored, so the exposure predates the local copy.

### `config` — what a sync would fetch

Per target: which resources it fetches, which it skips, everything limiting it
(a date bound, the JQL filter, the workflow run cap, the log truncation), and
the **name** of the environment variable the credential comes from — never the
value. A target whose token is not set is called out, because it would fail.

The report also states the guarantee plainly: every API call devcontext makes
is a GET. It never writes to GitHub or Jira.

## Options

| Option                | Description                                       |
| --------------------- | ------------------------------------------------- |
| `--all`               | Include low confidence secret matches             |
| `-n, --limit <count>` | Rows per section (default 25)                     |
| `--list`              | Bare identifiers only, for `people` and `secrets` |
| `-o <format>`         | `default`, `json`, `markdown` or `plain`          |

`-o markdown` produces a document you can attach to a review request.
`-o json` is the form to assert on in CI — for example, failing a job when
`secrets.highConfidence` is above zero.

```bash
devcontext audit secrets -o json | jq -e '.secrets.highConfidence == 0'
```
