import type { ReactNode } from 'react';

import { api } from '../api.ts';
import type { StatusResponse } from '../api.ts';
import { useAsync } from './common.tsx';
import { useUrlState } from '../router.ts';

/**
 * One dropdown for "whose items am I looking at".
 *
 * People and teams share a control rather than getting one each, because they
 * answer the same question and nobody wants to reason about what "person =
 * grace, team = platform" is supposed to mean. They travel as two URL
 * parameters all the same, since the server has to know which it was given —
 * `platform` could be either.
 *
 * The whole control disappears when devcontext.yaml names nobody. An empty
 * dropdown offering "Anyone" and nothing else is a promise of a feature that
 * is not configured, and the fix for it is in a file, not on this page.
 */
export function usePeopleFilter(): {
  control: ReactNode;
  params: { person?: string | undefined; team?: string | undefined };
  /** Changes when the selection does, for an effect dependency list. */
  key: string;
} {
  const [person, setPerson] = useUrlState('person');
  const [team, setTeam] = useUrlState('team');

  // Shared with the Overview and every other view: one request, cached by the
  // browser, rather than a directory fetch per filter bar.
  const status = useAsync<StatusResponse>(() => api.status(), []);
  const people = status.data?.filters.people ?? [];
  const teams = status.data?.filters.teams ?? [];

  const value = team ? `team:${team}` : person ? `person:${person}` : '';

  const onChange = (next: string): void => {
    const [kind, id] = next.split(':');
    setPerson(kind === 'person' && id ? id : '');
    setTeam(kind === 'team' && id ? id : '');
  };

  const control =
    people.length === 0 && teams.length === 0 ? null : (
      <select
        value={value}
        aria-label="Person or team"
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Anyone</option>
        {teams.length > 0 ? (
          <optgroup label="Teams">
            {teams.map((entry) => (
              <option key={entry.id} value={`team:${entry.id}`}>
                {entry.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {people.length > 0 ? (
          <optgroup label="People">
            {people
              .filter((entry) => entry.kind === 'person')
              .map((entry) => (
                <option key={entry.id} value={`person:${entry.id}`}>
                  {entry.name}
                </option>
              ))}
          </optgroup>
        ) : null}
        {people.some((entry) => entry.kind === 'bot') ? (
          <optgroup label="Bots">
            {people
              .filter((entry) => entry.kind === 'bot')
              .map((entry) => (
                <option key={entry.id} value={`person:${entry.id}`}>
                  {entry.name}
                </option>
              ))}
          </optgroup>
        ) : null}
      </select>
    );

  return {
    control,
    params: { person: person || undefined, team: team || undefined },
    key: value,
  };
}
