# People, bots and teams

Every person column devcontext stores is whatever string the API returned. A
GitHub login in `gh_issues.author`, a Jira display name in
`jira_workitems.assignee`, sometimes an email in a work log. Nothing joins
them.

So without any configuration, one colleague is several people:

```
$ devcontext people --unmapped
SOURCE  IDENTITY       ITEMS
github  ghopper          214
jira    Grace Hopper     139
github  grace-h           27
```

Those are one person. Any count that groups by author counts her three times,
any filter that names one of the three finds a third of her work, and nothing
about the output says so.

## Naming people

```yaml
people:
  - id: grace
    name: Grace Hopper
    email: grace@example.com
    github: [ghopper, grace-h]
    jira: ['Grace Hopper']

  - id: ada
    name: Ada Lovelace
    github: [ada]
    jira: ['Ada Lovelace', 'ada@example.com']

bots:
  - id: dependabot
    github: ['dependabot[bot]']

teams:
  - id: platform
    name: Platform
    members: [grace, ada]
```

`id` is what the command line takes; everything else is description. `name`
defaults to the id, so an entry can be one line.

An identity belongs to exactly one person. Two people claiming the same login
is an error naming both, rather than a lookup that resolves to whichever entry
came first — which would be right about half the time and wrong invisibly.

The two namespaces are separate: a GitHub login and a Jira display name that
happen to read the same are two identities, and giving them to different people
is fine.

Matching ignores case and surrounding blanks. It is exact otherwise —
`grace hopper` finds `Grace Hopper`, and nothing finds `G. Hopper` unless you
list it.

### Bots

`bots:` is `people:` with `bot` already answered. Writing `bot: true` inside
`people:` does the same thing; the separate section only exists because a
configuration with four humans and nine automations reads better split in two.

A login ending in `[bot]` is treated as a bot whether or not it is configured.
That is GitHub's own convention for App accounts, so `renovate[bot]`,
`github-actions[bot]` and the rest are excluded by `--no-bots` from the start.
The configuration overrules the suffix in both directions: an entry under
`people:` stays a person despite the suffix, and a service account with an
ordinary looking login becomes a bot by being listed under `bots:`.

### Teams

A team is a list of person ids and nothing else — no hierarchy, no roles. It
exists so a filter can name the group.

An unknown member is an error when the configuration loads. An unknown `--team`
is an error when the command runs. Both could have been "match nothing", and
both would then be indistinguishable from a quiet week.

### Which one is you

```yaml
me: grace
```

`--me` is then shorthand for `--person grace` everywhere `--person` works, and
`--person me` means the same thing:

```bash
devcontext github prs --me --state open
devcontext digest --me --since 1d
devcontext activity --me
```

Two rules, both about not guessing:

- **Without `me:` the word means nothing.** `--me` is an error naming the fix,
  rather than a filter that quietly picks the first person in the list and
  reports somebody else's work as yours.
- **A person actually called `me` keeps the name.** The literal id wins.

`me:` must name a configured person; a typo is refused when the configuration
loads, for the same reason an unknown `--person` is.

## Filtering by them

`--person` and `--team` are on `issues`, `prs` and `tickets`, and match the
**author or an assignee**. "The platform team's issues" means both the ones
they raised and the ones they were handed; a filter that answered only one of
those would need the other one named every time. `--author` and `--assignee`
are still there when only one side is wanted.

```bash
devcontext github prs --team platform --state open
devcontext tickets --person grace --state open
devcontext github issues --no-bots
devcontext github prs --bots-only --repo acme/platform
```

Repeat either flag, or pass a comma separated list:

```bash
devcontext tickets --person grace --person ada
devcontext tickets --team platform,infra
```

The viewer has the same filter as one dropdown on Activity, Issues, Pull
requests and Tickets, and hides it when nothing is configured. The API takes
`?person=` and `?team=` on the same lists, and `/api/people` returns the
directory.

[Activity](cli.md#devcontext-activity-aliases-feed-changes) is where the
mapping pays off most: a feed of what people did is unreadable when the same
colleague appears under three names, and `--by-person` over a month is the
fastest way to notice a fourth.

### One thing worth knowing

A person with no identity on a source matches nothing there, rather than
everything. Asking about a Jira-only colleague on the GitHub side returns an
empty list, which is the honest answer — the alternative is every issue in the
repository, attributed to somebody who has no account on it.

## Checking the mapping

A mapping is a list of strings somebody typed, and a typo in one looks exactly
like a quiet colleague. So both directions are reportable.

```bash
devcontext people --identities
```

```
PERSON  SOURCE  IDENTITY      AUTHORED  ASSIGNED  COMMENTS  LAST SEEN
grace   github  ghopper            214       118       901  2026-08-04
grace   github  grace-h             27        11        64  2024-02-19
grace   jira    Grace Hopper       139       162       410  2026-08-06
ada     github  adalovelace          0         0         0
```

The last row is the point: a configured identity that appears in nothing is
either somebody who has not started yet or a login that was spelled wrong, and
those are worth telling apart.

The other direction finds the person nobody configured:

```bash
devcontext people --unmapped
```

Busiest first, and cut to the limit **after** the configured names are
dropped — otherwise asking for ten unmapped names comes back with three,
because seven of the busiest authors were already accounted for.

## In the database

The configuration is mirrored into `people`, `person_identities`, `teams` and
`team_members` on every sync, so a query written outside devcontext can join
against it:

```sql
SELECT p.name, COUNT(*) AS issues
  FROM gh_issues i
  JOIN person_identities pi
    ON pi.source = 'github' AND pi.identity = LOWER(i.author)
  JOIN people p ON p.id = pi.person_id
 WHERE i.state = 'open'
 GROUP BY p.id
 ORDER BY issues DESC;
```

Nothing devcontext itself runs reads those tables. Every command loads the
configuration anyway, and reading the mirror instead would mean a correction to
devcontext.yaml took effect only after the next sync. Editing the file changes
the next command.

The write is a replace: a person removed from the configuration disappears from
the tables too, rather than leaving a join that still resolves a name its owner
no longer answers to.
