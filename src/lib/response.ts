/**
 * Tool result shaping.
 *
 * Every tool returns a single text block containing a short human-readable
 * verdict followed by the full structured JSON. Leading with the verdict means
 * a model can answer simple questions without parsing anything, while the JSON
 * keeps the precise numbers available for follow-up reasoning.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describeError } from './errors.js';

/** JSON pretty-printing is capped so one huge tree cannot flood the context. */
const MAX_JSON_CHARS = 120_000;

export function toolText(summary: string, data: unknown, notes: readonly string[] = []): CallToolResult {
  let json = JSON.stringify(data, null, 2);
  let truncatedNote: string | null = null;

  if (json.length > MAX_JSON_CHARS) {
    json = `${json.slice(0, MAX_JSON_CHARS)}\n… (JSON truncated at ${MAX_JSON_CHARS} characters)`;
    truncatedNote = 'The structured JSON was truncated; narrow the request (lower depth or limit) for full data.';
  }

  const noteBlock = [...notes, ...(truncatedNote ? [truncatedNote] : [])];
  const sections = [
    summary.trim(),
    noteBlock.length > 0 ? `Notes:\n${noteBlock.map((note) => `- ${note}`).join('\n')}` : '',
    `\`\`\`json\n${json}\n\`\`\``,
  ].filter((section) => section.length > 0);

  return { content: [{ type: 'text', text: sections.join('\n\n') }] };
}

/** Formats a thrown value as an `isError` result the model can act on. */
export function toolError(err: unknown, toolName: string): CallToolResult {
  const { code, message, hint } = describeError(err);
  const text = [`${toolName} failed (${code}): ${message}`, hint].filter(Boolean).join('\n');
  return { content: [{ type: 'text', text }], isError: true };
}
