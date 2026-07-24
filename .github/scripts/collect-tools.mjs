#!/usr/bin/env node
/**
 * Collects the declared tool surface by asking the built server for it.
 *
 * MCP Commons requires a `tools` array on every version publish, and the
 * security review checks that declaration against the code. A hand-maintained
 * list is therefore a latent review failure: it is correct exactly until
 * someone adds, renames, or removes a tool.
 *
 * So this does not read a list from anywhere — it boots the *actual* entrypoint
 * the manifest points at, performs the MCP handshake over stdio, and reports
 * what `tools/list` returns. Two things fall out of that:
 *
 *   1. The declaration cannot drift from the implementation.
 *   2. It proves the manifest entrypoint boots. A non-bootable entrypoint is
 *      precisely what produced an empty tool surface once already.
 *
 * Usage:  node .github/scripts/collect-tools.mjs [outfile]
 *         (defaults to writing tools.json in the current directory)
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const BOOT_TIMEOUT_MS = 30_000;
const outFile = process.argv[2] ?? 'tools.json';

/** The entrypoint the marketplace is told to run, so we exercise the real one. */
function entrypoint() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const declared = pkg['mcp-commons']?.run;
  if (!declared) {
    console.error('::error::package.json has no "mcp-commons".run entrypoint.');
    process.exit(1);
  }
  if (declared.endsWith('.ts')) {
    console.error(
      `::error::The manifest entrypoint "${declared}" is TypeScript source, which Node cannot run directly ` +
        '(its .js import specifiers only resolve after compilation). Point "mcp-commons".run at the build output.',
    );
    process.exit(1);
  }
  return declared;
}

const server = entrypoint();
console.log(`Booting ${server} to enumerate its tool surface…`);

const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

const timer = setTimeout(() => {
  child.kill('SIGKILL');
  console.error(`::error::${server} did not answer tools/list within ${BOOT_TIMEOUT_MS}ms.`);
  if (stderr.trim()) console.error(stderr.trim());
  process.exit(1);
}, BOOT_TIMEOUT_MS);

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'collect-tools', version: '1.0.0' },
  },
});

let finished = false;

createInterface({ input: child.stdout }).on('line', (line) => {
  if (finished || line.trim() === '') return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // Not a protocol frame; ignore.
  }

  if (message.id === 1 && message.result) {
    // Complete the handshake before asking for anything.
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    return;
  }

  if (message.id !== 2) return;
  finished = true;
  clearTimeout(timer);
  child.kill('SIGTERM');

  if (message.error) {
    console.error(`::error::tools/list failed: ${message.error.message ?? JSON.stringify(message.error)}`);
    process.exit(1);
  }

  const listed = message.result?.tools;
  if (!Array.isArray(listed) || listed.length === 0) {
    console.error('::error::The server reported an empty tool surface. Refusing to publish a listing with no tools.');
    if (stderr.trim()) console.error(stderr.trim());
    process.exit(1);
  }

  // The API wants name + description. Title is not part of its schema.
  const tools = listed.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
  }));

  const missing = tools.filter((tool) => !tool.name || !tool.description);
  if (missing.length > 0) {
    console.error(`::error::Every tool needs a name and description; missing on ${missing.length}.`);
    process.exit(1);
  }

  writeFileSync(outFile, `${JSON.stringify(tools, null, 2)}\n`);
  console.log(`Collected ${tools.length} tools -> ${outFile}`);
  for (const tool of tools) console.log(`  - ${tool.name}`);
  process.exit(0);
});

child.on('exit', (code) => {
  if (finished) return;
  clearTimeout(timer);
  console.error(`::error::${server} exited (code ${code}) before reporting its tools.`);
  if (stderr.trim()) console.error(stderr.trim());
  process.exit(1);
});
