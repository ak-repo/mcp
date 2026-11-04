import type { NormalizedMessage, ToolDefinition } from '../llm/types.js';
const UNKNOWN_PREFIX = 'Unresolved write outcomes: ';
const UNKNOWN_NOTE = 'The write may have committed; inspect current state before any new write.';
export function unresolvedNotes(history: readonly NormalizedMessage[]): string[] {
  const notes = new Set<string>();
  const safeId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  for (const message of history) {
    if (message.role === 'assistant')
      for (const line of message.content.split('\n')) {
        if (!line.startsWith(UNKNOWN_PREFIX)) continue;
        try {
          const data = JSON.parse(line.slice(UNKNOWN_PREFIX.length)) as Record<string, unknown>;
          if (
            Object.keys(data).sort().join(',') === 'call_id,note,status,tool_name' &&
            data.status === 'unknown_outcome' &&
            data.note === UNKNOWN_NOTE &&
            typeof data.call_id === 'string' &&
            typeof data.tool_name === 'string'
          )
            notes.add(
              UNKNOWN_PREFIX +
                JSON.stringify({
                  status: 'unknown_outcome',
                  note: UNKNOWN_NOTE,
                  tool_name: safeId(data.tool_name),
                  call_id: safeId(data.call_id),
                }),
            );
        } catch {
          /* Only host-format uncertainty records can be retained as safety context. */
        }
      }
    if (message.role === 'tool') {
      try {
        const data = JSON.parse(message.content) as { status?: string; note?: string };
        if (data.status === 'unknown_outcome' && data.note === UNKNOWN_NOTE)
          notes.add(
            UNKNOWN_PREFIX +
              JSON.stringify({
                status: 'unknown_outcome',
                note: UNKNOWN_NOTE,
                tool_name: safeId(message.toolName),
                call_id: safeId(message.toolCallId),
              }),
          );
      } catch {
        /* Ordinary text tool result. */
      }
    }
  }
  return [...notes];
}
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
/** Keep complete user-led turns so assistant calls never lose their tool-result partners. */
export function boundHistory(history: readonly NormalizedMessage[], max = 40): NormalizedMessage[] {
  const notes = unresolvedNotes(history);
  const result = structuredClone([...history]);
  while (result.length > max) {
    const next = result.findIndex((message, index) => index > 0 && message.role === 'user');
    if (next < 0) {
      const user = result.find((message) => message.role === 'user');
      const last = result[result.length - 1];
      return [
        ...(user ? [user] : []),
        ...(notes.length ? [{ role: 'assistant' as const, content: notes.join('\n') }] : []),
        {
          role: 'assistant',
          content: `[trimmed] Earlier tool activity omitted. ${last?.role === 'assistant' ? last.content : 'Inspect current state before continuing.'}`,
        },
      ];
    }
    result.splice(0, next);
  }
  const present = new Set(unresolvedNotes(result));
  const missing = notes.filter((note) => !present.has(note));
  if (missing.length) result.push({ role: 'assistant', content: missing.join('\n') });
  if (result.length > max) return boundHistory(result, max);
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
  const safety = unresolvedNotes(history).join('\n');
  const make = (): NormalizedMessage[] => [
    { role: 'system', content: safety ? `${system}\n${safety}` : system },
    ...previous,
    { role: 'user', content: user },
  ];
  const size = () => estimateTokens({ messages: make(), tools });
  for (const message of previous) {
    if (size() <= budget) break;
    if (
      message.role === 'tool' &&
      !message.content.includes('unknown_outcome') &&
      message.content.length > 9
    )
      message.content = '[trimmed]';
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
  const safety = unresolvedNotes(messages)
    .filter((note) => !result[0]?.content.includes(note))
    .join('\n');
  if (safety && result[0]?.role === 'system') result[0].content += `\n${safety}`;
  const fits = () => estimateTokens({ messages: result, tools }) <= budget;
  for (const message of result) {
    if (fits()) break;
    if (
      message.role === 'tool' &&
      !message.content.includes('unknown_outcome') &&
      message.content.length > 9
    )
      message.content = '[trimmed]';
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
