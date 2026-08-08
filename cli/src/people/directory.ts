/**
 * Who the names in the database belong to.
 *
 * Every person column devcontext stores is whatever string the API returned: a
 * GitHub login in `gh_issues.author`, a Jira display name in
 * `jira_workitems.assignee`, an email in a work log. Nothing joins them, so
 * `ghopper` and `Grace Hopper` are two strangers to every query that counts
 * them, and `Grace Hopper` and `grace hopper` are two more.
 *
 * The configuration is what fixes that: it names the people and lists the
 * identities each of them answers to. This module is the lookup in both
 * directions — from a stored string to the person, and from a person or a team
 * to the strings a `WHERE` clause has to match.
 *
 * The configuration is the only source of truth, and it is read fresh on every
 * command. The database keeps a mirror (see `people` and `person_identities`)
 * so a hand written query can join against it, but nothing here reads it —
 * editing the yaml takes effect on the next command, not the next sync.
 */

import type { Person, PersonKind, ResolvedConfig, Team } from '../config/types.js';
import { CliError } from '../util/errors.js';

export type IdentitySource = 'github' | 'jira';

/** The identities a filter has to match, lower cased and ready to bind. */
export interface PersonSelection {
  /** The people the selector named, deduplicated, in configuration order. */
  people: Person[];
  /** Every GitHub login those people answer to. */
  github: string[];
  /** Every Jira display name, account id or email those people answer to. */
  jira: string[];
  /** Both of the above in one list, for a query that spans the two sources. */
  all: string[];
}

/**
 * A GitHub App writes as `dependabot[bot]`, `renovate[bot]`,
 * `github-actions[bot]` — the suffix is GitHub's own, appended to every app
 * account, so it recognises the automations nobody bothered to configure.
 *
 * It is a fallback, not the rule: an entry in `bots:` wins over it, in both
 * directions. A repository can then hide its noisiest robot without listing
 * every other one first, and a service account with an ordinary looking login
 * can still be declared a bot.
 */
export function looksLikeBot(identity: string): boolean {
  return /\[bot\]$/i.test(identity.trim());
}

export class Directory {
  private readonly byId = new Map<string, Person>();
  private readonly byIdentity = new Map<string, Person>();
  private readonly teamsById = new Map<string, Team>();

  constructor(
    readonly people: readonly Person[],
    readonly teams: readonly Team[],
    /** The id `me:` names, or null when the configuration does not say. */
    readonly meId: string | null = null,
  ) {
    for (const person of people) {
      this.byId.set(person.id.toLowerCase(), person);
      for (const login of person.github) this.byIdentity.set(`github:${key(login)}`, person);
      for (const name of person.jira) this.byIdentity.set(`jira:${key(name)}`, person);
    }
    for (const team of teams) this.teamsById.set(team.id.toLowerCase(), team);
  }

  static from(config: ResolvedConfig): Directory {
    return new Directory(config.people, config.teams, config.me);
  }

  /** Whoever `me:` names, or nobody. */
  get me(): Person | undefined {
    return this.meId === null ? undefined : this.byId.get(this.meId.toLowerCase());
  }

  /** True when the configuration says nothing about people at all. */
  get empty(): boolean {
    return this.people.length === 0 && this.teams.length === 0;
  }

  /**
   * A person by id, with `me` resolving to whoever the configuration says.
   *
   * The literal id wins: somebody actually called `me` is still reachable, and
   * a configuration that names no `me:` leaves the word meaning nothing rather
   * than silently matching the first person in the list.
   */
  person(id: string): Person | undefined {
    const wanted = id.trim().toLowerCase();
    return this.byId.get(wanted) ?? (wanted === 'me' ? this.me : undefined);
  }

  team(id: string): Team | undefined {
    return this.teamsById.get(id.trim().toLowerCase());
  }

  membersOf(team: Team): Person[] {
    return team.members
      .map((member) => this.person(member))
      .filter((person): person is Person => person !== undefined);
  }

  /** The person a stored login or display name belongs to, if any. */
  identify(source: IdentitySource, identity: string | null | undefined): Person | undefined {
    if (identity === null || identity === undefined || identity.trim() === '') return undefined;
    return this.byIdentity.get(`${source}:${key(identity)}`);
  }

  /** What a stored login or display name is: configured first, then the suffix. */
  kindOf(source: IdentitySource, identity: string): PersonKind {
    const person = this.identify(source, identity);
    if (person) return person.kind;
    return looksLikeBot(identity) ? 'bot' : 'person';
  }

  /** Every identity configured as a bot, lower cased. */
  botIdentities(source?: IdentitySource): string[] {
    const found: string[] = [];
    for (const person of this.people) {
      if (person.kind !== 'bot') continue;
      if (source !== 'jira') found.push(...person.github.map(key));
      if (source !== 'github') found.push(...person.jira.map(key));
    }
    return [...new Set(found)];
  }

  /**
   * The identities named by `--person` and `--team`, or nothing when neither
   * was given.
   *
   * An unknown id throws rather than matching nothing. A filter that silently
   * selects nobody produces an empty list that looks exactly like a correct
   * answer, and a typo in a team name is otherwise indistinguishable from a
   * quiet week.
   */
  select(selector: {
    people?: readonly string[];
    teams?: readonly string[];
  }): PersonSelection | undefined {
    const named = selector.people ?? [];
    const teams = selector.teams ?? [];
    if (named.length === 0 && teams.length === 0) return undefined;

    const chosen = new Map<string, Person>();

    for (const id of named) {
      const person = this.person(id);
      if (!person) {
        // `me` gets its own hint: the fix is a `me:` line, not a different id.
        if (id.trim().toLowerCase() === 'me') {
          throw new CliError('devcontext.yaml does not say which of the people is you.', {
            hint: 'Add `me: <person id>` at the top level — see docs/people.md.',
          });
        }
        throw new CliError(`Unknown person "${id}".`, {
          hint: this.people.length
            ? `Known people: ${this.people.map((entry) => entry.id).join(', ')}`
            : 'Add a people: section to devcontext.yaml — see docs/people.md.',
        });
      }
      chosen.set(person.id, person);
    }

    for (const id of teams) {
      const team = this.team(id);
      if (!team) {
        throw new CliError(`Unknown team "${id}".`, {
          hint: this.teams.length
            ? `Known teams: ${this.teams.map((entry) => entry.id).join(', ')}`
            : 'Add a teams: section to devcontext.yaml — see docs/people.md.',
        });
      }
      for (const member of this.membersOf(team)) chosen.set(member.id, member);
    }

    // Configuration order rather than selection order, so two commands naming
    // the same people in different words bind the same list.
    const people = this.people.filter((person) => chosen.has(person.id));
    const github = unique(people.flatMap((person) => person.github.map(key)));
    const jira = unique(people.flatMap((person) => person.jira.map(key)));
    return { people, github, jira, all: unique([...github, ...jira]) };
  }
}

/** Identities compare case insensitively and without surrounding blanks. */
function key(identity: string): string {
  return identity.trim().toLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
