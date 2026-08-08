/**
 * The configured people and teams, mirrored into the database.
 *
 * Nothing devcontext runs reads these tables — every command loads the
 * configuration anyway, and reading them instead would mean a rename in
 * devcontext.yaml took effect only after the next sync. They exist so the
 * database is self describing, the same reason `projects` does: a hand written
 * query, a notebook or a BI tool can join `gh_issues.author` to a person
 * without being handed the yaml file as well.
 *
 * The write is a replace, not a merge. A person deleted from the configuration
 * has to disappear here too, or the join would keep resolving a name its owner
 * no longer answers to.
 */

import type { ResolvedConfig } from '../config/types.js';
import type { Database } from '../db/database.js';

export function storeDirectory(db: Database, config: ResolvedConfig): void {
  const updatedAt = new Date().toISOString();

  db.transaction(() => {
    db.exec(
      'DELETE FROM team_members; DELETE FROM teams; DELETE FROM person_identities; DELETE FROM people;',
    );

    for (const person of config.people) {
      db.upsert('people', {
        id: person.id,
        name: person.name,
        email: person.email,
        kind: person.kind,
        updated_at: updatedAt,
      });

      for (const [source, identities] of [
        ['github', person.github],
        ['jira', person.jira],
      ] as const) {
        for (const identity of identities) {
          db.upsert('person_identities', {
            source,
            identity: identity.trim().toLowerCase(),
            display: identity,
            person_id: person.id,
          });
        }
      }
    }

    for (const team of config.teams) {
      db.upsert('teams', {
        id: team.id,
        name: team.name,
        description: team.description,
        updated_at: updatedAt,
      });
      team.members.forEach((member, position) => {
        db.upsert('team_members', { team_id: team.id, person_id: member, position });
      });
    }
  });
}
