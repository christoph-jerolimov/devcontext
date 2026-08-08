import type { ReactNode } from 'react';

import { api } from '../api.ts';
import type { HistoryResponse, OpenOnDay } from '../api.ts';
import { Panel, StateMessage, useAsync } from '../components/common.tsx';
import { useUrlState } from '../router.ts';

const WINDOWS = [
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '180', label: 'Last 6 months' },
  { value: '365', label: 'Last year' },
];

/**
 * How many items were open, day by day.
 *
 * No other view can answer this. An item opened in January, closed in February
 * and reopened in March is one row saying "open", and that row reads the same
 * whichever month you ask about — so the shape comes from `state_changes`,
 * which keeps the transitions rather than the outcome. See docs/history.md.
 */
export function HistoryView(): ReactNode {
  const [days, setDays] = useUrlState('days', '30');
  const [source, setSource] = useUrlState('source');

  const { data, error, loading } = useAsync<HistoryResponse>(() => {
    const to = new Date();
    const from = new Date(to.getTime() - (Number(days) - 1) * 86_400_000);
    return api.history({
      from: from.toISOString(),
      to: to.toISOString(),
      source: source || undefined,
    });
  }, [days, source]);

  const rows = data?.days ?? [];

  return (
    <div className="stack">
      <Panel
        title="Open over time"
        actions={
          <>
            <select value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="">Both sources</option>
              <option value="github">GitHub</option>
              <option value="jira">Jira</option>
            </select>
            <select value={days} onChange={(event) => setDays(event.target.value)}>
              {WINDOWS.map((window) => (
                <option key={window.value} value={window.value}>
                  {window.label}
                </option>
              ))}
            </select>
          </>
        }
      >
        <StateMessage
          loading={loading}
          error={error}
          empty={rows.length === 0}
          emptyMessage='No history yet. It is built after every sync — or run "devcontext history --rebuild".'
        />
        {rows.length > 0 ? <OpenChart days={rows} /> : null}
      </Panel>

      {(data?.byAssignee.length ?? 0) > 0 ? (
        <Panel title="Open per person, now">
          <table className="table">
            <thead>
              <tr>
                <th>Assignee</th>
                <th className="right">Open</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {(data?.byAssignee ?? []).map((entry) => (
                <tr key={entry.assignee}>
                  <td>{entry.assignee}</td>
                  <td className="right">{entry.open}</td>
                  <td>
                    <Meter
                      value={entry.open}
                      peak={Math.max(...(data?.byAssignee ?? []).map((row) => row.open), 1)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
    </div>
  );
}

const WIDTH = 720;
const HEIGHT = 200;
const PADDING = { top: 12, right: 8, bottom: 22, left: 34 };

/**
 * The balance as an area, with what crossed in and out as bars beneath it.
 *
 * Drawn as plain SVG rather than pulled from a charting library: the shape is
 * a line and some rectangles, and a dependency for that would outweigh it.
 * A `viewBox` with no fixed width makes it scale to the panel, so there is no
 * resize handler either.
 */
function OpenChart({ days }: { days: OpenOnDay[] }): ReactNode {
  const peak = Math.max(...days.map((day) => day.open), 1);
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;

  const x = (index: number): number =>
    PADDING.left + (days.length <= 1 ? plotWidth / 2 : (index / (days.length - 1)) * plotWidth);
  const y = (value: number): number => PADDING.top + plotHeight - (value / peak) * plotHeight;

  const line = days.map((day, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(day.open)}`);
  const area = [
    ...line,
    `L${x(days.length - 1)},${PADDING.top + plotHeight}`,
    `L${x(0)},${PADDING.top + plotHeight}`,
    'Z',
  ];

  // Enough labels to read the axis, never so many that they collide.
  const every = Math.max(1, Math.ceil(days.length / 6));

  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Open items per day, from ${days[0]?.day ?? ''} to ${days.at(-1)?.day ?? ''}, peaking at ${String(peak)}`}
      >
        {[0, peak].map((value) => (
          <g key={value}>
            <line
              className="chart-grid"
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={y(value)}
              y2={y(value)}
            />
            <text className="chart-label" x={PADDING.left - 6} y={y(value) + 4} textAnchor="end">
              {value}
            </text>
          </g>
        ))}

        <path className="chart-area" d={area.join(' ')} />
        <path className="chart-line" d={line.join(' ')} />

        {days.map((day, index) => (
          <g key={day.day}>
            {/* One transparent column per day, so the native tooltip covers
                the whole height rather than only the pixel on the line. */}
            <rect
              className="chart-hit"
              x={x(index) - plotWidth / days.length / 2}
              y={PADDING.top}
              width={plotWidth / days.length}
              height={plotHeight}
            >
              <title>{`${day.day}: ${String(day.open)} open (+${String(day.opened)} / -${String(day.closed)})`}</title>
            </rect>
            {index % every === 0 ? (
              <text className="chart-label" x={x(index)} y={HEIGHT - 6} textAnchor="middle">
                {day.day.slice(5)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      <figcaption className="muted small">
        {`${String(days.at(-1)?.open ?? 0)} open now · peak ${String(peak)} · ${String(days.reduce((sum, day) => sum + day.opened, 0))} opened and ${String(days.reduce((sum, day) => sum + day.closed, 0))} closed in the window`}
      </figcaption>
    </figure>
  );
}

/** A proportion, as a bar. Wide enough to compare, short enough for a cell. */
function Meter({ value, peak }: { value: number; peak: number }): ReactNode {
  return (
    <span className="meter" aria-hidden="true">
      <span className="meter-fill" style={{ width: `${String((value / peak) * 100)}%` }} />
    </span>
  );
}
