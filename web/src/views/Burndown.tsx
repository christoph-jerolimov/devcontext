import { useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '../api.ts';
import type { BurndownDay, BurndownResponse, Sprint, VelocityResponse } from '../api.ts';
import { Badge, Panel, StateMessage, useAsync } from '../components/common.tsx';
import { useUrlState } from '../router.ts';

/**
 * The shape a sprint took, rather than the shape it is in.
 *
 * The Sprints view already says what a sprint holds now. It cannot say whether
 * the team was ever on track, because an item finished on day two and one
 * finished an hour ago are the same row there. This reads `state_changes`,
 * where both the finishing and the joining are ±1 rows with a timestamp — so
 * work pulled in mid sprint lifts the line on the day it arrived instead of
 * being backdated to the start.
 */
export function BurndownView(): ReactNode {
  const [sprintId, setSprintId] = useUrlState('sprint');
  const [unit, setUnit] = useUrlState('unit', 'items');

  const sprints = useAsync<Sprint[]>(() => api.sprints({ limit: '200' }), []);
  // Whatever the picker has, else the newest sprint the API returned.
  const chosen = sprintId || String(sprints.data?.[0]?.id ?? '');

  const report = useAsync<BurndownResponse | null>(
    () => (chosen ? api.burndown(Number(chosen)) : Promise.resolve(null)),
    [chosen],
  );
  const velocity = useAsync<VelocityResponse>(() => api.velocity({ limit: '12' }), []);

  const data = report.data;
  const points = unit === 'points' && data?.hasPoints === true;

  return (
    <>
      <Panel
        title="Burndown"
        actions={
          <>
            <select value={chosen} onChange={(event) => setSprintId(event.target.value)}>
              {(sprints.data ?? []).map((sprint) => (
                <option key={sprint.id} value={String(sprint.id)}>
                  {sprint.name ?? `Sprint ${String(sprint.id)}`}
                </option>
              ))}
            </select>
            <select value={unit} onChange={(event) => setUnit(event.target.value)}>
              <option value="items">Items</option>
              <option value="points">Story points</option>
            </select>
          </>
        }
      >
        <StateMessage
          loading={report.loading || sprints.loading}
          error={report.error}
          empty={data === null || data === undefined || data.days.length === 0}
          emptyMessage="This sprint has no recorded history yet. Run a sync, then devcontext history --rebuild."
        />

        {data && data.days.length > 0 ? (
          <>
            <p className="burn-summary">
              <Badge value={data.sprint.state} />
              <span>
                <strong>{String(points ? data.committed.points : data.committed.items)}</strong>{' '}
                committed
              </span>
              <span>
                <strong>{String(points ? data.completed.points : data.completed.items)}</strong>{' '}
                completed
              </span>
              <span className={data.scope.added > 0 ? 'burn-scope' : 'muted'}>
                {data.scope.added === 0 && data.scope.removed === 0
                  ? 'no scope change'
                  : `+${String(data.scope.added)} / −${String(data.scope.removed)} scope`}
              </span>
            </p>

            {unit === 'points' && !data.hasPoints ? (
              <p className="muted small">
                No work item in this sprint carries an estimate, so the item count is shown instead.
              </p>
            ) : null}

            {points && !data.pointsAreHistorical ? (
              <p className="muted small">
                These estimates are the current ones, not the ones each item had on the day — this
                database predates the points history. Run <code>devcontext history --rebuild</code>.
              </p>
            ) : null}

            <BurnChart days={data.days} points={points} />

            {data.scope.changes.length > 0 ? <ScopeTable changes={data.scope.changes} /> : null}
          </>
        ) : null}
      </Panel>

      <Panel title="Velocity">
        <StateMessage
          loading={velocity.loading}
          error={velocity.error}
          empty={(velocity.data?.sprints ?? []).length === 0}
          emptyMessage="No sprint has a start date, so none can be placed in time."
        />
        {velocity.data && velocity.data.sprints.length > 0 ? (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Sprint</th>
                  <th>Started</th>
                  <th className="numeric">Committed</th>
                  <th className="numeric">Completed</th>
                  {velocity.data.hasPoints ? <th className="numeric">Points done</th> : null}
                  <th className="numeric">Added</th>
                  <th className="numeric">Ratio</th>
                </tr>
              </thead>
              <tbody>
                {velocity.data.sprints.map((sprint) => (
                  <tr key={sprint.id}>
                    <td>{sprint.name ?? `Sprint ${String(sprint.id)}`}</td>
                    <td className="muted">{sprint.startDate?.slice(0, 10)}</td>
                    <td className="numeric">{sprint.committed.items}</td>
                    <td className="numeric">{sprint.completed.items}</td>
                    {velocity.data?.hasPoints ? (
                      <td className="numeric">{sprint.completed.points}</td>
                    ) : null}
                    <td className="numeric muted">{sprint.added || ''}</td>
                    <td className={`numeric ${ratioClass(sprint.ratio)}`}>
                      {sprint.ratio === null ? '' : `${String(Math.round(sprint.ratio * 100))}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              {`Average completed: ${String(velocity.data.average.items)} items` +
                (velocity.data.hasPoints
                  ? `, ${String(velocity.data.average.points)} points`
                  : '') +
                ' per sprint.'}
            </p>
          </>
        ) : null}
      </Panel>
    </>
  );
}

const WIDTH = 720;
const HEIGHT = 220;
const PADDING = { top: 12, right: 8, bottom: 22, left: 34 };

/**
 * Remaining against the ideal, with the total scope behind both.
 *
 * The scope area is what makes this readable. A burndown alone cannot tell a
 * team that stopped finishing things from one that had a fortnight of work
 * added on day four — in both the remaining line goes flat. Drawing the total
 * behind it says which happened.
 */
function BurnChart({ days, points }: { days: BurndownDay[]; points: boolean }): ReactNode {
  const remainingOf = (day: BurndownDay): number => (points ? day.remainingPoints : day.remaining);
  const idealOf = (day: BurndownDay): number | null => (points ? day.idealPoints : day.ideal);
  const scopeOf = (day: BurndownDay): number =>
    points ? day.remainingPoints + day.donePoints : day.inSprint;

  const peak = Math.max(1, ...days.map((day) => Math.max(scopeOf(day), idealOf(day) ?? 0)));
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;

  const x = (index: number): number =>
    PADDING.left + (days.length <= 1 ? plotWidth / 2 : (index / (days.length - 1)) * plotWidth);
  const y = (value: number): number => PADDING.top + plotHeight - (value / peak) * plotHeight;

  // The actual series stops at today; the ideal one runs the whole sprint.
  const actual = days.filter((day) => day.actual);
  const path = (values: Array<{ index: number; value: number }>): string =>
    values.map((point, i) => `${i === 0 ? 'M' : 'L'}${x(point.index)},${y(point.value)}`).join(' ');

  const remainingPath = path(actual.map((day, index) => ({ index, value: remainingOf(day) })));
  const scopePoints = actual.map((day, index) => ({ index, value: scopeOf(day) }));
  const scopeArea =
    scopePoints.length > 0
      ? `${path(scopePoints)} L${x(scopePoints.length - 1)},${PADDING.top + plotHeight} L${x(0)},${PADDING.top + plotHeight} Z`
      : '';
  const idealPath = path(
    days
      .map((day, index) => ({ index, value: idealOf(day) }))
      .filter((point): point is { index: number; value: number } => point.value !== null),
  );

  const every = Math.max(1, Math.ceil(days.length / 6));
  const unit = points ? 'points' : 'items';

  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Burndown from ${days[0]?.day ?? ''} to ${days.at(-1)?.day ?? ''}, starting at ${String(remainingOf(days[0] ?? days[0]!))} ${unit}`}
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

        {scopeArea ? <path className="chart-area burn-scope-area" d={scopeArea} /> : null}
        {idealPath ? <path className="burn-ideal" d={idealPath} /> : null}
        <path className="chart-line" d={remainingPath} />

        {days.map((day, index) => (
          <g key={day.day}>
            <rect
              className="chart-hit"
              x={x(index) - plotWidth / days.length / 2}
              y={PADDING.top}
              width={plotWidth / days.length}
              height={plotHeight}
            >
              <title>
                {day.actual
                  ? `${day.day}: ${String(remainingOf(day))} left of ${String(scopeOf(day))} ${unit}` +
                    (day.added || day.removed
                      ? ` (+${String(day.added)} / −${String(day.removed)} scope)`
                      : '')
                  : `${day.day}: still to come`}
              </title>
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
        <span className="burn-key burn-key-line" /> remaining
        <span className="burn-key burn-key-scope" /> total scope
        {idealPath ? (
          <>
            <span className="burn-key burn-key-ideal" /> ideal
          </>
        ) : (
          <span> · no ideal line: this sprint has no start and end date</span>
        )}
      </figcaption>
    </figure>
  );
}

function ScopeTable({ changes }: { changes: BurndownResponse['scope']['changes'] }): ReactNode {
  const [open, setOpen] = useState(false);

  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="muted small">
        {`${String(changes.length)} scope change(s) after the sprint started`}
      </summary>
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Change</th>
            <th>Item</th>
            <th className="numeric">Points</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => (
            <tr key={`${change.key} ${change.at}`}>
              <td className="muted">{change.at.slice(0, 10)}</td>
              <td className={change.direction === 'added' ? 'burn-scope' : 'muted'}>
                {change.direction}
              </td>
              <td>{change.key}</td>
              <td className="numeric muted">{change.points || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/**
 * Green for a sprint that delivered what it promised, amber for one that fell
 * short. Above 100% gets neither: it means work arrived after the plan was
 * agreed, which the Added column explains rather than praises.
 */
function ratioClass(ratio: number | null): string {
  if (ratio === null) return 'muted';
  if (ratio > 1) return 'muted';
  return ratio === 1 ? 'ratio-met' : 'ratio-short';
}
