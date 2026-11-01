import { performance } from 'node:perf_hooks';
import type { Services } from '@foodops/core';
import { AppError, ErrorCode } from '@foodops/shared';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { asAppError, mapToolError } from './error-mapper.js';
import type { ConfirmationGate } from './confirmation.js';
import { logToolCall } from './tool-log.js';

export const TOOL_TIMEOUT_MS = 5000;
export const MAX_RESULT_BYTES = 20 * 1024;
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
export interface ToolDependencies {
  services: Services;
  confirmation: ConfirmationGate;
  logger: Logger;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  run: (args: unknown, extra: ToolExtra, dependencies: ToolDependencies) => Promise<CallToolResult>;
}
export function resultBytes(result: CallToolResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}
function timeoutError(): AppError {
  return new AppError(
    ErrorCode.LIMIT_EXCEEDED,
    'Tool exceeded the 5 second deadline',
    'Narrow the filters or reduce the page limit and retry',
  );
}
function cancelledError(): AppError {
  return new AppError(
    ErrorCode.CONFLICT,
    'Tool call was cancelled',
    'Submit a new request when needed',
  );
}

/** Input/output schemas are shared by discovery and the audited tools/call dispatcher. */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(spec: {
  name: string;
  description: string;
  inputSchema: I;
  dataSchema: O;
  hint: string;
  annotations?: ToolAnnotations;
  execute: (
    input: z.output<I>,
    services: Services,
    signal: AbortSignal,
    confirmation: ConfirmationGate,
  ) => unknown | Promise<unknown>;
  summarize: (data: z.output<O>) => string;
}): ToolDefinition {
  const payloadSchema: z.ZodType = spec.dataSchema;
  const outputSchema = z
    .strictObject({
      data: payloadSchema.nullable(),
      truncated: z.boolean(),
      hint: z.string().min(1).optional(),
    })
    .superRefine((value, context) => {
      if (
        value.truncated
          ? value.data !== null || !value.hint
          : value.data === null || value.hint !== undefined
      )
        context.addIssue({ code: 'custom', message: 'Invalid result envelope' });
    });
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    outputSchema,
    annotations: spec.annotations ?? {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async run(args, extra, dependencies) {
      const readOnly = spec.annotations?.readOnlyHint !== false;
      const start = performance.now();
      const deadline = start + TOOL_TIMEOUT_MS;
      let errorCode: ErrorCode | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      let cancel: (() => void) | undefined;
      let result: CallToolResult;
      try {
        const work = async (): Promise<CallToolResult> => {
          if (extra.signal.aborted) throw cancelledError();
          const parsed = spec.inputSchema.safeParse(args ?? {});
          if (!parsed.success)
            throw new AppError(
              ErrorCode.VALIDATION,
              'Invalid tool arguments',
              'Use only the documented fields, types, date ranges, and pagination limits',
            );
          const value = await spec.execute(
            parsed.data,
            dependencies.services,
            controller.signal,
            dependencies.confirmation,
          );
          if (readOnly && performance.now() >= deadline) throw timeoutError();
          if (readOnly && controller.signal.aborted) throw cancelledError();
          const output = spec.dataSchema.safeParse(value);
          if (!output.success) throw new Error('Service response does not match the tool schema');
          let response: CallToolResult = {
            content: [{ type: 'text', text: spec.summarize(output.data) }],
            structuredContent: { data: output.data, truncated: false },
          };
          if (resultBytes(response) > MAX_RESULT_BYTES)
            response = {
              content: [
                {
                  type: 'text',
                  text: `Result truncated. ${spec.hint}`,
                },
              ],
              structuredContent: { data: null, truncated: true, hint: spec.hint },
            };
          outputSchema.parse(response.structuredContent);
          if (readOnly && performance.now() >= deadline) throw timeoutError();
          return response;
        };
        result = readOnly
          ? await Promise.race([
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(timeoutError());
                }, TOOL_TIMEOUT_MS);
                cancel = () => {
                  controller.abort();
                  reject(cancelledError());
                };
                extra.signal.addEventListener('abort', cancel, { once: true });
              }),
              work(),
            ])
          : await work();
      } catch (error) {
        const failure = asAppError(error);
        errorCode = failure.code;
        result = mapToolError(failure);
        if (resultBytes(result) > MAX_RESULT_BYTES)
          result = mapToolError(
            new AppError(
              failure.code,
              'Tool failed; error details exceeded the result limit',
              'Narrow the request and retry',
            ),
          );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (cancel) extra.signal.removeEventListener('abort', cancel);
      }
      try {
        logToolCall(dependencies.services.audit, {
          tool: spec.name,
          args,
          errorCode,
          latencyMs: performance.now() - start,
          ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
        });
      } catch {
        dependencies.logger.error({ tool: spec.name }, 'Tool audit persistence failed');
      }
      if (!readOnly && performance.now() >= deadline)
        dependencies.logger.warn(
          { tool: spec.name },
          'Write exceeded tool deadline; preserving operation result',
        );
      dependencies.logger.info(
        {
          tool: spec.name,
          status: errorCode === null ? 'success' : 'error',
          error_code: errorCode,
          latency_ms: Math.round(performance.now() - start),
        },
        'Tool call completed',
      );
      return result;
    },
  };
}
