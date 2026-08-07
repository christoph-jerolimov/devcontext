/**
 * `node:sqlite` is still flagged experimental and prints a warning on first use.
 * The CLI depends on it on purpose (no native build step for users), so the
 * warning is noise for everybody but us. Everything else keeps warning normally.
 */
export function silenceSqliteExperimentalWarning(): void {
  const originalEmit = process.emit.bind(process);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).emit = function patchedEmit(name: string, data: unknown, ...rest: unknown[]) {
    if (
      name === 'warning' &&
      data instanceof Error &&
      data.name === 'ExperimentalWarning' &&
      /SQLite/i.test(data.message)
    ) {
      return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalEmit as any)(name, data, ...rest);
  };
}
