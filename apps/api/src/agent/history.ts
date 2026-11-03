import type { NormalizedMessage, ToolDefinition } from '../llm/types.js';
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
/** Keep complete user-led turns so assistant calls never lose their tool-result partners. */
export function boundHistory(history: readonly NormalizedMessage[], max = 40): NormalizedMessage[] {
  const result = structuredClone([...history]);
  while (result.length > max) {
    const next = result.findIndex((message, index) => index > 0 && message.role === 'user');
    if (next < 0) {
      const user = result.find((message) => message.role === 'user');
      const last = result[result.length - 1];
      return [
        ...(user ? [user] : []),
        {
          role: 'assistant',
          content: `[trimmed] Earlier tool activity omitted. ${last?.role === 'assistant' ? last.content : 'Inspect current state before continuing.'}`,
        },
      ];
    }
    result.splice(0, next);
  }
  return result;
}
export function trimHistory(
  system: string,
  history: readonly NormalizedMessage[],
  user: string,
  tools: readonly ToolDefinition[],
  budget: number,
): NormalizedMessage[] {
  const previous = structuredClone([...history]);
  const make = (): NormalizedMessage[] => [
    { role: 'system', content: system },
    ...previous,
    { role: 'user', content: user },
  ];
  const size = () => estimateTokens({ messages: make(), tools });
  for (const message of previous) {
    if (size() <= budget) break;
    if (message.role === 'tool' && message.content.length > 9) message.content = '[trimmed]';
  }
  while (size() > budget && previous.length) {
    const next = previous.findIndex((message, index) => index > 0 && message.role === 'user');
    previous.splice(0, next < 0 ? previous.length : next);
  }
  if (size() > budget)
    throw new Error('System prompt, tools and latest user turn exceed the context budget');
  return make();
}
export function trimMessages(
  messages: readonly NormalizedMessage[],
  tools: readonly ToolDefinition[],
  budget: number,
): NormalizedMessage[] {
  const result = structuredClone([...messages]);
  const fits = () => estimateTokens({ messages: result, tools }) <= budget;
  for (const message of result) {
    if (fits()) break;
    if (message.role === 'tool' && message.content.length > 9) message.content = '[trimmed]';
  }
  let latestUser = result.reduce(
    (last, message, index) => (message.role === 'user' ? index : last),
    -1,
  );
  while (!fits() && latestUser > 1) {
    const next = result.findIndex((message, index) => index > 1 && message.role === 'user');
    const end = next < 0 ? latestUser : Math.min(next, latestUser);
    result.splice(1, end - 1);
    latestUser = result.reduce(
      (last, message, index) => (message.role === 'user' ? index : last),
      -1,
    );
  }
  if (!fits()) throw new Error('Current turn exceeds the context budget');
  return result;
}
