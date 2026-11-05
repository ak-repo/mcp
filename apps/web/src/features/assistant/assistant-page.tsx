import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AlertTriangle, Bot, Check, Loader2, Plus, Square, Wrench } from 'lucide-react';
import { ApiError } from '../../lib/api/errors.js';
import { queryKeys } from '../../lib/api/query-keys.js';
import { PageHeader } from '../../components/common/page-header.js';
import { ErrorState } from '../../components/common/async-state.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Badge } from '../../components/ui/badge.js';
import { getProviders, startChat, resolveApproval, cancelRun } from './api.js';
import { readChatSse } from './sse-parser.js';
import { initialRun, runReducer, type RunModel } from './reducer.js';
import { PreviewRenderer } from '../orders/preview-renderers.js';

const starters = ['Show late deliveries', 'Find orders stuck in placed', 'Daily ops report for yesterday'];
function humanize(value: string) { return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }

function errorMessage(run: RunModel) {
  if (!run.error) return '';
  switch (run.error.kind) {
    case 'auth': return 'The provider needs authentication. Update the provider settings.';
    case 'rate_limit': return 'The provider is rate limited. Please try again later.';
    case 'timeout': return 'The provider timed out before completing the response.';
    case 'provider_error':
    case 'network': return 'The provider could not complete this request.';
    case 'unknown_outcome': return 'The write outcome is unknown. Inspect the order before retrying.';
    case 'connection_lost': return run.approvedWrite ? 'Connection lost. An approved write may still complete; verify the order state.' : 'Connection lost before the run completed.';
    default: return run.error.message;
  }
}

