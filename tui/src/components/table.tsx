import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

export interface Column<T> {
  header: string;
  /** The cell text. Keep it plain; colour goes in `colour`. */
  value: (row: T) => string;
  /** Fixed width in characters. Omitted means "take what is left". */
  width?: number;
  align?: 'left' | 'right';
  colour?: (row: T) => string | undefined;
  dim?: (row: T) => boolean;
}

/**
 * A table that never wraps.
 *
 * Ink reflows anything wider than the terminal onto the next line, which turns
 * a list into a wall. Every cell is therefore padded or cut to a known width,
 * and one flexible column absorbs whatever space is left — so a row is always
 * exactly one line, whatever the window is doing.
 */
export function Table<T>({
  rows,
  columns,
  selected,
  width,
  emptyMessage = 'Nothing here.',
}: {
  rows: T[];
  columns: Column<T>[];
  selected?: number;
  width: number;
  emptyMessage?: string;
}): ReactNode {
  if (rows.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>{emptyMessage}</Text>
      </Box>
    );
  }

  const widths = resolveWidths(columns, width);

  return (
    <Box flexDirection="column">
      <Box>
        {columns.map((column, index) => (
          <Box
            key={column.header}
            flexShrink={0}
            marginRight={index === columns.length - 1 ? 0 : 1}
          >
            <Text bold dimColor>
              {fit(column.header.toUpperCase(), widths[index] ?? 0, column.align)}
            </Text>
          </Box>
        ))}
      </Box>
      {rows.map((row, rowIndex) => {
        const active = rowIndex === selected;
        return (
          <Box key={rowIndex}>
            {columns.map((column, index) => (
              <Box
                key={column.header}
                flexShrink={0}
                marginRight={index === columns.length - 1 ? 0 : 1}
              >
                <Text
                  inverse={active}
                  color={active ? undefined : column.colour?.(row)}
                  dimColor={!active && column.dim?.(row) === true}
                >
                  {fit(column.value(row), widths[index] ?? 0, column.align)}
                </Text>
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Fixed columns keep their width; the rest share what is left.
 *
 * A minimum of four characters, because a column squeezed to nothing is worse
 * than one that is obviously cut — the reader can at least see it is there.
 */
function resolveWidths<T>(columns: Column<T>[], total: number): number[] {
  // One column of margin between cells, which the layout adds rather than the
  // text — Ink trims trailing whitespace off a text node, so a space written
  // on the end of a cell vanishes and the columns run into each other.
  const gaps = Math.max(0, columns.length - 1);
  const fixed = columns.reduce((sum, column) => sum + (column.width ?? 0), 0);
  const flexible = columns.filter((column) => column.width === undefined).length;
  const spare = Math.max(0, total - fixed - gaps);
  const each = flexible > 0 ? Math.max(4, Math.floor(spare / flexible)) : 0;
  return columns.map((column) => column.width ?? each);
}

/** Pads or truncates to exactly `width`, with an ellipsis when it had to cut. */
export function fit(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (width <= 0) return '';
  if (value.length === width) return value;
  if (value.length > width)
    return width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 1)}…`;
  const padding = ' '.repeat(width - value.length);
  return align === 'right' ? `${padding}${value}` : `${value}${padding}`;
}
