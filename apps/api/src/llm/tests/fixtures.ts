export const final = { done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 7 };
const call = (name: string, argumentsValue: Record<string, unknown>, index?: number) => ({
  function: { name, arguments: argumentsValue, ...(index === undefined ? {} : { index }) },
});
export const fixtures = {
  text: [
    { message: { content: 'Hello ' }, done: false },
    { message: { content: '₹' }, done: false },
    final,
  ],
  thinking: [
    { message: { thinking: 'Consider ' }, done: false },
    { message: { thinking: 'carefully', content: 'Answer' }, done: false },
    final,
  ],
  single: [{ message: { tool_calls: [call('lookup', { id: 'O-1' })] } }, final],
  multiple: [
    {
      message: { tool_calls: [call('lookup', { id: 'O-1' }, 0), call('lookup', { id: 'O-2' }, 1)] },
    },
    final,
  ],
  acrossRecords: [
    { message: { tool_calls: [call('lookup', { id: 'O-1' }, 0)] } },
    { message: { tool_calls: [call('lookup', { id: 'O-2' }, 1)] } },
    final,
  ],
  fragments: [
    { message: { tool_calls: [{ function: { index: 0, name: 'lookup', arguments: '{"id":' } }] } },
    { message: { tool_calls: [{ function: { index: 0, arguments: '"O-1"}' } }] } },
    final,
  ],
  midstreamError: [{ message: { content: 'Partial' } }, { error: 'provider-secret' }],
};
export function ndjson(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}
