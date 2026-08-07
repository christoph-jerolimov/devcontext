import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Command } from 'cmdk';

import { api } from '../api.ts';
import type { SearchHit } from '../api.ts';
import { navigate } from '../router.ts';

/** Where a hit of each kind lives, and how to open it there. */
const VIEW_FOR: Record<SearchHit['kind'], string> = {
  issue: 'issues',
  'pull-request': 'pulls',
  workitem: 'workitems',
};

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  issue: 'Issue',
  'pull-request': 'Pull request',
  workitem: 'Work item',
};

interface Page {
  id: string;
  label: string;
  hint: string;
  params?: Record<string, string>;
}

/*
 * Jumps worth one keystroke. The filtered ones exist because "show me what is
 * failing" and "show me what is stuck" are the questions people actually open
 * this tool with.
 */
const PAGES: Page[] = [
  { id: 'overview', label: 'Overview', hint: 'projects, counts, recent syncs' },
  { id: 'issues', label: 'GitHub issues', hint: 'open issues' },
  { id: 'pulls', label: 'Pull requests', hint: 'open pull requests' },
  {
    id: 'pulls',
    label: 'Pull requests — merged',
    hint: 'everything already shipped',
    params: { state: 'closed' },
  },
  { id: 'runs', label: 'Workflow runs', hint: 'recent Actions runs' },
  {
    id: 'runs',
    label: 'Workflow runs — failing',
    hint: 'runs that concluded in failure',
    params: { conclusion: 'failure' },
  },
  { id: 'workitems', label: 'Jira work items', hint: 'all work items' },
  {
    id: 'workitems',
    label: 'Jira work items — in progress',
    hint: 'what is being worked on',
    params: { category: 'In Progress' },
  },
  { id: 'sprints', label: 'Sprints', hint: 'sprint list' },
  { id: 'insights', label: 'Insights', hint: 'cycle time, review latency, WIP, flaky steps' },
  { id: 'digest', label: 'Digest', hint: 'what happened this week' },
];

/** `PLAT-42` or `acme/platform#42` typed straight into the box. */
function looksLikeReference(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(trimmed) || /^[\w.-]+\/[\w.-]+#\d+$/.test(trimmed);
}

/**
 * Pages are matched here rather than by cmdk's own filter.
 *
 * Results come from the server, so cmdk filters nothing (`shouldFilter={false}`)
 * — otherwise it would hide hits whose match is in a comment rather than the
 * title. That means pages need their own matcher, and they have to keep showing
 * while you type: "failing" should reach the failing-runs view, not disappear
 * the moment the box is no longer empty.
 */
function matchingPages(query: string): Page[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return PAGES;
  const words = needle.split(/\s+/);
  return PAGES.filter((page) => {
    const haystack = `${page.label} ${page.hint}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

function useDebounced(value: string, delayMs: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export function Palette(): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selection, setSelection] = useState({ key: '', value: '' });
  const debounced = useDebounced(query, 150);

  // Guards against an earlier response landing after a later one and
  // overwriting the results for what is currently typed.
  const latest = useRef(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const text = debounced.trim();
    if (text === '') {
      setHits([]);
      setSearching(false);
      return;
    }

    latest.current += 1;
    const token = latest.current;
    setSearching(true);

    api
      .search({ q: text, limit: '12' })
      .then((results) => {
        if (latest.current !== token) return;
        setHits(results);
        setSearching(false);
      })
      .catch(() => {
        if (latest.current !== token) return;
        setHits([]);
        setSearching(false);
      });
  }, [debounced]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setHits([]);
    setSelection({ key: '', value: '' });
  }, []);

  const go = useCallback(
    (view: string, params: Record<string, string> = {}) => {
      navigate(view, new URLSearchParams(params));
      close();
    },
    [close],
  );

  const openHit = useCallback(
    (hit: SearchHit) => {
      const params: Record<string, string> = { open: hit.ref };
      // The list behind the panel has to contain the item, and a closed issue
      // is not in the default "open" list.
      if (hit.kind !== 'workitem') params['state'] = 'all';
      go(VIEW_FOR[hit.kind], params);
    },
    [go],
  );

  if (!open) return null;

  const typed = query.trim();
  const pages = matchingPages(typed);
  const reference = typed !== '' && looksLikeReference(typed);
  const nothingToShow = pages.length === 0 && hits.length === 0 && !reference;

  /*
   * Results arrive after the pages are already on screen, so without this the
   * highlight would stay wherever it was and Enter would open a page instead of
   * the top result. The selection is therefore keyed to the list it belongs to:
   * arrowing keeps it, a changed list drops back to the first item.
   */
  const items = [
    ...(reference ? [`goto-${typed}`] : []),
    ...hits.map((hit) => `${hit.kind}-${hit.ref}`),
    ...pages.map((page) => page.label),
  ];
  const listKey = items.join('|');
  const value = selection.key === listKey ? selection.value : (items[0] ?? '');

  return (
    <div
      className="palette-backdrop"
      onClick={close}
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
      }}
      role="presentation"
    >
      <div className="palette" onClick={(event) => event.stopPropagation()} role="presentation">
        <Command
          label="Search and jump"
          shouldFilter={false}
          loop
          value={value}
          onValueChange={(next) => setSelection({ key: listKey, value: next })}
        >
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search issues, pull requests and work items — or jump to a page"
          />

          <Command.List>
            {nothingToShow ? (
              <div cmdk-empty="">{searching ? 'Searching…' : `Nothing matches “${typed}”.`}</div>
            ) : null}

            {reference ? (
              <Command.Group heading="Go to">
                <Command.Item
                  value={`goto-${typed}`}
                  onSelect={() =>
                    typed.includes('#')
                      ? go('issues', { state: 'all', open: typed })
                      : go('workitems', { open: typed.toUpperCase() })
                  }
                >
                  <span className="palette-ref">{typed}</span>
                  <span className="palette-hint">open directly</span>
                </Command.Item>
              </Command.Group>
            ) : null}

            {hits.length > 0 ? (
              <Command.Group heading="Results">
                {hits.map((hit) => (
                  <Command.Item
                    key={`${hit.kind}-${hit.ref}`}
                    value={`${hit.kind}-${hit.ref}`}
                    onSelect={() => openHit(hit)}
                  >
                    <span className="palette-ref">{hit.ref}</span>
                    <span className="palette-title">{hit.title}</span>
                    <span className="palette-hint">
                      {KIND_LABEL[hit.kind]}
                      {hit.state ? ` · ${hit.state}` : ''}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}

            {pages.length > 0 ? (
              <Command.Group heading="Pages">
                {pages.map((page) => (
                  <Command.Item
                    key={page.label}
                    value={page.label}
                    onSelect={() => go(page.id, page.params)}
                  >
                    <span className="palette-title">{page.label}</span>
                    <span className="palette-hint">{page.hint}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
          </Command.List>
        </Command>

        <footer className="palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  );
}
