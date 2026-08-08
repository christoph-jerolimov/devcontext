import type { ReactNode } from 'react';

/**
 * The two chart shapes the viewer draws.
 *
 * Plain SVG rather than a charting library: these are a line and some
 * rectangles, and a dependency for that would outweigh them. A `viewBox` with
 * no fixed width makes them scale to the panel, so there is no resize handler
 * either.
 */

const WIDTH = 720;
const HEIGHT = 200;
const PADDING = { top: 12, right: 8, bottom: 22, left: 34 };

const PLOT_WIDTH = WIDTH - PADDING.left - PADDING.right;
const PLOT_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;

/** Enough labels to read the axis, never so many that they collide. */
function labelEvery(count: number): number {
  return Math.max(1, Math.ceil(count / 6));
}

export interface AreaPoint {
  day: string;
  value: number;
  /** Shown in the native tooltip; the value alone is rarely the whole story. */
  title: string;
}

/** A balance over time: how many of something there were on each day. */
export function AreaChart({
  points,
  label,
  caption,
}: {
  points: AreaPoint[];
  label: string;
  caption?: ReactNode;
}): ReactNode {
  const peak = Math.max(...points.map((point) => point.value), 1);

  const x = (index: number): number =>
    PADDING.left +
    (points.length <= 1 ? PLOT_WIDTH / 2 : (index / (points.length - 1)) * PLOT_WIDTH);
  const y = (value: number): number => PADDING.top + PLOT_HEIGHT - (value / peak) * PLOT_HEIGHT;

  const line = points.map(
    (point, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(point.value)}`,
  );
  const area = [
    ...line,
    `L${x(points.length - 1)},${PADDING.top + PLOT_HEIGHT}`,
    `L${x(0)},${PADDING.top + PLOT_HEIGHT}`,
    'Z',
  ];
  const every = labelEvery(points.length);

  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}, from ${points[0]?.day ?? ''} to ${points.at(-1)?.day ?? ''}, peaking at ${String(peak)}`}
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

        {points.map((point, index) => (
          <g key={point.day}>
            {/* One transparent column per day, so the tooltip covers the whole
                height rather than only the pixel on the line. */}
            <rect
              className="chart-hit"
              x={x(index) - PLOT_WIDTH / points.length / 2}
              y={PADDING.top}
              width={PLOT_WIDTH / points.length}
              height={PLOT_HEIGHT}
            >
              <title>{point.title}</title>
            </rect>
            {index % every === 0 ? (
              <text className="chart-label" x={x(index)} y={HEIGHT - 6} textAnchor="middle">
                {point.day.slice(5)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      {caption ? <figcaption className="muted small">{caption}</figcaption> : null}
    </figure>
  );
}

export interface StackedBar {
  day: string;
  /** Bottom to top, in this order. Zero-height segments are skipped. */
  segments: Array<{ key: string; value: number; className: string }>;
  title: string;
}

/**
 * Counts per day, split by outcome.
 *
 * Stacked rather than side by side because the total matters as much as the
 * split: how much was finished, and how much of it was worth finishing. Two
 * bars next to each other make the reader add them up.
 */
export function StackedBarChart({
  bars,
  label,
  legend,
  caption,
}: {
  bars: StackedBar[];
  label: string;
  legend: Array<{ key: string; className: string }>;
  caption?: ReactNode;
}): ReactNode {
  const totals = bars.map((bar) => bar.segments.reduce((sum, segment) => sum + segment.value, 0));
  const peak = Math.max(...totals, 1);

  const slot = PLOT_WIDTH / Math.max(bars.length, 1);
  // A visible gap, but never so wide that a single day becomes a sliver.
  const barWidth = Math.max(1, slot * 0.7);
  const height = (value: number): number => (value / peak) * PLOT_HEIGHT;
  const every = labelEvery(bars.length);

  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}, from ${bars[0]?.day ?? ''} to ${bars.at(-1)?.day ?? ''}, peaking at ${String(peak)}`}
      >
        {[0, peak].map((value) => (
          <g key={value}>
            <line
              className="chart-grid"
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={PADDING.top + PLOT_HEIGHT - height(value)}
              y2={PADDING.top + PLOT_HEIGHT - height(value)}
            />
            <text
              className="chart-label"
              x={PADDING.left - 6}
              y={PADDING.top + PLOT_HEIGHT - height(value) + 4}
              textAnchor="end"
            >
              {value}
            </text>
          </g>
        ))}

        {bars.map((bar, index) => {
          const left = PADDING.left + index * slot + (slot - barWidth) / 2;
          let bottom = PADDING.top + PLOT_HEIGHT;

          return (
            <g key={bar.day}>
              {bar.segments
                .filter((segment) => segment.value > 0)
                .map((segment) => {
                  const segmentHeight = height(segment.value);
                  bottom -= segmentHeight;
                  return (
                    <rect
                      key={segment.key}
                      className={segment.className}
                      x={left}
                      y={bottom}
                      width={barWidth}
                      height={segmentHeight}
                    />
                  );
                })}
              {/* The hit area spans the full column so an empty day still has
                  a tooltip — "nothing happened" is an answer worth reading. */}
              <rect
                className="chart-hit"
                x={PADDING.left + index * slot}
                y={PADDING.top}
                width={slot}
                height={PLOT_HEIGHT}
              >
                <title>{bar.title}</title>
              </rect>
              {index % every === 0 ? (
                <text
                  className="chart-label"
                  x={PADDING.left + index * slot + slot / 2}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                >
                  {bar.day.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="muted small">
        <span className="chart-legend">
          {legend.map((entry) => (
            <span key={entry.key}>
              <span className={`chart-key ${entry.className}`} aria-hidden="true" /> {entry.key}
            </span>
          ))}
        </span>
        {caption}
      </figcaption>
    </figure>
  );
}
