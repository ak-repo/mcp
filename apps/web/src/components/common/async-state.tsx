import { AlertCircle, Inbox } from 'lucide-react';
import { errorText } from '../../lib/api/errors.js';
import { Button } from '../ui/button.js';
import { Skeleton } from '../ui/skeleton.js';
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state-panel" role="alert">
      <AlertCircle aria-hidden="true" />
      <p>{errorText(error)}</p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="state-panel">
      <Inbox aria-hidden="true" />
      <h3>{title}</h3>
      <p className="muted">{description}</p>
    </div>
  );
}
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="space-y-3">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}
