# Development

## Layout

devcontext is an npm workspaces monorepo:

```
.
├── cli/          @devcontext/cli — sync, database, read commands, web server
├── web/          @devcontext/web — the React viewer
├── site/         @devcontext/site — the public site, which renders docs/
├── docs/         this documentation
└── devcontext.example.yaml
```

```bash
npm install          # installs every workspace
npm run build        # web/dist, then cli/dist
npm run build:site   # site/dist
npm run dev:site     # the site with hot reload
npm run docs         # regenerate docs/commands.md from the command definitions
npm test             # vitest in cli/ and web/
npm run typecheck    # tsc --noEmit in every workspace
npm run lint         # oxlint
npm run lint:fix     # oxlint --fix
npm run format       # oxfmt
npm run check        # format:check + lint + typecheck + test, what CI runs
```

## The site

`site/` is an Astro build of `docs/`. The markdown is **not** copied — the
content collection reads `../docs`, so a page added there is published with no
list to update, and the files stay correct on GitHub and on disk at the same
time.

Two Sätteri hast plugins do the work that a site needs and a repository does
not:

- `docs-links` rewrites the cross references. `sync.md` becomes `/docs/sync`,
  and anything climbing out of `docs/` becomes a GitHub URL — otherwise every
  page would be full of links that 404.
- `table-scroll` wraps each table in its own scroll container, because the
  reference pages are mostly wide tables and they would otherwise push the
  whole page sideways on a phone.

They are Sätteri plugins rather than rehype ones so the site does not pull the
whole `unified` pipeline in as a dependency; Astro's default processor already
takes hast plugins.

`site/scripts/check-links.mjs` walks the built output and fails on an internal
link that does not resolve. CI runs it after the build, which is what catches a
renamed page.

`astro check` is deliberately not used: it needs `@astrojs/check`, which calls
a TypeScript compiler API that TypeScript 7 no longer exposes. The site's real
logic — the navigation and the two plugins — is type checked with `tsc` through
`tsconfig.check.json` instead, and `astro build` proves the templates compile.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on every push to
`main`, for Node 22 and Node 24:

```
npm ci → format:check → lint → typecheck → test → build
```

Two more jobs run alongside it: **Site** builds `site/` and checks the rendered
links, and **End to end sync** syncs this repository from the real GitHub API.
Both are separate so a GitHub outage or a rate limit cannot make the offline
checks look broken.

Run `npm run check` before pushing and CI will agree with you. The three tools
have clearly separated jobs, which keeps the rule sets small:

- **oxfmt** (`.oxfmtrc.json`) owns formatting — TypeScript, JavaScript, JSON,
  YAML and markdown.
- **oxlint** (`.oxlintrc.json`) owns what formatting and types cannot see:
  unused code, `no-console` outside the output layer, consistent type imports,
  and the rules of hooks in `web/`.
- **tsc** owns types, so no type-aware lint rules are enabled and linting stays
  in the millisecond range.

