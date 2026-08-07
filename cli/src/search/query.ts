/**
 * Turns what somebody typed into an FTS5 `MATCH` expression.
 *
 * This is not cosmetic: FTS5 reads `-`, `:`, `*`, `^`, `(` and `NEAR` as
 * operators, so `PLAT-42` means "PLAT not 42" and `customfield_10016:` is a
 * syntax error. Every term is therefore quoted, which turns it back into the
 * literal text the user meant.
 */

export interface MatchOptions {
  /**
   * Treat the last word as a prefix, so results appear while typing.
   * A quoted phrase is always exact.
   */
  prefixLast?: boolean;
}

const TOKEN = /"([^"]*)"|(\S+)/g;

export function toMatchQuery(input: string, options: MatchOptions = {}): string | null {
  const tokens: Array<{ value: string; phrase: boolean }> = [];

  for (const match of input.matchAll(TOKEN)) {
    const phrase = match[1] !== undefined;
    const value = (phrase ? match[1] : match[2])?.trim() ?? '';
    if (value !== '') tokens.push({ value, phrase });
  }

  if (tokens.length === 0) return null;

  const prefixLast = options.prefixLast ?? true;
  return tokens
    .map((token, index) => {
      const quoted = `"${token.value.replace(/"/g, '""')}"`;
      const last = index === tokens.length - 1;
      return prefixLast && last && !token.phrase ? `${quoted}*` : quoted;
    })
    .join(' AND ');
}

/** The `%like%` pattern used when the index is not available. */
export function toLikePattern(input: string): string {
  return `%${input.trim().toLowerCase()}%`;
}
