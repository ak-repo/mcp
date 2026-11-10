import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Bot, Check, Loader2, Plus, Square } from 'lucide-react';
import { ApiError } from '../../lib/api/errors.js';
import { queryKeys } from '../../lib/api/query-keys.js';
import { PageHeader } from '../../components/common/page-header.js';
import { ErrorState } from '../../components/common/async-state.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { getProviders, startChat, resolveApproval, cancelRun } from './api.js';
import { readChatSse } from './sse-parser.js';
import {
  archiveTurn,
  initialRun,
  runAnnouncement,
  runReducer,
  type RunModel,
  type Turn,
} from './reducer.js';
import { TurnView } from './transcript.js';
import { PreviewRenderer } from '../orders/preview-renderers.js';

const starters = [
  'Show late deliveries',
  'Find orders stuck in placed',
  'Daily ops report for yesterday',
];
function humanize(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function AssistantPage() {
  const providers = useQuery({
    queryKey: ['server', 'providers'],
    queryFn: ({ signal }) => getProviders(signal),
  });
  const queryClient = useQueryClient();
  const [run, dispatch] = useState<RunModel>(initialRun);
  const [draft, setDraft] = useState('');
  const [sentMessage, setSentMessage] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
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
  const setupNeeded = providers.data
    ? !providers.data.model || (!providers.data.api_key_set && providers.data.provider !== 'ollama')
    : false;

  useEffect(() => {
    if (!approval || approval.resolved) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [approval]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const submit = async (text: string, fromComposer = false) => {
    if (!text.trim() || run.state === 'streaming' || run.state === 'awaiting_approval') return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setTurns((previous) => archiveTurn(previous, sentMessage, run));
    dispatch(runReducer(initialRun, { type: 'send' }));
    setSentMessage(text.trim());
    if (fromComposer) setDraft('');
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
      dispatch((current) =>
        current.state === 'streaming' || current.state === 'awaiting_approval'
          ? runReducer(current, { type: 'connection_lost' })
          : current,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      dispatch((current) => ({
        ...current,
        state: 'error',
        error: {
          kind: error instanceof ApiError ? String(error.code) : 'network',
          message: error instanceof Error ? error.message : 'The chat request failed.',
          retryable: true,
        },
      }));
    }
  };

  const stop = async () => {
    abortRef.current?.abort();
    if (run.runId) {
      try {
        await cancelRun(run.runId);
      } catch {
        /* stream cancellation is best effort */
      }
    }
    dispatch((current) => runReducer(current, { type: 'cancel' }));
  };
  const decide = async (decision: 'approved' | 'rejected') => {
    if (!run.runId || !approval || approval.resolved || approvalBusy) return;
    setApprovalBusy(true);
    setApprovalMessage('');
    try {
      await resolveApproval(run.runId, approval.call_id, decision);
      dispatch((current) => runReducer(current, { type: 'approval_sent', decision }));
      setApprovalOpen(false);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 409))
        setApprovalMessage('This approval is already resolved or expired.');
      else
        setApprovalMessage(
          error instanceof Error ? error.message : 'Approval could not be submitted.',
        );
    } finally {
      setApprovalBusy(false);
    }
  };
  const startNew = () => {
    abortRef.current?.abort();
    dispatch(initialRun);
    setSessionId(undefined);
    setDraft('');
    setSentMessage('');
    setTurns([]);
    setApprovalOpen(false);
  };
  const orderId = toolForApproval?.arguments.order_id;
  const orderLink = typeof orderId === 'string' ? orderId : undefined;
  const preview =
    approval?.preview && typeof approval.preview === 'object'
      ? (approval.preview as Record<string, unknown>)
      : undefined;
  const remaining = approval ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;

  return (
    <div className="feature-page assistant-page">
      <PageHeader
        title="Assistant"
        description="Ask the operations assistant for read-only insight or review a proposed change."
      />
      <div className="assistant-toolbar">
        <div className="provider-badge">
          <Bot size={16} aria-hidden="true" />{' '}
          {providers.data
            ? `${providers.data.provider} · ${providers.data.model ?? 'No model'}`
            : 'Loading provider…'}
        </div>
        <Button variant="outline" onClick={startNew}>
          <Plus size={16} aria-hidden="true" /> New chat
        </Button>
        {run.state !== 'idle' && run.state !== 'completed' && run.state !== 'cancelled' && (
          <Button variant="outline" onClick={() => void stop()}>
            <Square size={14} aria-hidden="true" /> Stop
          </Button>
        )}
      </div>
      {setupNeeded && (
        <Card className="setup-callout">
          <CardContent>
            <strong>Provider setup needed.</strong> Configure a model and provider key in{' '}
            <Link to="/settings">Settings</Link> before sending.
          </CardContent>
        </Card>
      )}
      {providers.isError && (
        <ErrorState error={providers.error} onRetry={() => void providers.refetch()} />
      )}
      <p role="status" className="sr-only">
        {runAnnouncement(run.state)}
      </p>
      <div className="assistant-transcript">
        {turns.map((turn, index) => (
          <TurnView key={index} userMessage={turn.userMessage} run={turn.run} />
        ))}
        <TurnView userMessage={sentMessage} run={run} />
        {approval &&
          (!approval.resolved ||
            (approval.resolved === 'approved' && toolForApproval?.status === 'running')) && (
            <Card className="approval-card">
              <CardContent>
                <strong>
                  {approval.resolved === 'approved'
                    ? 'Executing'
                    : `Approval required: ${humanize(approval.name)}`}
                </strong>
                <p>
                  {approval.resolved === 'approved'
                    ? 'The approved write is running.'
                    : `Expires in ${expired ? 'expired' : `${remaining}s`}.`}
                </p>
                {orderLink && (
                  <Link to={`/orders/${encodeURIComponent(orderLink)}`}>
                    Review order {orderLink}
                  </Link>
                )}
                {!approval.resolved && (
                  <Button onClick={() => setApprovalOpen(true)}>Review approval</Button>
                )}
              </CardContent>
            </Card>
          )}
      </div>
      {starters.map((starter) => (
        <Button
          key={starter}
          variant="outline"
          disabled={run.state === 'streaming' || run.state === 'awaiting_approval'}
          onClick={() => void submit(starter)}
        >
          {starter}
        </Button>
      ))}
      <form
        className="assistant-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(draft, true);
        }}
      >
        <Input
          value={draft}
          disabled={run.state === 'streaming' || run.state === 'awaiting_approval'}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit(draft, true);
            }
          }}
          placeholder="Ask the assistant…"
          aria-label="Message assistant"
        />
        <Button
          type="submit"
          disabled={!draft.trim() || run.state === 'streaming' || run.state === 'awaiting_approval'}
        >
          Send
        </Button>
      </form>
      <Dialog open={approvalOpen} onOpenChange={setApprovalOpen}>
        <DialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            headingRef.current?.focus();
          }}
        >
          <DialogTitle ref={headingRef} tabIndex={-1}>
            Approve {approval ? humanize(approval.name) : 'operation'}
          </DialogTitle>
          <DialogDescription>
            Review the proposed change. Closing this dialog does not resolve it.
          </DialogDescription>
          {orderLink && (
            <Link to={`/orders/${encodeURIComponent(orderLink)}`}>Target order {orderLink}</Link>
          )}
          {preview && <PreviewRenderer preview={preview} />}
          {preview && (
            <details>
              <summary>Raw JSON</summary>
              <pre>{JSON.stringify(preview, null, 2)}</pre>
            </details>
          )}
          <p>Expires in {expired ? 'expired' : `${remaining}s`}.</p>
          {approvalMessage && <p role="alert">{approvalMessage}</p>}
          <div className="dialog-actions">
            <Button
              variant="outline"
              disabled={approvalBusy || Boolean(approval?.resolved)}
              onClick={() => void decide('rejected')}
            >
              Reject
            </Button>
            <Button
              disabled={approvalBusy || Boolean(approval?.resolved)}
              onClick={() => void decide('approved')}
            >
              {approvalBusy ? (
                <Loader2 className="spin" size={16} aria-hidden="true" />
              ) : (
                <Check size={16} aria-hidden="true" />
              )}{' '}
              Approve
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
