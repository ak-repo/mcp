import type { RunModel } from './reducer.js';

export function errorMessage(run: RunModel) {
  if (!run.error) return '';
  switch (run.error.kind) {
    case 'auth':
      return 'The provider needs authentication. Update the provider settings.';
    case 'rate_limit':
      return 'The provider is rate limited. Please try again later.';
    case 'timeout':
      return 'The provider timed out before completing the response.';
    case 'provider_error':
    case 'network':
      return 'The provider could not complete this request.';
    case 'unknown_outcome':
      return 'The write outcome is unknown. Inspect the order before retrying.';
    case 'connection_lost':
      return run.approvedWrite
        ? 'Connection lost. An approved write may still complete; verify the order state.'
        : 'Connection lost before the run completed.';
    default:
      return run.error.message;
  }
}