Both are the Rust based [oxc](https://oxc.rs) tools, which is why the whole
check is fast enough to run on every save.

### Notable lint settings

- The `react` and `react-hooks` plugins are enabled in a `web/**` override
  only. The CLI is not a React project, and running those rules over it just
  produces false positives.
- `no-await-in-loop` is off. Sequential `await` inside a loop is the design of
  the syncers: calls are paced by the rate limiter, pagination is inherently
  ordered, and running them concurrently would defeat both.
- `react/react-in-jsx-scope` is off because `web/` uses the automatic JSX
  runtime (`"jsx": "react-jsx"`), where `React` does not need to be in scope.

## Dependencies

Everything is kept on its latest release, including TypeScript 7. Keeping the
toolchain on oxlint and oxfmt is part of what makes that possible: the previous
ESLint setup pinned TypeScript below 6.1 through `typescript-eslint`'s peer
range, and oxc has no such constraint.

`@types/node` follows the latest Node release, while the package supports Node
22.5+. CI runs the tests on both 22 and 24, which is what catches an API that
the types promise but the oldest supported runtime does not have.

## Inside `cli/src`

| Path                | Responsibility                                                                  |
| ------------------- | ------------------------------------------------------------------------------- |
| `main.ts`, `cli.ts` | Entry point and command wiring (commander)                                      |
| `commands/`         | One file per command group; they only parse options, format output and delegate |
| `config/`           | Schema (zod), defaults, path/token resolution, `devcontext init` template       |
| `db/`               | `Database` (a thin `node:sqlite` wrapper), the schema, the sync journal         |
| `db/queries/`       | Every read query, shared by the CLI, the exporters and the web API              |
| `documents/`        | Database rows → one complete "document" per issue / pull request / work item    |
| `sources/github/`   | REST client, payload → row mapping, the repository syncer                       |
| `sources/jira/`     | REST client, ADF and wiki markup → markdown, payload → row mapping, the syncer  |
| `audit/`            | What is stored locally, and the credential scanner behind `audit secrets`       |
| `search/`           | The FTS5 index, the query builder, and the scan used without FTS5               |
| `sync/`             | Rate limiter, progress reporter, HTTP client, the sync runner                   |
| `output/`           | Table and document rendering for `default`, `json`, `markdown`, `plain`         |
| `exporters/`        | The yaml / markdown / json mirrors                                              |
| `web/`              | Static file serving plus the JSON API                                           |

Two rules keep this navigable:

1. **Nothing is thrown away.** Every mapper stores the untouched payload in
   `raw` and lifts the useful fields into columns next to it.
2. **One query layer.** `db/queries` is the only place that writes SQL for
   reads, so the CLI, the exporters and the web API always agree.

## Tests

```bash
npm test                          # everything, offline
npm test -- src/config            # one directory
npm run test:e2e                  # against the real GitHub API, see below
npm run test:watch --workspace @devcontext/cli
```

`npm test` runs both workspaces. The web viewer's tests cover the markdown
parser in `web/src/markdown/`, which is pure and therefore worth pinning down:
its job is to render every body correctly _and_ to never turn one into markup.

`cli/src/sync/runner.integration.test.ts` runs a complete sync against a stubbed
`fetch`: it asserts the rows that end up in the database, the cursors, the
markdown and yaml files, the incremental second run and the dry run. It is the
fastest way to see how the pieces fit together, and the first place to extend
when you add a resource.

### End to end tests

`cli/src/e2e/*.e2e.test.ts` sync this repository from the **real** GitHub API
and assert on what actually comes back — pagination, payload shapes, the
timeline media type, and cursors that survive a second incremental run. They
are excluded from `npm test` so the normal suite stays offline and
deterministic, and they run as their own CI job.

They are opt in:

```bash
DEVCONTEXT_E2E_TOKEN=ghp_... npm run test:e2e   # recommended
DEVCONTEXT_E2E=1 npm run test:e2e               # unauthenticated, 60 calls/hour
```

Without either variable every test skips itself. A token is strongly
recommended: the unauthenticated budget is 60 requests per hour and one run
needs about 30, so a second run in the same hour fails on the rate limit.
`DEVCONTEXT_E2E_REPO` and `DEVCONTEXT_E2E_SINCE` override what is synced.

## Adding a synced resource

1. Add the table to `cli/src/db/schema.ts` (`CREATE TABLE IF NOT EXISTS`, keep a
   `raw` and a `synced_at` column).
2. Add a client method in `sources/<source>/client.ts`.
3. Add a mapper in `sources/<source>/map.ts` — pure function, payload → row.
4. Call it from the syncer inside an `operation(...)` block so the run,
   the API call count and the cursor are recorded.
5. Add read queries in `db/queries/` and surface them in a command, the
   exporters and the web API.
6. Extend the integration test with a fixture and an assertion.

Bumping `SCHEMA_VERSION` is only necessary when existing data has to be
migrated; the schema itself is created idempotently on every start.

## Adding a command

`commands/` uses small builder functions per command. Reuse `addListOptions`,
`addTimeFilterOptions`, `openReadContext` and `renderTable`, and every new
command automatically supports `--output`, `--list`, `--limit` and the time
filters.

## Code style

- TypeScript with `strict` plus `noUncheckedIndexedAccess`, ESM everywhere
  (relative imports carry the `.js` extension).
- The **CLI** has no runtime dependency beyond `commander`, `yaml` and `zod`;
  the database is the built-in `node:sqlite`, HTTP is the built-in `fetch`. MCP
  and the markdown conversion are hand written for that reason.
- The **web viewer** adds `react`, `react-dom` and `cmdk` (the command
  palette). Nothing it depends on reaches the CLI, which is what people install.
- oxfmt with the settings in `.oxfmtrc.json` (100 columns, single quotes).
