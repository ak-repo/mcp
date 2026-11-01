import { McpError, ErrorCode as ProtocolErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { AppError, ErrorCode } from '@foodops/shared';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function asAppError(error: unknown): AppError {
  return error instanceof AppError
    ? error
    : new AppError(
        ErrorCode.INTERNAL,
        'The tool could not be completed',
        'Retry the request or contact the operator',
      );
}
export function mapToolError(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: asAppError(error).toToolText() }] };
}

/** Resources and prompts report protocol errors rather than tool-result errors. */
export function mapProtocolError(error: unknown): McpError {
  const failure = asAppError(error);
  return new McpError(
    failure.code === ErrorCode.INTERNAL
      ? ProtocolErrorCode.InternalError
      : ProtocolErrorCode.InvalidParams,
    failure.toToolText(),
  );
}
