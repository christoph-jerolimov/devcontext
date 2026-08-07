import { createInterface } from 'node:readline';

import type { ResolvedConfig } from '../config/types.js';
import type { Database } from '../db/database.js';
import { VERSION } from '../version.js';
import type { Logger } from '../util/logger.js';
import {
  ERROR_CODES,
  JSONRPC_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  errorResult,
  failure,
  success,
  textResult,
} from './protocol.js';
import type { JsonRpcRequest, JsonRpcResponse } from './protocol.js';
import { TOOLS, TOOLS_BY_NAME, isArgumentError } from './tools.js';
import type { ToolContext } from './tools.js';

export interface McpServerOptions {
  db: Database;
  config: ResolvedConfig;
  logger: Logger;
}

/**
 * Handles MCP requests. Transport agnostic on purpose: `handle()` takes one
 * parsed message and returns the response (or null for notifications), which is
 * what makes the protocol testable without spawning a process.
 */
export class McpServer {
  private readonly ctx: ToolContext;
  private initialized = false;

  constructor(private readonly options: McpServerOptions) {
    this.ctx = { db: options.db, config: options.config };
  }

  handle(message: JsonRpcRequest): JsonRpcResponse | null {
    const id = message.id ?? null;
    const isNotification = message.id === undefined;

    if (message.jsonrpc !== JSONRPC_VERSION) {
      return isNotification
        ? null
        : failure(id, ERROR_CODES.invalidRequest, 'Expected jsonrpc "2.0".');
    }

    switch (message.method) {
      case 'initialize':
        return isNotification ? null : success(id, this.initialize(message.params));

      case 'notifications/initialized':
      case 'initialized':
        this.initialized = true;
        return null;

      case 'ping':
        return isNotification ? null : success(id, {});

      case 'tools/list':
        return isNotification ? null : success(id, { tools: TOOLS.map((tool) => tool.definition) });

      case 'tools/call':
        return isNotification ? null : success(id, this.callTool(message.params));

      // Declared as unsupported in the capabilities, but clients still ask.
      case 'resources/list':
        return isNotification ? null : success(id, { resources: [] });
      case 'prompts/list':
        return isNotification ? null : success(id, { prompts: [] });

      default:
        return isNotification
          ? null
          : failure(id, ERROR_CODES.methodNotFound, `Unknown method "${message.method}".`);
    }
  }

  private initialize(params: Record<string, unknown> | undefined): unknown {
    const requested =
      typeof params?.['protocolVersion'] === 'string'
        ? (params['protocolVersion'] as string)
        : PROTOCOL_VERSION;

    return {
      // Echo the client's revision when we know it, otherwise offer ours.
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'devcontext', version: VERSION },
      instructions:
        'Local mirror of GitHub and Jira for this project. Everything is read only and answered ' +
        'from a local SQLite database, so calls are cheap and there is no rate limit. Start with ' +
        'devcontext_status to see which repositories and Jira projects are available and how ' +
        'fresh the data is, use search to find things, then get_issue / get_pull_request / ' +
        'get_workitem for the complete history of one item.',
    };
  }

  private callTool(params: Record<string, unknown> | undefined): unknown {
    const name = typeof params?.['name'] === 'string' ? (params['name'] as string) : '';
    const args =
      params?.['arguments'] && typeof params['arguments'] === 'object'
        ? (params['arguments'] as Record<string, unknown>)
        : {};

    const tool = TOOLS_BY_NAME.get(name);
    if (!tool) {
      return errorResult(
        `Unknown tool "${name}". Available: ${[...TOOLS_BY_NAME.keys()].join(', ')}.`,
      );
    }

    try {
      return textResult(tool.run(args, this.ctx));
    } catch (error) {
      // Tool failures are reported inside the result, not as protocol errors,
      // so the model can read them and correct itself.
      if (isArgumentError(error)) return errorResult(error.message);
      this.options.logger.error(`Tool "${name}" failed: ${(error as Error).message}`);
      return errorResult(`Tool "${name}" failed: ${(error as Error).message}`);
    }
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * Runs the server on stdio: newline delimited JSON in, newline delimited JSON
 * out. Nothing but protocol messages may go to stdout, which is why the CLI
 * sends every log line to stderr.
 */
export function serveStdio(options: McpServerOptions): Promise<void> {
  const server = new McpServer(options);
  const input = createInterface({ input: process.stdin });

  return new Promise((resolve) => {
    input.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed === '') return;

      let message: JsonRpcRequest;
      try {
        message = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        write(failure(null, ERROR_CODES.parseError, 'Invalid JSON.'));
        return;
      }

      try {
        const response = server.handle(message);
        if (response) write(response);
      } catch (error) {
        options.logger.error(`MCP request failed: ${(error as Error).message}`);
        write(failure(message.id ?? null, ERROR_CODES.internalError, (error as Error).message));
      }
    });

    input.on('close', () => resolve());
  });
}

function write(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
