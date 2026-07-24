import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodType, ZodTypeDef, ZodError } from 'zod';
import { ToolError } from '../lib/errors.js';

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export interface ToolSpec<Input> {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  input: ZodType<Input, ZodTypeDef, unknown>;
  handler: (input: Input) => Promise<CallToolResult>;
}

export interface RegisteredTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  invoke: (rawArgs: unknown) => Promise<CallToolResult>;
}

export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

export function defineTool<Input>(spec: ToolSpec<Input>): RegisteredTool {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    invoke: async (rawArgs: unknown): Promise<CallToolResult> => {
      const parsed = spec.input.safeParse(rawArgs ?? {});

      if (!parsed.success) {
        throw new ToolError(
          'INVALID_INPUT',
          `Invalid arguments for ${spec.name}: ${formatZodError(parsed.error)}`,
          `Expected properties: ${Object.keys(spec.inputSchema.properties).join(', ')}.`
        );
      }

      return spec.handler(parsed.data);
    }
  };
}

export const packageNameSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 214,
  description: 'npm package name, e.g. "lodash" or "@scope/name".'

} as const;

export const versionSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: 'Exact version ("1.2.3") or dist-tag ("latest", "next"). Defaults to "latest".'

} as const;
