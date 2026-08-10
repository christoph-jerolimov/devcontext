/**
 * Whether the server this viewer talks to can sync at all.
 *
 * The status request answers it once, in App; a context carries it down so a
 * deeply nested component — the "Sync this item" button in a detail panel —
 * does not need the whole status threaded through every view on the way.
 * Null means a plain `devcontext serve`: read-only, no sync controls anywhere.
 */

import { createContext, useContext } from 'react';

import type { WatchStatus } from '@devcontext/shared';

export const WatchContext = createContext<WatchStatus | null>(null);

export function useWatch(): WatchStatus | null {
  return useContext(WatchContext);
}
