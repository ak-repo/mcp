import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { listDeliveries, listPartners, type DeliveryFilters } from '../orders/api.js';
import { queryKeys } from '../../lib/api/query-keys.js';
import { PageHeader } from '../../components/common/page-header.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/common/async-state.js';
import { StatusBadge } from '../../components/common/status-badge.js';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { formatDate } from '../../lib/dates.js';
import { ReassignDialog } from './reassign-dialog.js';
import { useState } from 'react';
import { filterDeliveries } from './filter-utils.js';

export function DeliveriesPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const lateOnly = params.get('late') === '1';
  const unassigned = params.get('unassigned') === '1';
  const [search, setSearch] = useState('');
  const [reassignOrder, setReassignOrder] = useState<string | null>(null);
  const filters: DeliveryFilters = status ? { status } : {};
  const deliveries = useInfiniteQuery({
    queryKey: [...queryKeys.deliveries(), filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      listDeliveries({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const partners = useQuery({
    queryKey: queryKeys.partners(),
    queryFn: ({ signal }) => listPartners({}, signal),
  });
  const allRows = deliveries.data?.pages.flatMap((page) => page.data) ?? [];
  const rows = filterDeliveries(allRows, { lateOnly, unassigned, search });
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  return (
    <div className="page-stack">
      <PageHeader title="Deliveries" description="Active delivery work and partner availability" />
      <div className="delivery-layout">
        <section className="card">
          <div className="filters delivery-filters">
            <Input
              aria-label="Search orders"
              placeholder="Search order ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              value={status || 'all'}
              onValueChange={(v) => setFilter('status', v === 'all' ? '' : v)}
            >
              <SelectTrigger aria-label="Delivery status">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {['pending', 'assigned', 'picked_up', 'out_for_delivery'].map((v) => (
                  <SelectItem key={v} value={v}>
                    {v.replaceAll('_', ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant={lateOnly ? 'default' : 'outline'}
              onClick={() => setFilter('late', lateOnly ? '' : '1')}
            >
              Late only
            </Button>
            <Button
              variant={unassigned ? 'default' : 'outline'}
              onClick={() => setFilter('unassigned', unassigned ? '' : '1')}
            >
              Unassigned only
            </Button>
          </div>
          {deliveries.isPending ? (
            <LoadingState label="Loading deliveries" />
          ) : deliveries.isError ? (
            <ErrorState error={deliveries.error} onRetry={() => void deliveries.refetch()} />
          ) : !rows?.length ? (
            <EmptyState
              title="No active deliveries"
              description="There are no deliveries matching these filters."
            />
          ) : (
            <div className="delivery-list">
              {rows.map((row) => (
                <div className={`delivery-row${row.is_late ? ' is-late' : ''}`} key={row.order_id}>
                  <div>
                    <Link to={`/orders/${encodeURIComponent(row.order_id)}`}>
                      <strong>{row.order_id}</strong>
                    </Link>
                    <p className="muted">{row.partner?.vehicle ?? 'No partner assigned'}</p>
                  </div>
                  <div>
                    <StatusBadge status={row.order_status} />
                    <p>{row.partner?.name ?? 'Unassigned'}</p>
                  </div>
                  <div>
                    <strong>
                      {row.delivery?.eta_min === null || row.delivery?.eta_min === undefined
                        ? '—'
                        : `${row.delivery.eta_min} min`}
                    </strong>
                    <p className="muted">
                      {row.delivery?.assigned_at
                        ? `Assigned ${formatDate(row.delivery.assigned_at)}`
                        : 'Not assigned'}
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => setReassignOrder(row.order_id)}>
                    Reassign
                  </Button>
                </div>
              ))}
            </div>
          )}
          {deliveries.hasNextPage && (
            <Button
              variant="outline"
              onClick={() => void deliveries.fetchNextPage()}
              disabled={deliveries.isFetchingNextPage}
            >
              {deliveries.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </section>
        <aside className="card partners-panel">
          <h2>Partners</h2>
          <div className="partner-counts">
            {['available', 'busy', 'offline'].map((s) => (
              <span key={s}>
                {s}: {partners.data?.data.filter((p) => p.status === s).length ?? '—'}
              </span>
            ))}
          </div>
          {partners.isError ? (
            <ErrorState error={partners.error} onRetry={() => void partners.refetch()} />
          ) : (
            <ul>
              {partners.data?.data
                .filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()))
                .map((p) => (
                  <li key={p.id}>
                    <strong>{p.name}</strong>
                    <span>
                      {p.vehicle} · {p.status}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </aside>
      </div>
      {reassignOrder && (
        <ReassignDialog
          orderId={reassignOrder}
          open
          onOpenChange={(open) => {
            if (!open) setReassignOrder(null);
          }}
          onSuccess={() => {
            void deliveries.refetch();
            void partners.refetch();
          }}
        />
      )}
    </div>
  );
}
