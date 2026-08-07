import { useCallback, useSyncExternalStore } from 'react';

/**
 * The whole view state lives in the hash — `#/issues?repo=acme/web&state=all` —
 * so any view you are looking at can be copied out of the address bar and
 * pasted to somebody else, and a reload puts you back where you were.
 *
 * `history.replaceState` does not fire `hashchange`, so subscribers are
 * notified explicitly and the hash is read through `useSyncExternalStore`.
 */

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('hashchange', listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('hashchange', listener);
    window.removeEventListener('popstate', listener);
  };
}

function currentHash(): string {
  return window.location.hash;
}

export interface Location {
  view: string;
  params: URLSearchParams;
}

export function parseHash(hash: string): Location {
  const value = hash.replace(/^#\/?/, '');
  const split = value.indexOf('?');
  return split === -1
    ? { view: value, params: new URLSearchParams() }
    : { view: value.slice(0, split), params: new URLSearchParams(value.slice(split + 1)) };
}

export function buildHash(view: string, params: URLSearchParams): string {
  const query = params.toString();
  return query === '' ? `#/${view}` : `#/${view}?${query}`;
}

export function useLocation(): Location {
  return parseHash(useSyncExternalStore(subscribe, currentHash, () => ''));
}

/**
 * Reads one value out of the hash query string and writes it back.
 *
 * Filter changes replace the history entry rather than pushing one, so the
 * back button leaves the page instead of walking backwards through every
 * keystroke somebody typed into a search box.
 */
export function useUrlState(key: string, fallback = ''): [string, (value: string) => void] {
  const { params } = useLocation();
  const value = params.get(key) ?? fallback;

  const setValue = useCallback(
    (next: string) => {
      // The hash is re-read here rather than closed over, so a write always
      // lands on the view that is current, not the one this render saw.
      const current = parseHash(window.location.hash);
      const updated = new URLSearchParams(current.params);
      if (next === '' || next === fallback) updated.delete(key);
      else updated.set(key, next);

      const hash = buildHash(current.view, updated);
      if (hash === window.location.hash) return;
      window.history.replaceState(null, '', hash);
      notify();
    },
    [key, fallback],
  );

  return [value, setValue];
}

/** Navigates to another view, keeping no filters from the previous one. */
export function navigate(view: string, params: URLSearchParams = new URLSearchParams()): void {
  const hash = buildHash(view, params);
  if (hash === window.location.hash) return;
  window.location.hash = hash;
}
