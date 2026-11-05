import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { PageHeader } from '../../components/common/page-header.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { getProviders } from '../assistant/api.js';

export function SettingsPage() {
  const providers = useQuery({ queryKey: ['server', 'providers'], queryFn: ({ signal }) => getProviders(signal) });
  return <div className="feature-page"><PageHeader title="Settings" description="Provider diagnostics and configuration status." /><Card><CardHeader><CardTitle>Provider</CardTitle></CardHeader><CardContent>{providers.isLoading ? <p>Loading…</p> : providers.isError ? <p role="alert">Provider status unavailable.</p> : providers.data ? <dl className="preview-grid"><dt>Provider</dt><dd>{providers.data.provider}</dd><dt>Model</dt><dd>{providers.data.model ?? 'Not configured'}</dd><dt>API key</dt><dd>{providers.data.api_key_set ? 'Configured' : 'Not configured'}</dd></dl> : null}<p className="muted">Provider updates remain managed by the server configuration in this phase.</p><Link to="/assistant">Back to Assistant</Link></CardContent></Card></div>;
}
