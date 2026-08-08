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

suite('the command surface', () => {
  it('registers every command', () => {
    expect(commandNames().toSorted()).toEqual([
      'agent',
      'audit',
      'digest',
      'export',
      'github',
      'history',
      'init',
      'insights',
      'jira',
      'links',
      'mcp',
      'search',
      'serve',
      'status',
      'sync',
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
