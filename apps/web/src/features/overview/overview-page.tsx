import { lazy, Suspense, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, BarChart3, Clock3, IndianRupee, RefreshCw, ShoppingBag } from 'lucide-react';
import { getSummary } from '../orders/api.js';
import { queryKeys } from '../../lib/api/query-keys.js';
import { PageHeader } from '../../components/common/page-header.js';
import { LoadingState, ErrorState, EmptyState } from '../../components/common/async-state.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';

const Charts = lazy(async () => ({
  default: (await import('./overview-charts.js')).OverviewCharts,
}));
const pad = (n: number) => String(n).padStart(2, '0');
function utcRange(days: number) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - days + 1);
  return {
    from: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`,
    to: `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`,
  };
}
const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;
export function OverviewPage() {
  const [days, setDays] = useState(7);
  const range = utcRange(days);
  const summary = useQuery({
    queryKey: queryKeys.metricsSummary({ ...range, group_by: 'day' }),
    queryFn: ({ signal }) => getSummary({ ...range, group_by: 'day' }, signal),
  });
  const status = useQuery({
    queryKey: queryKeys.metricsSummary({ ...range, group_by: 'status' }),
    queryFn: ({ signal }) => getSummary({ ...range, group_by: 'status' }, signal),
  });
  const restaurants = useQuery({
    queryKey: queryKeys.metricsSummary({ ...range, group_by: 'restaurant' }),
    queryFn: ({ signal }) => getSummary({ ...range, group_by: 'restaurant' }, signal),
  });
  const totals = summary.data?.totals;
  const daily = useMemo(
    () =>
      summary.data?.groups.map((g) => ({ key: g.key, orders: g.orders, gmv: g.gmv_paise })) ?? [],
    [summary.data],
  );
  const statusPoints = useMemo(
    () =>
      status.data?.groups.map((g) => ({ key: g.key, orders: g.orders, gmv: g.gmv_paise })) ?? [],
    [status.data],
  );
  const restaurantPoints = useMemo(
    () =>
      (restaurants.data?.groups ?? [])
        .slice()
        .sort((a, b) => b.gmv_paise - a.gmv_paise)
        .slice(0, 8)
        .map((g) => ({ key: g.key, orders: g.orders, gmv: g.gmv_paise })),
    [restaurants.data],
  );
  const kpis = [
    { Icon: ShoppingBag, label: 'Orders', value: String(totals?.orders ?? '—') },
    { Icon: IndianRupee, label: 'GMV', value: totals?.gmv_display ?? '—' },
    {
      Icon: BarChart3,
      label: 'Average order value',
      value: totals?.avg_order_value_display ?? '—',
    },
    {
      Icon: Activity,
      label: 'Cancel rate',
      value: totals ? formatPercent(totals.cancel_rate) : '—',
    },
    {
      Icon: Clock3,
      label: 'Average delivery time',
      value: totals?.avg_delivery_time_min == null ? '—' : `${totals.avg_delivery_time_min} min`,
    },
  ];
  return (
    <>
      <PageHeader
        title="Overview"
        description={`Operational performance for ${range.from}–${range.to} UTC.`}
        actions={
          <div className="flex gap-2">
            <select
              className="input"
              aria-label="Overview range"
              value={String(days)}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value="1">Today</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
            </select>
            <Button
              variant="outline"
              onClick={() => {
                void summary.refetch();
                void status.refetch();
                void restaurants.refetch();
              }}
            >
              <RefreshCw size={16} /> Refresh
            </Button>
          </div>
        }
      />
      {summary.isPending ? (
        <LoadingState label="Loading overview metrics" />
      ) : summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : !totals ? (
        <EmptyState title="No metrics" description="There is no summary for this UTC range." />
      ) : (
        <>
          <div className="kpi-grid">
            {kpis.map(({ Icon, label, value }) => (
              <Card key={label}>
                <CardHeader>
                  <CardTitle>{label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="kpi-value">{value}</div>
                  <span className="muted text-xs">
                    <Icon size={14} aria-hidden="true" /> UTC range
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
          <Suspense fallback={<LoadingState label="Loading charts" />}>
            <Charts daily={daily} status={statusPoints} restaurants={restaurantPoints} />
          </Suspense>
        </>
      )}
    </>
  );
}
