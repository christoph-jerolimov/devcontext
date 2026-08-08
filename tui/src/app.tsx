import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { Store } from './data.js';
import { VIEWS } from './views/index.js';
import type { ViewId } from './views/index.js';

/**
 * The shell: a sidebar of views, a body, and a key hint line.
 *
 * Deliberately the same eight views as the web viewer and in the same order.
 * Two front ends that disagree about what exists are two things to learn.
 */
export function App({ store }: { store: Store }): ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [viewIndex, setViewIndex] = useState(0);
  const [rows, setRows] = useState(stdout.rows || 24);
  const [columns, setColumns] = useState(stdout.columns || 100);
  /** Set by a view when it is showing one item rather than a list. */
  const [detail, setDetail] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    const onResize = (): void => {
      setRows(stdout.rows || 24);
      setColumns(stdout.columns || 100);
    };
    stdout.on('resize', onResize);
    return () => void stdout.off('resize', onResize);
  }, [stdout]);

  const view = VIEWS[viewIndex] ?? VIEWS[0];

  const move = useCallback((delta: number) => {
    setViewIndex((current) => (current + delta + VIEWS.length) % VIEWS.length);
    setDetail(null);
    setFilter('');
  }, []);

  useInput((input, key) => {
    // While typing a filter the view owns almost every key, so that a "q" in a
    // search term does not quit the program.
    if (typing) {
      if (key.escape) {
        setTyping(false);
        setFilter('');
        return;
      }
      if (key.return) {
        setTyping(false);
        return;
      }
      if (key.backspace || key.delete) {
        setFilter((current) => current.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) setFilter((current) => current + input);
      return;
    }

    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (input === '/') {
      setTyping(true);
      return;
    }
    if (key.escape) {
      if (detail !== null) setDetail(null);
      else setFilter('');
      return;
    }
    if (key.tab || key.rightArrow) return void move(1);
    if (key.shift && key.tab) return void move(-1);
    if (key.leftArrow) return void move(-1);

    const digit = Number(input);
    if (Number.isInteger(digit) && digit >= 1 && digit <= VIEWS.length) {
      setViewIndex(digit - 1);
      setDetail(null);
      setFilter('');
    }
  });

  const sidebarWidth = 20;
  // The body box spends four columns on its own chrome: a border either side
  // and a column of padding inside each. `bodyWidth` is what is left for
  // content, and the table is told exactly that — a table sized to the box
  // rather than to its inside wraps every row onto two lines.
  const bodyWidth = Math.max(20, columns - sidebarWidth - 4);
  // Chrome: the title line, the hint line, and the frame around the body.
  const bodyHeight = Math.max(3, rows - 4);

  const Component = view?.component;
  const context = useMemo(
    () => ({ store, width: bodyWidth, height: bodyHeight, filter, detail, setDetail }),
    [store, bodyWidth, bodyHeight, filter, detail],
  );

  return (
    <Box flexDirection="column" width={columns}>
      <Box>
        <Box width={sidebarWidth} flexDirection="column" paddingRight={1}>
          <Text bold>devcontext</Text>
          {VIEWS.map((entry, index) => (
            <Text key={entry.id} inverse={index === viewIndex} dimColor={index !== viewIndex}>
              {` ${String(index + 1)} ${entry.title}`}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column" width={bodyWidth + 4} borderStyle="round" paddingX={1}>
          {Component ? <Component {...context} /> : null}
        </Box>
      </Box>

      <Box>
        <Text dimColor>
          {typing
            ? `filter: ${filter}▏  enter to apply · esc to clear`
            : `${filter === '' ? '' : `filter: ${filter} · `}1-${String(VIEWS.length)} or tab to switch · ↑↓ to move · enter to open · / to filter · q to quit`}
        </Text>
      </Box>
    </Box>
  );
}

export type { ViewId };
