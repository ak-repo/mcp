import type { AgentEvent, ApprovalDecision } from '@foodops/shared';

export type RunState = 'idle' | 'streaming' | 'awaiting_approval' | 'completed' | 'error' | 'cancelled';
export type ToolView = {
  callId: string;
  name: string;
  kind: 'read' | 'write';
  arguments: Record<string, unknown>;
  status: 'running' | 'ok' | 'error' | 'awaiting_approval' | 'rejected';
  latencyMs?: number;
  summary?: string;
  truncated?: boolean;
};
export type ApprovalView = Extract<AgentEvent, { type: 'approval.required' }> & {
  resolved: ApprovalDecision | undefined;
};
export type RunModel = {
  state: RunState;
  runId?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  text: string;
  thinking: string;
  tools: Record<string, ToolView>;
  approval?: ApprovalView;
  approvedWrite: boolean;
  error?: { kind: string; message: string; retryable: boolean };
};
export const initialRun: RunModel = {
  state: 'idle', text: '', thinking: '', tools: {}, approvedWrite: false,
};

export type Action =
  | { type: 'send' }
  | { type: 'event'; event: AgentEvent }
  | { type: 'cancel' }
  | { type: 'connection_lost' }
  | { type: 'approval_sent'; decision: 'approved' | 'rejected' };

export function runReducer(model: RunModel, action: Action): RunModel {
  if (action.type === 'send') return { ...initialRun, state: 'streaming' };
  if (action.type === 'cancel') return { ...model, state: 'cancelled' };
  if (action.type === 'connection_lost')
    return model.state === 'completed' || model.state === 'cancelled'
      ? model
      : { ...model, state: 'error', error: { kind: 'connection_lost', message: 'Connection lost.', retryable: true } };
  if (action.type === 'approval_sent') {
    if (!model.approval) return model;
    return {
      ...model,
      state: action.decision === 'approved' ? 'streaming' : 'awaiting_approval',
      approvedWrite: model.approvedWrite || action.decision === 'approved',
      approval: { ...model.approval, resolved: action.decision },
      tools: { ...model.tools, [model.approval.call_id]: { ...model.tools[model.approval.call_id]!, status: action.decision === 'approved' ? 'running' : 'rejected' } },
    };
  }
  const event = action.event;
  switch (event.type) {
    case 'run.started': return { ...model, runId: event.run_id, sessionId: event.session_id, provider: event.provider, model: event.model, state: 'streaming' };
    case 'text.delta': return { ...model, text: model.text + event.text };
    case 'thinking.delta': return { ...model, thinking: model.thinking + event.text };
    case 'tool.call': return { ...model, tools: { ...model.tools, [event.call_id]: { callId: event.call_id, name: event.name, kind: event.kind, arguments: event.arguments, status: event.kind === 'write' ? 'awaiting_approval' : 'running' } } };
    case 'approval.required': return { ...model, state: 'awaiting_approval', approval: { ...event, resolved: undefined } };
    case 'approval.resolved':
      return model.approval?.call_id === event.call_id
        ? { ...model, approval: { ...model.approval, resolved: event.decision } }
        : model;
    case 'tool.result': return { ...model, tools: { ...model.tools, [event.call_id]: { ...model.tools[event.call_id]!, status: event.status, latencyMs: event.latency_ms, summary: event.summary, truncated: event.truncated } } };
    case 'run.completed': return { ...model, state: 'completed' };
    case 'run.error': return { ...model, state: 'error', error: event };
  }
}
