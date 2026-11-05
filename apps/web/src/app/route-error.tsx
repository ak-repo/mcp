import { Link, useRouteError } from 'react-router';
import { Button } from '../components/ui/button.js';
import { ErrorState } from '../components/common/async-state.js';
export function RouteError() {
  const error = useRouteError();
  return (
    <main className="state-page" id="main-content">
      <h1>Unable to show this page</h1>
      <ErrorState error={error} />
      <Button asChild variant="outline">
        <a href="/">Reload workspace</a>
      </Button>
    </main>
  );
}
export function NotFound() {
  return (
    <main className="state-page" id="main-content">
      <p className="eyebrow">404</p>
      <h1>Page not found</h1>
      <p className="muted">This address does not match a page in FoodOps.</p>
      <Button asChild>
        <Link to="/">Go to System status</Link>
      </Button>
    </main>
  );
}
