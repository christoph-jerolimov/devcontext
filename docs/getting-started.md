# Getting started

## Requirements

- Node.js 22.5 or newer (devcontext uses the built-in `node:sqlite`, so there is
  no native module to compile)
- A GitHub token for the repositories you want to sync
- A Jira API token if you sync Jira

## Install

```bash
git clone https://github.com/christoph-jerolimov/devcontext.git
cd devcontext
npm install
npm run build
```

`npm run build` compiles the CLI to `cli/dist` and the web viewer to `web/dist`.
Afterwards the CLI can be run as:

```bash
node cli/bin/devcontext.js --help
```

To get a `devcontext` command on your `PATH`, link the workspace once:

```bash
npm link --workspace @devcontext/cli
devcontext --help
```

The rest of the documentation uses `devcontext` for brevity.

## Tokens

devcontext only reads. The tokens need read access, nothing more.

| Variable         | Used for              | Scope                                                                                                                                                                                                          |
| ---------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`   | GitHub REST API       | `repo` for private repositories, `public_repo` otherwise. Add `workflow`/`actions:read` for Actions data. A fine grained token needs _Contents: read_, _Issues: read_, _Pull requests: read_, _Actions: read_. |
| `JIRA_EMAIL`     | Jira Cloud basic auth | the account e-mail                                                                                                                                                                                             |
| `JIRA_API_TOKEN` | Jira                  | created at <https://id.atlassian.com/manage-profile/security/api-tokens>; on Jira Data Center use a personal access token together with `auth: bearer`                                                         |

The token variable names are configurable — see [Configuration](configuration.md).
Without a GitHub token the sync still works for public repositories but is
limited to 60 requests per hour, which is not enough for a real repository.

## Configure

```bash
cd ~/work/my-repo
devcontext init
```

`init` looks at the git remotes of the current directory and writes a
`devcontext.yaml` for the repository it finds, so the usual case needs no
editing at all:

```
info:  Wrote /home/me/work/my-repo/devcontext.yaml
info:  Detected acme/platform (remote origin)
info:  Using the token in $GITHUB_TOKEN.
info:  Next: run "devcontext sync".
```

Useful variants:

```bash
devcontext init --detect        # print what would be detected, write nothing
devcontext init --repo acme/platform   # override the detection
devcontext init --all-remotes   # include upstream and other remotes too
devcontext init --example       # the fully commented example instead
```

Outside a git checkout (or when no remote points at GitHub) `init` falls back
to the commented example. The
minimum useful configuration is:

```yaml
version: 1

github:
  hosts:
    - name: github.com
      tokenEnv: GITHUB_TOKEN

jira:
  sites:
    - name: acme
      baseUrl: https://acme.atlassian.net
      email: ${JIRA_EMAIL}
      tokenEnv: JIRA_API_TOKEN

projects:
  - key: platform
    github:
      - repo: acme/platform
    jira:
      - project: PLAT
```

A project can link any number of GitHub repositories and Jira projects, and you
can configure any number of projects. See [Configuration](configuration.md) for
every available key.

## First sync

```bash
devcontext sync
```

The first run is a full sync: it downloads every issue, pull request, comment,
event, review, commit, workflow run, Jira work item, comment and history entry
that matches your configuration. A progress line reports how many API calls are
done and how many are still expected:

```
[##########--------------]  42% | 615/1442 calls | 388 items | 3m 12s elapsed | ~4m 20s left | acme/platform: pull requests
```

Every following `devcontext sync` continues where the last one stopped; only
changes are downloaded. See [Sync](sync.md) for the details.

Useful flags for the first run:

```bash
devcontext sync --source github          # only GitHub
devcontext sync --target acme/platform   # only one repository
devcontext sync --dry-run                # talk to the APIs, write nothing
devcontext sync --delay 1000             # be extra gentle: one call per second
```

## First queries

```bash
devcontext status                      # what is in the database, and when it was synced
devcontext gh repos
devcontext gh issues --repo acme/platform
devcontext gh issues 12                # one issue with every comment and event
devcontext gh prs --state all --author alice
devcontext gh runs --conclusion failure
devcontext jira workitems --project PLAT
devcontext jira epics
devcontext jira search "rate limit"
devcontext jira sprints --state active
```

Every command supports `--output default|json|markdown|plain`, and every list
command supports `--list` for shell scripts:

```bash
for issue in $(devcontext gh issues --stale 180d --list); do
  echo "stale: $issue"
done
```

## Browse the data

```bash
devcontext web
```

opens a local server (default <http://127.0.0.1:4173>) with a React viewer for
the same database. See [Web viewer](web.md).

## What ends up on disk

```
.devcontext/
├── devcontext.db          the SQLite database — the primary target
├── yaml/                  one yaml file per issue, pull request, work item, ...
└── markdown/              the same content rendered as readable markdown
```

`.devcontext/` is git ignored by default. The yaml and markdown mirrors are
derived data: delete them at any time and run `devcontext export` to write them
again from the database.
