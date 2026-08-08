import { describe as suite, expect, it } from 'vitest';

import { createProgram } from './cli.js';

function commandNames(): string[] {
  return createProgram().commands.map((command) => command.name());
}

function find(name: string) {
  return createProgram().commands.find(
    (command) => command.name() === name || command.aliases().includes(name),
  );
}

/** The default commander would apply for `--state` on a `gh` subcommand. */
function stateDefault(sub: string): unknown {
  const github = find('gh');
  const command = github?.commands.find((entry) => entry.name() === sub);
  return command?.options.find((option) => option.long === '--state')?.defaultValue;
}

suite('every list shows every state by default', () => {
  /*
   * The three surfaces used to disagree: pull requests showed all states while
   * issues showed only open ones, and the MCP tools showed open for both. A
   * closed issue and a merged pull request are the normal end of each, so a
   * list that hides them reads as if nothing was ever finished — and an
   * assistant asked "what did we ship" answers confidently from the gap.
   */
  it('defaults gh issues and gh prs to all', () => {
    expect(stateDefault('issues')).toBe('all');
    expect(stateDefault('prs')).toBe('all');
  });
});

suite('the command surface', () => {
  it('registers every command', () => {
    expect(commandNames().toSorted()).toEqual([
      'activity',
      'agent',
      'audit',
      'contributors',
      'digest',
      'export',
      'github',
      'history',
      'init',
      'insights',
      'jira',
      'links',
      'mcp',
      'people',
      'search',
      'serve',
      'status',
      'sync',
      'teams',
      'tickets',
    ]);
  });

  it('serves the viewer under its new name', () => {
    expect(find('serve')?.name()).toBe('serve');
  });

  it('keeps "web" working as an alias', () => {
    // The rename must not break a script somebody already wrote.
    expect(find('web')?.name()).toBe('serve');
  });

  it('keeps the aliases the documentation promises', () => {
    const aliases: Array<[string, string[]]> = [
      ['github', ['gh']],
      ['search', ['find', 'q']],
      ['insights', ['report', 'stats']],
      ['digest', ['standup', 'summary']],
      ['links', ['link']],
      ['serve', ['web']],
    ];

    for (const [name, expected] of aliases) {
      const command = createProgram().commands.find((entry) => entry.name() === name);
      expect(command?.aliases(), `aliases of ${name}`).toEqual(expect.arrayContaining(expected));
    }
  });
});
