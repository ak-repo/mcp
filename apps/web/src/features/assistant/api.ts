import { ProvidersResponseSchema, ApprovalResponseSchema, CancelRunResponseSchema } from '@foodops/shared';
import { apiFetch, openChat } from '../../lib/api/client.js';

export function getProviders(signal?: AbortSignal) {
  return apiFetch('/api/providers', ProvidersResponseSchema, signal ? { signal } : {});
}
export function startChat(message: string, sessionId: string | undefined, signal: AbortSignal) {
  return openChat({ message, ...(sessionId ? { session_id: sessionId } : {}) }, signal);
}
export function resolveApproval(runId: string, callId: string, decision: 'approved' | 'rejected') {
  return apiFetch(`/api/chat/${encodeURIComponent(runId)}/approve`, ApprovalResponseSchema, { method: 'POST', body: { call_id: callId, decision } });
}
export function cancelRun(runId: string) {
  return apiFetch(`/api/chat/${encodeURIComponent(runId)}/cancel`, CancelRunResponseSchema, { method: 'POST', body: {} });
}
