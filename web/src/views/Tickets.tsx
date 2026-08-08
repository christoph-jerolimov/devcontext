import type { ReactNode } from 'react';

import { api, formatRelative } from '../api.ts';
import type { TicketContainer, TicketType, TicketsResponse } from '../api.ts';
import { Badge, Panel, StateMessage, useAsync } from '../components/common.tsx';
import { useUrlState } from '../router.ts';

/**
 * GitHub issues and Jira work items in one list.
 *
 * The two already have views of their own. This one exists because "what is
 * open on this project" rarely stops at a system boundary, and answering it
 * otherwise means reading two tables and merging them in your head.
 */
export function TicketsView(): ReactNode {
  const [source, setSource] = useUrlState('source');
  const [container, setContainer] = useUrlState('container');
  const [type, setType] = useUrlState('type');
  const [state, setState] = useUrlState('state', 'all');
  const [search, setSearch] = useUrlState('search');

  const params = {
    source: source || undefined,
    container: container || undefined,
    type: type || undefined,
    state,
    search: search || undefined,
    limit: '200',
  };

  const list = useAsync<TicketsResponse>(
    () => api.tickets(params),
    [source, container, type, state, search],
  );

  /*
   * The two dropdowns describe themselves from the data.
   *
   * They deliberately ignore the filter they populate — asking for the types
   * *within* the Bug filter would leave the dropdown holding only Bug, and no
   * way back. Everything else applies, so the counts describe the list on
   * screen rather than the database as a whole.
   */
  const types = useAsync<TicketType[]>(
    () => api.ticketTypes({ ...params, type: undefined }),
    [source, container, state, search],
  );
  const containers = useAsync<TicketContainer[]>(
    () => api.ticketContainers({ ...params, container: undefined }),
    [source, type, state, search],
  );

  const tickets = list.data?.tickets ?? [];

  return (
    <Panel
      title="Tickets"
      actions={
        <>
          <select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="">Both sources</option>
            <option value="github">GitHub</option>
            <option value="jira">Jira</option>
          </select>

          <select value={container} onChange={(event) => setContainer(event.target.value)}>
            <option value="">All repositories and projects</option>
            {(containers.data ?? []).map((entry) => (
              <option key={`${entry.source} ${entry.container}`} value={entry.container}>
                {entry.container} ({entry.count})
              </option>
            ))}
          </select>

          <select value={type} onChange={(event) => setType(event.target.value)}>
            <option value="">All types</option>
            {mergeTypes(types.data ?? []).map((entry) => (
              <option key={entry.type} value={entry.type}>
                {entry.type} ({entry.count})
              </option>
            ))}
          </select>

          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="all">Any state</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>

          <input
            type="search"
            placeholder="Search title and body"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </>
      }
    >
      <StateMessage
        loading={list.loading}
        error={list.error}
        empty={tickets.length === 0}
        emptyMessage="Nothing matched. Widen the filters, or run a sync first."
      />

      {tickets.length > 0 ? (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Reference</th>
                <th>Type</th>
                <th>Title</th>
                <th>Status</th>
                <th>Assignee</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr key={`${ticket.source} ${ticket.ref}`}>
                  <td>
                    <Badge value={ticket.source} />
                  </td>
                  <td>
                    {ticket.url ? (
                      <a href={ticket.url} target="_blank" rel="noreferrer">
                        {ticket.ref}
                      </a>
                    ) : (
                      ticket.ref
                    )}
                  </td>
                  <td className="muted">{ticket.type}</td>
                  <td>{ticket.title}</td>
                  <td>
                    {/* The word the source uses, coloured by what it means. */}
                    <Badge
                      value={ticket.status ?? ticket.state}
                      kind={ticket.state === 'open' ? undefined : 'done'}
                    />
                  </td>
                  <td className="muted">{ticket.assignee}</td>
                  <td className="muted">{formatRelative(ticket.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* A page is not the answer; saying so beats implying it is. */}
          <p className="muted small">
            {list.data && list.data.total > tickets.length
              ? `Showing ${String(tickets.length)} of ${String(list.data.total)} — narrow the filters to see the rest.`
              : `${String(tickets.length)} ticket(s).`}
          </p>
        </>
      ) : null}
    </Panel>
  );
}

/**
 * One entry per type name, summing the sources that use it.
 *
 * "Bug" means the same thing whichever system it came from, so a dropdown
 * offering it twice is asking the reader to know something they do not.
 */
function mergeTypes(types: TicketType[]): Array<{ type: string; count: number }> {
  const totals = new Map<string, number>();
  for (const entry of types) {
    totals.set(entry.type, (totals.get(entry.type) ?? 0) + entry.count);
  }
  return [...totals]
    .map(([type, count]) => ({ type, count }))
    .toSorted((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}
