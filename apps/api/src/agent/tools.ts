import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { sanitizeToolSchema } from '../llm/schema-sanitizer.js';
import { redact } from '../llm/errors.js';
import type { JsonSchemaObject, ToolDefinition } from '../llm/types.js';
export const CONTROL_FIELDS = new Set(['action', 'confirmation_token', 'idempotency_key']);
export function stripControls(args: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !CONTROL_FIELDS.has(key)));
}
export function agentTools(
  catalog: readonly Tool[],
): Map<string, { definition: ToolDefinition; kind: 'read' | 'write' }> {
  return new Map(
    catalog.map((tool) => {
      const kind = tool.annotations?.readOnlyHint === true ? 'read' : 'write';
      const schema = z
        .record(z.string(), z.json())
        .parse(structuredClone(tool.inputSchema)) as JsonSchemaObject;
      if (kind === 'write') {
        if (
          schema.properties &&
          typeof schema.properties === 'object' &&
          !Array.isArray(schema.properties)
        )
          for (const field of CONTROL_FIELDS) delete schema.properties[field];
        if (Array.isArray(schema.required))
          schema.required = schema.required.filter(
            (field) => typeof field === 'string' && !CONTROL_FIELDS.has(field),
          );
      }
      const description =
        kind === 'read'
          ? (tool.description ?? `Read ${tool.name}`)
          : `${(tool.description ?? tool.name).split('Call without')[0]} The host previews this request and asks the user for approval before executing. Supply only business arguments.`;
      return [
        tool.name,
        {
          kind,
          definition: {
            name: tool.name,
            description,
            parameters: sanitizeToolSchema(schema, 'openai'),
          },
        },
      ];
    }),
  );
}
export function cleanData(
  value: unknown,
  secrets: readonly string[] = [],
  redactString: (text: string) => string = (text) => text,
): unknown {
  if (typeof value === 'string')
    return redactString(redact(value, secrets))
      .split('')
      .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
      .join('');
  if (Array.isArray(value)) return value.map((item) => cleanData(item, secrets, redactString));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !CONTROL_FIELDS.has(key))
        .map(([key, child]) => [key, cleanData(child, secrets, redactString)]),
    );
  return value;
}
export function modelResult(
  result: CallToolResult,
  secrets: readonly string[] = [],
  redactString?: (text: string) => string,
): { text: string; summary: string; truncated: boolean; status: 'ok' | 'error' } {
  const value = cleanData(
    result.structuredContent ?? {
      content: result.content.filter((block) => block.type === 'text').map((block) => block.text),
    },
    secrets,
    redactString,
  );
  let text = JSON.stringify(value);
  const structured = result.structuredContent;
  let truncated = structured?.truncated === true;
  if (Buffer.byteLength(text) > 12 * 1024) {
    truncated = true;
    let end = Math.min(text.length, 12 * 1024);
    while (
      Buffer.byteLength(
        JSON.stringify({
          truncated: true,
          data: text.slice(0, end),
          hint: 'Narrow the query to inspect the full result',
        }),
      ) >
      12 * 1024
    )
      end = Math.floor(end * 0.9);
    text = JSON.stringify({
      truncated: true,
      data: text.slice(0, end),
      hint: 'Narrow the query to inspect the full result',
    });
  }
  const summary = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ');
  return {
    text,
    summary: String(cleanData(summary, secrets, redactString)).slice(0, 1000),
    truncated,
    status: result.isError ? 'error' : 'ok',
  };
}
