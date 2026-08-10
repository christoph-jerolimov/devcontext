import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handlers } from '../api/capabilities.js';
import type { ApiContext } from '../api/capabilities.js';
import { decodeQuery, inputSchema, matchRoute, routes } from '../api/routes.js';
import type { CapabilityName, InputOf } from '../api/routes.js';
import type { ResolvedConfig } from '../config/types.js';
import { Database } from '../db/database.js';
import { SyncJournal } from '../db/journal.js';
import { Directory } from '../people/directory.js';
import { CliError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface WebServerOptions {
  config: ResolvedConfig;
  logger: Logger;
  port: number;
  host: string;
  databasePath: string;
}

/** Finds the built React app that `devcontext web` serves. */
export function findWebAssets(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../web/dist'), // monorepo: cli/{src,dist}/web -> web/dist
    resolve(here, '../../web/dist'),
    resolve(here, '../web'),
    resolve(here, '../../node_modules/@devcontext/web/dist'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? null;
}

export function startWebServer(options: WebServerOptions): Promise<Server> {
  const { config, logger } = options;
  const assets = findWebAssets();

  if (!assets) {
    logger.warn(
      'The web viewer has not been built yet; only the JSON API under /api is available. ' +
        'Run "npm run build:web" in the repository root.',
    );
  }

  const db = Database.open(options.databasePath, { create: false, readOnly: true });
  const journal = new SyncJournal(db);

  const server = createServer((request, response) => {
    handleRequest(request, response, { db, journal, config, assets, logger }).catch((error) => {
      logger.error(`Request failed: ${(error as Error).message}`);
      sendJson(response, 500, { error: (error as Error).message });
    });
  });

  server.on('close', () => db.close());

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolvePromise(server));
  });
}

interface RequestContext {
  db: Database;
  journal: SyncJournal;
  config: ResolvedConfig;
  assets: string | null;
  logger: Logger;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  ctx.logger.debug(`${request.method} ${url.pathname}${url.search}`);

  if (url.pathname.startsWith('/api/')) {
    const payload = handleApi(url, ctx);
    if (payload === undefined) {
      sendJson(response, 404, { error: `Unknown endpoint ${url.pathname}` });
      return;
    }
    sendJson(response, 200, payload);
    return;
  }

  if (!ctx.assets) {
    sendJson(response, 404, {
      error: 'The web viewer is not built. Run "npm run build:web" in the repository root.',
    });
    return;
  }

  serveStatic(url.pathname, response, ctx.assets);
}

/**
 * Resolves a request against the capability table: match the path, decode the
 * declared query parameters, validate through the derived schema, run the
 * handler. What used to be a hand-written chain of ifs is now three lookups,
 * and adding an endpoint means adding a table row and a handler — the
 * compiler refuses one without the other.
 */
export function handleApi(url: URL, ctx: Omit<RequestContext, 'assets' | 'logger'>): unknown {
  // Split first, then decode: a segment may legitimately contain an encoded
  // slash, and decoding earlier would split it into two. This matters for
  // /api/links/:ref, where a GitHub reference arrives as acme/platform%2342 —
  // left encoded, the `#` never reappears and the whole thing gets uppercased
  // as if it were a Jira key.
  const segments = url.pathname
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeSegment);

  const match = matchRoute(segments);
  if (!match) return undefined;

  // Path parameters win over query parameters of the same name; the schema is
  // derived from the same table the decoder reads, so a mismatch here is a
  // programming error surfacing as a 500, never a silently wrong shape.
  const raw = { ...decodeQuery(routes[match.name], url.searchParams), ...match.params };
  const input = inputSchema(match.name).parse(raw);

  const api: ApiContext = {
    db: ctx.db,
    journal: ctx.journal,
    config: ctx.config,
    directory: Directory.from(ctx.config),
  };
  return dispatch(match.name, api, input);
}

function dispatch<K extends CapabilityName>(name: K, ctx: ApiContext, input: unknown): unknown {
  const handler = handlers[name] as (
    ctx: ApiContext,
    input: InputOf<(typeof routes)[K]>,
  ) => unknown;
  return handler(ctx, input as InputOf<(typeof routes)[K]>);
}

function serveStatic(pathname: string, response: ServerResponse, assets: string): void {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(assets, relative);

  if (!filePath.startsWith(assets)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // Single page app: unknown routes fall back to index.html.
    filePath = join(assets, 'index.html');
  }

  response.writeHead(200, {
    'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(filePath).pipe(response);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload ?? null, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * Percent-decodes one path segment, leaving it as it came if it cannot be
 * decoded. A malformed escape like `%zz` is somebody's typo, and it should
 * reach a 404 rather than a 500.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function ensureDatabase(path: string): void {
  if (!existsSync(path)) {
    throw new CliError(`No devcontext database at ${path}.`, {
      hint: 'Run "devcontext sync" first.',
    });
  }
}