export function AssistantPage() {
  const providers = useQuery({ queryKey: ['server', 'providers'], queryFn: ({ signal }) => getProviders(signal) });
  const queryClient = useQueryClient();
  const [run, dispatch] = useState<RunModel>(initialRun);
  const [message, setMessage] = useState('');
  const [sessionId, setSessionId] = useState<string>();
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalMessage, setApprovalMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const abortRef = useRef<AbortController>();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const approval = run.approval;
  const toolForApproval = approval ? run.tools[approval.call_id] : undefined;
  const expiresAt = approval ? Date.parse(approval.expires_at) : 0;
  const expired = Boolean(approval && expiresAt <= now);
  const setupNeeded = providers.data ? !providers.data.model || (!providers.data.api_key_set && providers.data.provider !== 'ollama') : false;

  useEffect(() => { if (!approval || approval.resolved) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [approval]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const submit = async (text: string) => {
    if (!text.trim() || run.state === 'streaming' || run.state === 'awaiting_approval') return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch(runReducer(initialRun, { type: 'send' }));
    setMessage(text);
    setApprovalMessage('');
    try {
      const body = await startChat(text.trim(), sessionId, controller.signal);
      await readChatSse(body, controller.signal, (event) => {
        dispatch((current) => runReducer(current, { type: 'event', event }));
        if (event.type === 'run.started') setSessionId(event.session_id);
        if (event.type === 'tool.result' && event.status === 'ok') {
          void queryClient.invalidateQueries({ queryKey: queryKeys.orders() });
          void queryClient.invalidateQueries({ queryKey: queryKeys.deliveries() });
          void queryClient.invalidateQueries({ queryKey: queryKeys.partners() });
          void queryClient.invalidateQueries({ queryKey: queryKeys.metrics() });
        }
      });
      dispatch((current) => current.state === 'streaming' || current.state === 'awaiting_approval' ? runReducer(current, { type: 'connection_lost' }) : current);
    } catch (error) {
      if (controller.signal.aborted) return;
      dispatch((current) => ({ ...current, state: 'error', error: { kind: error instanceof ApiError ? String(error.code) : 'network', message: error instanceof Error ? error.message : 'The chat request failed.', retryable: true } }));
    }
  };

  const stop = async () => {
    abortRef.current?.abort();
    if (run.runId) {
      try { await cancelRun(run.runId); } catch { /* stream cancellation is best effort */ }
    }
    dispatch((current) => runReducer(current, { type: 'cancel' }));
  };
  const decide = async (decision: 'approved' | 'rejected') => {
    if (!run.runId || !approval || expired || approval.resolved || approvalBusy) return;
    setApprovalBusy(true); setApprovalMessage('');
    try {
      await resolveApproval(run.runId, approval.call_id, decision);
      dispatch((current) => runReducer(current, { type: 'approval_sent', decision }));
      setApprovalOpen(false);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) setApprovalMessage('This approval is already resolved or expired.');
      else setApprovalMessage(error instanceof Error ? error.message : 'Approval could not be submitted.');
    } finally { setApprovalBusy(false); }
  };
  const startNew = () => { abortRef.current?.abort(); dispatch(initialRun); setSessionId(undefined); setMessage(''); setApprovalOpen(false); };
  const orderId = toolForApproval?.arguments.order_id;
  const orderLink = typeof orderId === 'string' ? orderId : undefined;
  const preview = approval?.preview && typeof approval.preview === 'object' ? approval.preview as Record<string, unknown> : undefined;
  const remaining = approval ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;

  return (
    <div className="feature-page assistant-page">
      <PageHeader title="Assistant" description="Ask the operations assistant for read-only insight or review a proposed change." />
      <div className="assistant-toolbar">
        <div className="provider-badge"><Bot size={16} aria-hidden="true" /> {providers.data ? `${providers.data.provider} · ${providers.data.model ?? 'No model'}` : 'Loading provider…'}</div>
        <Button variant="outline" onClick={startNew}><Plus size={16} aria-hidden="true" /> New chat</Button>
        {run.state !== 'idle' && run.state !== 'completed' && run.state !== 'cancelled' && <Button variant="outline" onClick={() => void stop()}><Square size={14} aria-hidden="true" /> Stop</Button>}
      </div>
      {setupNeeded && <Card className="setup-callout"><CardContent><strong>Provider setup needed.</strong> Configure a model and provider key in <Link to="/settings">Settings</Link> before sending.</CardContent></Card>}
      {providers.isError && <ErrorState error={providers.error} onRetry={() => void providers.refetch()} />}
      <div className="assistant-transcript" aria-live="polite">
        {message && <div className="chat-message user-message"><Badge>ops</Badge><p>{message}</p></div>}
        {run.thinking && <details className="thinking-panel"><summary>Thinking (collapsed)</summary><p>{run.thinking}</p></details>}
        {run.text && <div className="chat-message assistant-message"><Badge>assistant</Badge><p>{run.text}</p></div>}
        {Object.values(run.tools).map((tool) => <Card key={tool.callId} className="tool-call-card"><CardHeader><CardTitle><Wrench size={16} aria-hidden="true" /> {tool.name} <Badge className={tool.kind === 'write' ? 'badge-danger' : ''}>{tool.kind}</Badge></CardTitle></CardHeader><CardContent><details><summary>Arguments</summary><pre>{JSON.stringify(tool.arguments, null, 2)}</pre></details><p>{tool.status}{tool.latencyMs !== undefined ? ` · ${tool.latencyMs} ms` : ''}</p>{tool.summary && <p>{tool.summary}{tool.truncated ? ' (truncated)' : ''}</p>}</CardContent></Card>)}
        {approval && (!approval.resolved || (approval.resolved === 'approved' && toolForApproval?.status === 'running')) && <Card className="approval-card"><CardContent><strong>{approval.resolved === 'approved' ? 'Executing' : `Approval required: ${humanize(approval.name)}`}</strong><p>{approval.resolved === 'approved' ? 'The approved write is running.' : `Expires in ${expired ? 'expired' : `${remaining}s`}.`}</p>{orderLink && <Link to={`/orders/${encodeURIComponent(orderLink)}`}>Review order {orderLink}</Link>}{!approval.resolved && <Button disabled={expired} onClick={() => setApprovalOpen(true)}>Review approval</Button>}</CardContent></Card>}
        {run.error && <Card className={run.error.kind === 'unknown_outcome' ? 'error-card prominent' : 'error-card'}><CardContent><AlertTriangle size={18} aria-hidden="true" /> <p>{errorMessage(run)}</p>{run.error.kind === 'unknown_outcome' && orderLink && <Link to={`/orders/${encodeURIComponent(orderLink)}`}>Inspect {orderLink}</Link>}</CardContent></Card>}
      </div>
      {starters.map((starter) => <Button key={starter} variant="outline" disabled={run.state === 'streaming' || run.state === 'awaiting_approval'} onClick={() => void submit(starter)}>{starter}</Button>)}
      <form className="assistant-composer" onSubmit={(event) => { event.preventDefault(); void submit(message); }}><Input value={message} disabled={run.state === 'streaming' || run.state === 'awaiting_approval'} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(message); } }} placeholder="Ask the assistant…" aria-label="Message assistant" /><Button type="submit" disabled={!message.trim() || run.state === 'streaming' || run.state === 'awaiting_approval'}>Send</Button></form>
      <Dialog open={approvalOpen} onOpenChange={setApprovalOpen}>
        <DialogContent onOpenAutoFocus={(event) => { event.preventDefault(); headingRef.current?.focus(); }}>
          <DialogTitle ref={headingRef} tabIndex={-1}>Approve {approval ? humanize(approval.name) : 'operation'}</DialogTitle>
          <DialogDescription>Review the proposed change. Closing this dialog does not resolve it.</DialogDescription>
          {orderLink && <Link to={`/orders/${encodeURIComponent(orderLink)}`}>Target order {orderLink}</Link>}
          {preview && <PreviewRenderer preview={preview} />}
          {preview && <details><summary>Raw JSON</summary><pre>{JSON.stringify(preview, null, 2)}</pre></details>}
          <p>Expires in {expired ? 'expired' : `${remaining}s`}.</p>
          {approvalMessage && <p role="alert">{approvalMessage}</p>}
          <div className="dialog-actions"><Button variant="outline" disabled={approvalBusy || expired || Boolean(approval?.resolved)} onClick={() => void decide('rejected')}>Reject</Button><Button disabled={approvalBusy || expired || Boolean(approval?.resolved)} onClick={() => void decide('approved')}>{approvalBusy ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />} Approve</Button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
