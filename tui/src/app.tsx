import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { nullLogger, runSync } from '@devcontext/cli';

import type { Store } from './data.js';
import { VIEWS } from './views/index.js';
import type { ViewId } from './views/index.js';

/**
 * Whether `s` can do anything with this detail: a targeted sync takes the
 * references `devcontext sync --only` takes — `acme/platform#42` or `PLAT-7`.
 * A workflow run or a sprint is opened by a bare numeric id, which is not one.
 */
export function syncableReference(reference: string): boolean {
  return /#\d+$/.test(reference) || /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(reference);
}

/**
 * The TUI syncs in-process: it is the CLI as a library, so unlike the web
 * viewer it needs no server to do the writing. The sync opens its own
 * read-write connection; the store's read-only handle just sees the result.
 */
async function syncReference(store: Store, reference: string): Promise<void> {
  await runSync({
    config: store.config,
    logger: nullLogger,
    full: false,
    dryRun: false,
    progress: false,
    writeOutputs: false,
    only: [reference],
    targetedOnly: true,
  });
}

/**
 * The shell: a sidebar of views, a body, and a key hint line.
 *
 * Deliberately the same eight views as the web viewer and in the same order.
 * Two front ends that disagree about what exists are two things to learn.
 */
export function App({
  store,
  syncItem = syncReference,
}: {
  store: Store;
  /** Injectable so the tests need no network; defaults to the real sync. */
  syncItem?: (store: Store, reference: string) => Promise<void>;
}): ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [viewIndex, setViewIndex] = useState(0);
  const [rows, setRows] = useState(stdout.rows || 24);
  const [columns, setColumns] = useState(stdout.columns || 100);
  /** Set by a view when it is showing one item rather than a list. */
  const [detail, setDetail] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [typing, setTyping] = useState(false);
  /** The reference being synced right now, or null. */
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  /** Bumped after a sync so the views re-read what it wrote. */
  const [dataVersion, setDataVersion] = useState(0);

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
    if (input === 's' && detail !== null && syncableReference(detail) && syncing === null) {
      const reference = detail;
      setSyncing(reference);
      setSyncNote(null);
      syncItem(store, reference)
        .then(() => {
          setSyncNote(`synced ${reference}`);
          setDataVersion((current) => current + 1);
        })
        .catch((error: unknown) => {
          setSyncNote(
            `sync of ${reference} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => setSyncing(null));
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
    () => ({ store, width: bodyWidth, height: bodyHeight, filter, detail, setDetail, dataVersion }),
    [store, bodyWidth, bodyHeight, filter, detail, dataVersion],
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
            : syncing !== null
              ? `syncing ${syncing}…`
              : `${syncNote === null ? '' : `${syncNote} · `}${filter === '' ? '' : `filter: ${filter} · `}1-${String(VIEWS.length)} or tab to switch · ↑↓ to move · enter to open${detail !== null && syncableReference(detail) ? ' · s to sync' : ''} · / to filter · q to quit`}
        </Text>
      </Box>
    </Box>
  );
}

export type { ViewId };
