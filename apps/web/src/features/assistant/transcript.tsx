import { AlertTriangle, Wrench } from 'lucide-react';
import { Link } from 'react-router';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { errorMessage } from './error-message.js';
import type { RunModel } from './reducer.js';

/** Read-only rendering of one turn: user bubble, thinking, assistant text, tool cards and any error. */
export function TurnView({ userMessage, run }: { userMessage: string; run: RunModel }) {
  const tools = Object.values(run.tools).filter(
    (tool) => typeof tool.arguments.order_id === 'string',
  );
  const orderId = (tools.find((tool) => tool.kind === 'write') ?? tools[0])?.arguments.order_id;
  const orderLink = typeof orderId === 'string' ? orderId : undefined;
  return (
    <div className="chat-turn">
      {userMessage && (
        <div className="chat-message user-message">
          <Badge>ops</Badge>
          <p>{userMessage}</p>
        </div>
      )}
      {run.thinking && (
        <details className="thinking-panel">
          <summary>Thinking (collapsed)</summary>
          <p>{run.thinking}</p>
        </details>
      )}
      {run.text && (
        <div className="chat-message assistant-message">
          <Badge>assistant</Badge>
          <p>{run.text}</p>
        </div>
      )}
      {Object.values(run.tools).map((tool) => (
        <Card key={tool.callId} className="tool-call-card">
          <CardHeader>
            <CardTitle>
              <Wrench size={16} aria-hidden="true" /> {tool.name}{' '}
              <Badge className={tool.kind === 'write' ? 'badge-danger' : ''}>{tool.kind}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <details>
              <summary>Arguments</summary>
              <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
            </details>
            <p>
              {tool.status}
              {tool.latencyMs !== undefined ? ` · ${tool.latencyMs} ms` : ''}
            </p>
            {tool.summary && (
              <p>
                {tool.summary}
                {tool.truncated ? ' (truncated)' : ''}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
      {run.error && (
        <Card
          className={run.error.kind === 'unknown_outcome' ? 'error-card prominent' : 'error-card'}
        >
          <CardContent>
            <AlertTriangle size={18} aria-hidden="true" /> <p>{errorMessage(run)}</p>
            {run.error.kind === 'unknown_outcome' && orderLink && (
              <Link to={`/orders/${encodeURIComponent(orderLink)}`}>Inspect {orderLink}</Link>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
