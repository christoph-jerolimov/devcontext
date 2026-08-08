import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { Store } from '../data.js';
import { Table } from '../components/table.js';
import type { Column } from '../components/table.js';

export interface ViewProps {
  store: Store;
  width: number;
  height: number;
  filter: string;
  detail: string | null;
  setDetail: (value: string | null) => void;
}

/**
 * A scrolling, selectable list with an optional detail pane — the shape seven
 * of the eight views take.
 *
 * Only the visible slice is rendered. Ink diffs and repaints whatever it is
 * given, so handing it ten thousand rows to draw twenty of makes every
 * keystroke quadratic in the size of the repository.
 */
export function ListView<T>({
  rows,
  columns,
  height,
  width,
  refOf,
  detail,
  setDetail,
  renderDetail,
  emptyMessage,
  footer,
}: {
  rows: T[];
  columns: Column<T>[];
  height: number;
  width: number;
  refOf: (row: T) => string;
  detail: string | null;
  setDetail: (value: string | null) => void;
  renderDetail?: (row: T) => ReactNode;
  emptyMessage?: string;
  footer?: ReactNode;
}): ReactNode {
  const [cursor, setCursor] = useState(0);

  // A filter that shortens the list must not leave the cursor past the end.
  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const open = detail === null ? undefined : rows.find((row) => refOf(row) === detail);

  // Two lines of chrome: the header row and the count line below it.
  const visible = Math.max(1, height - 3);
  /*
   * Every hook runs before the detail pane's early return.
   *
   * React counts hooks per render and a component that calls fewer on one pass
   * than the last throws — which in a terminal shows up as the whole frame
   * going blank, with no error anywhere, because there is no console left to
   * print it to.
   */
  const start = useMemo(
    () => Math.max(0, Math.min(cursor - Math.floor(visible / 2), rows.length - visible)),
    [cursor, visible, rows.length],
  );

  useInput((_input, key) => {
    if (open) return;
    if (key.upArrow) setCursor((current) => Math.max(0, current - 1));
    if (key.downArrow) setCursor((current) => Math.min(rows.length - 1, current + 1));
    if (key.pageUp) setCursor((current) => Math.max(0, current - 10));
    if (key.pageDown) setCursor((current) => Math.min(rows.length - 1, current + 10));
    if (key.return && rows[cursor]) setDetail(refOf(rows[cursor]));
  });

  if (open && renderDetail) {
    return (
      <Box flexDirection="column">
        <Text bold>{refOf(open)}</Text>
        <Box flexDirection="column" marginTop={1}>
          {renderDetail(open)}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>esc to go back</Text>
        </Box>
      </Box>
    );
  }

  const slice = rows.slice(start, start + visible);

  return (
    <Box flexDirection="column">
      <Table
        rows={slice}
        columns={columns}
        selected={cursor - start}
        width={width}
        emptyMessage={emptyMessage ?? 'Nothing here yet. Run a sync first.'}
      />
      {rows.length > 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            {`${String(cursor + 1)} of ${String(rows.length)}`}
            {rows.length > visible ? ` · showing ${String(slice.length)}` : ''}
          </Text>
        </Box>
      ) : null}
      {footer}
    </Box>
  );
}

/** Case insensitive substring match over whichever fields a view cares about. */
export function matches(filter: string, ...fields: Array<string | null | undefined>): boolean {
  if (filter === '') return true;
  const needle = filter.toLowerCase();
  return fields.some((field) => (field ?? '').toLowerCase().includes(needle));
}
