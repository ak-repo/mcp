import { redact } from '../llm/errors.js';
/** Deliberately omit arbitrary error messages, causes, stacks, and enumerable payloads. */
export function safeChatError(error: unknown, scrub: (text: string) => string) {
  // Match only application-owned error categories; never serialize the original object.
  const name = error instanceof Error ? error.name : '';
  const type = ['AbortError', 'McpClientError', 'LLMError', 'AgentFailure'].includes(name)
    ? name
    : 'Error';
  return { type, message: scrub(redact('Chat operation failed; original error payload omitted')) };
}
