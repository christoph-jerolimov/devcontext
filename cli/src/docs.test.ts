import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe as suite, expect, it } from 'vitest';

import { createProgram } from './cli.js';
import { TOOLS } from './mcp/tools.js';

/*
 * The documentation is checked against the program rather than by eye, because
 * the failure mode is silent: an option gets added, nobody updates the page,
 * and the reference quietly becomes a lie.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = join(ROOT, 'docs');

function docFiles(): string[] {
  return readdirSync(DOCS)
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(DOCS, name))
    .concat(join(ROOT, 'README.md'));
}

function readAllDocs(): Map<string, string> {
  return new Map(docFiles().map((path) => [path, readFileSync(path, 'utf8')]));
}

interface Leaf {
  name: string;
  longFlags: string[];
}

function leafCommands(): Leaf[] {
  const leaves: Leaf[] = [];
  const walk = (command: ReturnType<typeof createProgram>, path: string[]): void => {
    const name = [...path, command.name()].join(' ');
    if (command.commands.length === 0) {
      leaves.push({
        name,
        longFlags: command.options
          .map((option) => /--[a-z0-9-]+/.exec(option.flags)?.[0])
          .filter((flag): flag is string => flag !== undefined && flag !== '--help'),
      });
      return;
    }
    for (const sub of command.commands) walk(sub, [...path, command.name()]);
  };
  for (const command of createProgram().commands) walk(command, []);
  return leaves;
}

suite('documentation', () => {
  it('documents every option of every command somewhere', () => {
    const docs = [...readAllDocs().values()].join('\n');
    const undocumented: string[] = [];

    for (const leaf of leafCommands()) {
      for (const flag of leaf.longFlags) {
        if (!docs.includes(flag)) undocumented.push(`${leaf.name} ${flag}`);
      }
    }

    expect(undocumented).toEqual([]);
  });

  it('documents every MCP tool', () => {
    const mcp = readFileSync(join(DOCS, 'mcp.md'), 'utf8');
    const missing = TOOLS.map((tool) => tool.definition.name).filter(
      (name) => !mcp.includes(`\`${name}\``),
    );

    expect(missing).toEqual([]);
  });

  it('has no broken relative links', () => {
    const broken: string[] = [];

    for (const [path, text] of readAllDocs()) {
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = match[1] as string;
        if (/^(https?:|mailto:)/.test(target)) continue;
        const full = normalize(join(dirname(path), target));
        try {
          readFileSync(full);
        } catch {
          try {
            readdirSync(full);
          } catch {
            broken.push(`${path} -> ${target}`);
          }
        }
      }
    }

    expect(broken).toEqual([]);
  });

  it('links every page from the documentation index', () => {
    const index = readFileSync(join(DOCS, 'README.md'), 'utf8');
    const orphans = readdirSync(DOCS)
      .filter((name) => name.endsWith('.md') && name !== 'README.md')
      .filter((name) => !index.includes(name));

    expect(orphans).toEqual([]);
  });
});
