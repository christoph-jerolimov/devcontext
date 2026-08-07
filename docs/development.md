# Development

## Layout

devcontext is an npm workspaces monorepo:

```
.
├── cli/          @devcontext/cli — sync, database, read commands, web server
├── web/          @devcontext/web — the React viewer
├── docs/         this documentation
└── devcontext.example.yaml
```

```bash
npm install          # installs both workspaces
npm run build        # web/dist, then cli/dist
npm test             # vitest in cli/
npm run typecheck    # tsc --noEmit in both workspaces
npm run format       # prettier
```

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
| `sources/jira/`     | REST client, ADF → markdown, payload → row mapping, the project syncer          |
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
npm test                          # everything
npm test -- src/config            # one directory
npm run test:watch --workspace @devcontext/cli
```

`cli/src/sync/runner.integration.test.ts` runs a complete sync against a stubbed
`fetch`: it asserts the rows that end up in the database, the cursors, the
markdown and yaml files, the incremental second run and the dry run. It is the
fastest way to see how the pieces fit together, and the first place to extend
when you add a resource.

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
- No runtime dependency beyond `commander`, `yaml` and `zod`; the database is
  the built-in `node:sqlite`, HTTP is the built-in `fetch`.
- Prettier with the settings in `.prettierrc.json` (100 columns, single quotes).
