import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AppError, ErrorCode } from '@foodops/shared';
import { mapProtocolError } from '../lib/error-mapper.js';
import { prompt as triage } from './order-triage.js';
import { prompt as refund } from './refund-review.js';
import { prompt as report } from './daily-ops-report.js';

export const prompts = [triage, refund, report];
export function registerPrompts(server: McpServer): void {
  for (const prompt of prompts)
    server.registerPrompt(
      prompt.name,
      { description: prompt.description, argsSchema: prompt.inputSchema.shape },
      (args) => prompt.render(args),
    );
  // SDK raw-shape normalization strips unknown fields. Validate the original
  // arguments with the same strict definitions through the public protocol API.
  server.server.setRequestHandler(GetPromptRequestSchema, (request) => {
    try {
      const prompt = prompts.find((item) => item.name === request.params.name);
      if (!prompt)
        throw new AppError(
          ErrorCode.NOT_FOUND,
          'Prompt was not found',
          'Use prompts/list to discover available prompts',
        );
      return prompt.render(request.params.arguments);
    } catch (error) {
      throw mapProtocolError(error);
    }
  });
}
