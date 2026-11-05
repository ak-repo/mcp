import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api/errors.js';
import { newIdempotencyKey } from '../../lib/ids.js';
import { executeOrder, previewOrder, type PreviewInput } from './api.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';

type Props = {
  orderId: string;
  input: PreviewInput;
  onSuccess?: () => void;
  onCancel?: () => void;
};
export function WriteFlow({ orderId, input, onSuccess, onCancel }: Props) {
  const [state, setState] = useState<
    'idle' | 'previewing' | 'previewed' | 'executing' | 'success' | 'error'
  >('idle');
  const [reason, setReason] = useState(input.reason);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState('');
  const token = useRef<string | undefined>(undefined);
  const key = useRef<string | undefined>(undefined);
  const currentInput = { ...input, reason } as PreviewInput;
  const previewNow = async () => {
    if (!reason.trim()) {
      setMessage('A reason is required.');
      setState('error');
      return;
    }
    setState('previewing');
    setMessage('');
    try {
      const value = await previewOrder(orderId, currentInput);
      setPreview(value as unknown as Record<string, unknown>);
      token.current = value.confirmation_token;
      setState('previewed');
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Preview could not be loaded.');
      setState('error');
    }
  };
  const confirm = async () => {
    if (!token.current || state === 'executing') return;
    key.current ??= newIdempotencyKey();
    setState('executing');
    setMessage('');
    try {
      const result = await executeOrder(orderId, currentInput, token.current, key.current);
      const replayed = result.headers.get('Idempotency-Replayed') === 'true';
      setMessage(replayed ? 'Already applied.' : 'Change applied.');
      setState('success');
      token.current = undefined;
      key.current = undefined;
      onSuccess?.();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 409 || error.status === 428)) {
        setMessage('State changed or preview expired. Please review a fresh preview.');
        token.current = undefined;
        setState('idle');
        return;
      }
      setMessage(error instanceof ApiError ? error.message : 'Execution failed.');
      setState('error');
    }
  };
  useEffect(
    () => () => {
      token.current = undefined;
      key.current = undefined;
    },
    [],
  );
  return (
    <Card className="write-flow">
      <CardHeader>
        <CardTitle>Review change</CardTitle>
      </CardHeader>
      <CardContent>
        <Label htmlFor={`reason-${orderId}`}>Reason</Label>
        <Input
          id={`reason-${orderId}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          disabled={state === 'executing' || state === 'success'}
        />
        {preview && (
          <dl className="preview-grid">
            {Object.entries(preview)
              .filter(([name]) => !['confirmation_token', 'expires_at'].includes(name))
              .map(([name, value]) => (
                <div key={name}>
                  <dt>{name.replaceAll('_', ' ')}</dt>
                  <dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
                </div>
              ))}
          </dl>
        )}
        {message && (
          <p role="status" className="mt-3 muted">
            {message}
          </p>
        )}
        <div className="mt-4 flex gap-2">
          {state === 'idle' || state === 'error' ? (
            <Button onClick={() => void previewNow()}>Preview</Button>
          ) : state === 'previewed' ? (
            <>
              <Button onClick={() => void confirm()}>Confirm</Button>
              <Button
                variant="outline"
                onClick={() => {
                  token.current = undefined;
                  setState('idle');
                  onCancel?.();
                }}
              >
                Cancel
              </Button>
            </>
          ) : state === 'previewing' || state === 'executing' ? (
            <Button disabled>{state === 'previewing' ? 'Previewing…' : 'Applying…'}</Button>
          ) : (
            <Button variant="outline" onClick={onCancel}>
              Close
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
