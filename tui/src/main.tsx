import { render } from 'ink';
import { createElement } from 'react';

import { App } from './app.js';
import { openStore } from './data.js';

const USAGE = `devcontext-tui — the devcontext viewer, in the terminal

Usage:
  devcontext tui [--config <path>] [--db <path>]

Keys:
  1-9 / tab      switch view
  arrow up/down  move the selection
  page up/down   move ten at a time
  enter          open the selected item
  /              filter the list
  esc            close the item, or clear the filter
  q              quit
`;

export function main(argv: string[]): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  const options = {
    config: valueOf(argv, '--config'),
    db: valueOf(argv, '--db'),
  };

  let store;
  try {
    store = openStore(options);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write('Run "devcontext sync" first, or point at a database with --db.\n');
    process.exitCode = 1;
    return;
  }

  /*
   * `exitOnCtrlC: false` because the app handles it: Ink's own handler tears
   * the process down without unwinding, which leaves the database handle open.
   */
  const instance = render(createElement(App, { store }), { exitOnCtrlC: false });
  void instance.waitUntilExit().then(() => {
    store.close();
  });
}

function valueOf(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
