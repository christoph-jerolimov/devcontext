/**
 * Finds credentials that people paste into tickets, comments and CI logs.
 *
 * This matters because devcontext copies that text onto a laptop: a token in a
 * job log is a token in `.devcontext/devcontext.db` and, if the markdown
 * mirrors are enabled, in a file that could be committed by accident.
 *
 * Nothing here ever returns the secret itself — only where it is, what it looks
 * like, and enough of a fingerprint to find it. Printing a live credential to a
 * terminal or a CI log would spread it further, which is the opposite of the
 * point.
 */

export interface SecretPattern {
  id: string;
  label: string;
  pattern: RegExp;
  /**
   * `high` means the shape is specific enough to be a credential on its own.
   * `low` means it is a keyword heuristic that needs a human to confirm.
   */
  confidence: 'high' | 'low';
}

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: 'github-token',
    label: 'GitHub token',
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g,
    confidence: 'high',
  },
  {
    id: 'aws-access-key',
    label: 'AWS access key id',
    // Non-capturing on purpose: a capture group here would make the reported
    // fingerprint the four character prefix rather than the key.
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
    confidence: 'high',
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    confidence: 'high',
  },
  {
    id: 'google-api-key',
    label: 'Google API key',
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    confidence: 'high',
  },
  {
    id: 'atlassian-token',
    label: 'Atlassian API token',
    pattern: /\bATATT3[A-Za-z0-9_-]{20,}\b/g,
    confidence: 'high',
  },
  {
    id: 'npm-token',
    label: 'npm token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    confidence: 'high',
  },
  {
    id: 'openai-key',
    label: 'OpenAI key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    confidence: 'high',
  },
  {
    id: 'private-key',
    label: 'Private key block',
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    confidence: 'high',
  },
  {
    id: 'jwt',
    label: 'JSON web token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    confidence: 'high',
  },
  {
    id: 'url-credentials',
    label: 'Credentials in a URL',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/gi,
    confidence: 'high',
  },
  {
    id: 'assignment',
    label: 'Secret-looking assignment',
    // `password = "…"`, `api_key: …`, `AUTH_TOKEN=…`
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?([A-Za-z0-9/+=_.-]{12,})["']?/gi,
    confidence: 'low',
  },
];

export interface SecretFinding {
  patternId: string;
  label: string;
  confidence: 'high' | 'low';
  /** A masked fingerprint: first and last two characters, never the middle. */
  fingerprint: string;
  /** 1-based line within the scanned text, so it can be found again. */
  line: number;
}

/**
 * Values from documentation that are famous enough to be noise everywhere.
 *
 * Deliberately a short exact list rather than a pattern: dropping anything
 * containing "example" or "test" would also drop a real key whose random middle
 * happens to contain those letters, and a missed credential is a much worse
 * outcome here than one to wave away.
 */
const KNOWN_EXAMPLES = new Set([
  'AKIAIOSFODNN7EXAMPLE',
  'AKIAI44QH8DHBEXAMPLE',
  'ASIAIOSFODNN7EXAMPLE',
]);

/**
 * Placeholders that make the keyword heuristic useless.
 *
 * Applied to **low confidence findings only**. The high confidence patterns
 * match shapes that a credential has and prose does not, so second-guessing
 * them by content is how a scanner starts missing things.
 */
const OBVIOUS_PLACEHOLDERS = new RegExp(
  [
    '^(?:',
    'x{4,}|\\*{4,}|\\.{3,}', // xxxxxxxx, ****, ...
    '|<[^>]*>|\\$\\{[^}]*\\}|\\$[A-Z][A-Z0-9_]*', // <YOUR_SECRET>, ${VAR}, $VAR
    '|(?:your|my|our|the|some|a)[-_][\\w-]*', // your-api-key-here
    '|[\\w-]*(?:goes[-_]?here|here|placeholder|redacted|changeme|example|sample|dummy|fake|test)[\\w-]*',
    '|secret|password|passwd|token|apikey|api[-_]key|credential',
    '|1234\\d*|abc123[\\w-]*',
    ')$',
  ].join(''),
  'i',
);

/** Masks a value so the report can name it without leaking it. */
export function fingerprint(value: string): string {
  if (value.length <= 6) return `${value.slice(0, 1)}…(${value.length} chars)`;
  return `${value.slice(0, 3)}…${value.slice(-2)} (${value.length} chars)`;
}

export function scanText(text: string | null | undefined): SecretFinding[] {
  if (!text || text === '') return [];

  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  for (const entry of SECRET_PATTERNS) {
    // The patterns are module level and carry /g, so lastIndex has to be reset.
    entry.pattern.lastIndex = 0;
    let match: RegExpExecArray | null = entry.pattern.exec(text);

    while (match !== null) {
      const value = match[1] ?? match[0];
      const noise =
        KNOWN_EXAMPLES.has(value) ||
        (entry.confidence === 'low' && OBVIOUS_PLACEHOLDERS.test(value));

      if (!noise) {
        const key = `${entry.id}:${value}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({
            patternId: entry.id,
            label: entry.label,
            confidence: entry.confidence,
            fingerprint: fingerprint(value),
            line: lineOf(text, match.index),
          });
        }
      }
      match = entry.pattern.exec(text);
    }
  }

  return findings;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index && position < text.length; position += 1) {
    if (text[position] === '\n') line += 1;
  }
  return line;
}
