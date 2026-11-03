export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface JsonSchemaObject {
  [key: string]: JsonValue;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export type NormalizedMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string };
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}
export interface ChatOptions {
  /** Lower the configured retry budget; probes use zero. */
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number;
  numCtx?: number;
  think?: boolean;
  signal?: AbortSignal;
}
export type StreamEvent =
  | { type: 'text_delta' | 'thinking_delta'; delta: string }
  | ({ type: 'tool_call' } & ToolCall)
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'done'; reason: string };
export interface ModelInfo {
  name: string;
  sizeBytes?: number;
}
export interface LLMProvider {
  readonly id: string;
  readonly capabilities: { toolCalling: boolean; streaming: boolean; thinking: boolean };
  chat(
    messages: readonly NormalizedMessage[],
    tools: readonly ToolDefinition[],
    options?: ChatOptions,
  ): AsyncIterable<StreamEvent>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}
