/**
 * What the GitHub API will not give you, however politely you ask.
 *
 * `/actions/runs` stops paginating after 400 pages. At the 100 items per page
 * this client requests, that is 40,000 runs — and past it the endpoint returns
 * nothing further, whatever the repository actually holds.
 *
 * This matters because `maxWorkflowRuns: null` reads as "every run" and cannot
 * be. A repository with 60,000 runs configured that way used to walk to the end
 * of what the API served and stop, silently, twenty thousand runs short. The
 * database was then wrong in the specific way nothing reveals: every question
 * about the missing period answered confidently with a smaller number.
 *
 * So the ceiling is stated here rather than discovered, and both directions are
 * handled. A cap above it is refused when the configuration loads, because a
 * number that cannot be honoured is a mistake worth catching before the first
 * request. No cap at all is allowed and warned about when the walk actually
 * reaches the ceiling, because that is the point at which the answer stopped
 * being complete.
 */

/** Pages the runs endpoint will serve before it stops. */
export const RUN_PAGE_LIMIT = 400;

/** What this client asks for per page, which is also GitHub's maximum. */
export const RUN_PAGE_SIZE = 100;

/** The most runs any sync can reach: 40,000. */
export const MAX_REACHABLE_WORKFLOW_RUNS = RUN_PAGE_LIMIT * RUN_PAGE_SIZE;

/** `40000` reads as a typo; `40,000` reads as a number. */
function grouped(count: number): string {
  return count.toLocaleString('en-US');
}

/**
 * The message for a cap that cannot be honoured.
 *
 * Separate from where it is thrown so the configuration loader and its test
 * cannot drift apart on the wording, and so the number appears once.
 */
export function runCapTooLarge(value: number): string {
  return (
    `maxWorkflowRuns is ${grouped(value)}, but GitHub stops paginating ` +
    `/actions/runs after ${String(RUN_PAGE_LIMIT)} pages — ` +
    `${grouped(MAX_REACHABLE_WORKFLOW_RUNS)} runs at most.`
  );
}

/**
 * The warning for a walk that ran out of API rather than out of runs.
 *
 * Says what it stopped at and, crucially, that there is more — a sync that
 * ends at exactly 40,000 with no explanation looks like a repository that
 * happens to have 40,000 runs.
 */
export function runCeilingReached(target: string): string {
  return (
    `${target}: stopped at ${grouped(MAX_REACHABLE_WORKFLOW_RUNS)} workflow runs, ` +
    `which is as far as the GitHub API paginates. Older runs exist and were not ` +
    `fetched. Use \`since\` to sync a specific earlier period instead.`
  );
}
