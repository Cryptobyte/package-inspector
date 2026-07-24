#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema, 
  type CallToolResult 

} from '@modelcontextprotocol/sdk/types.js';

import { ALLOWED_HOSTS } from './lib/http.js';
import { ToolError } from './lib/errors.js';
import { toolError } from './lib/response.js';
import { SERVER_NAME, SERVER_VERSION } from './lib/version.js';
import { TOOLS, TOOLS_BY_NAME } from './tools/index.js';

function log(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

const INSTRUCTIONS = `Inspect npm packages: metadata, versions, dependency trees, known vulnerabilities, size, supply-chain risk and download trends.

All data comes from public, unauthenticated APIs (${ALLOWED_HOSTS.join(', ')}). No credentials are used or stored, and nothing about the user is transmitted — only the package names being looked up.

Guidance:
- Version arguments accept an exact version ("1.2.3") or a dist-tag ("latest", "next"), and default to "latest".
- Prefer inspect_package for general questions, then a specific tool for depth.
- Registry lookups are cached in memory for 5 minutes, so repeated calls are cheap.
- Results describe published metadata. They cannot detect malicious code, only the signals around it.`;

export function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        title: tool.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: rawArgs } = request.params;
    const tool = TOOLS_BY_NAME.get(name);

    if (!tool) {
      const known = [...TOOLS_BY_NAME.keys()].join(', ');

      return toolError(new ToolError('INVALID_INPUT', `Unknown tool "${name}". Available tools: ${known}.`), name);
    }

    try {
      return await tool.invoke(rawArgs);

    } catch (err) {
      if (err instanceof ToolError) {
        log(`${name} → ${err.code}: ${err.message}`);

      } else {
        log(`${name} failed unexpectedly: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }

      return toolError(err, name);
    }
  });

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  log(`v${SERVER_VERSION} ready on stdio — ${TOOLS.length} tools, outbound hosts: ${ALLOWED_HOSTS.join(', ')}`);

  const shutdown = (signal: string): void => {
    log(`received ${signal}, shutting down.`);

    void server.close().finally(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error.stack ?? error.message}`);
});

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);

  process.exit(1);
});
