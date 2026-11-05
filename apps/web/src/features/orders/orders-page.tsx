import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router';
import { LayoutGrid, List, RefreshCw } from 'lucide-react';
import { listOrders, type OrderFilters } from './api.js';
import { OrderDrawer } from './order-drawer.js';
import { queryKeys } from '../../lib/api/query-keys.js';
import { PageHeader } from '../../components/common/page-header.js';
import { LoadingState, ErrorState, EmptyState } from '../../components/common/async-state.js';
import { StatusBadge } from '../../components/common/status-badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Card, CardContent } from '../../components/ui/card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import type { OrderStatus } from '@foodops/shared';
type OrderRow = Awaited<ReturnType<typeof listOrders>>['data'][number];

const statuses: OrderStatus[] = [
  'placed',
  'accepted',
  'preparing',
  'ready',
  'picked_up',
  'out_for_delivery',
  'delivered',
  'cancelled',
];
const pad = (n: number) => String(n).padStart(2, '0');
function defaultRange() {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - 29);
  const f = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { from: f(start), to: f(end) };
}
export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const route = useParams<{ id?: string }>();
  const [selected, setSelected] = useState<string | null>(route.id ?? params.get('id'));
  const view = params.get('view') === 'board' ? 'board' : 'table';
  const range = defaultRange();
  const filters: OrderFilters = {
    q: params.get('q') ?? undefined,
    from: params.get('from') ?? range.from,
    to: params.get('to') ?? range.to,
    restaurant_id: params.get('restaurant_id') ?? undefined,
    customer_id: params.get('customer_id') ?? undefined,
    cursor: params.get('cursor') ?? undefined,
  };
  const query = useQuery({
    queryKey: queryKeys.orderList(filters),
    queryFn: ({ signal }) => listOrders(filters, signal),
  });
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    void setParams(next);
  };
  const grouped = useMemo(
    () =>
      statuses.reduce<Record<string, OrderRow[]>>((acc, status) => {
        acc[status] = (query.data?.data ?? []).filter((order) => order.status === status);
        return acc;
      }, {}),
    [query.data],
  );
  return (
    <>
      <PageHeader
        title="Orders"
        description="Inspect order state, delivery progress, and approved actions. Filters use UTC dates."
        actions={
          <div className="flex gap-2">
            <Button
              variant={view === 'table' ? 'default' : 'outline'}
              size="sm"
              onClick={() => set('view', 'table')}
            >
              <List size={15} /> Table
            </Button>
            <Button
              variant={view === 'board' ? 'default' : 'outline'}
              size="sm"
              onClick={() => set('view', 'board')}
            >
              <LayoutGrid size={15} /> Board
            </Button>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              <RefreshCw size={15} />
            </Button>
          </div>
        }
      />
      <Card className="mb-5">
        <CardContent className="filters">
          <label className="label" htmlFor="order-search">
            Search
          </label>
          <Input
            id="order-search"
            value={params.get('q') ?? ''}
            onChange={(e) => set('q', e.target.value)}
            placeholder="Order, customer, or restaurant"
          />
          <label className="label" htmlFor="from">
            From UTC
          </label>
          <Input
            id="from"
            type="date"
            value={params.get('from') ?? range.from}
            onChange={(e) => set('from', e.target.value)}
          />
          <label className="label" htmlFor="to">
            To UTC
          </label>
          <Input
            id="to"
            type="date"
            value={params.get('to') ?? range.to}
            onChange={(e) => set('to', e.target.value)}
          />
        </CardContent>
      </Card>
      {query.isPending ? (
        <LoadingState label="Loading orders" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data.data.length ? (
        <EmptyState
          title="No orders found"
          description="Try a wider UTC range or different filters."
        />
      ) : view === 'table' ? (
        <OrderTable
          orders={query.data.data}
          onOpen={(id) => {
            setSelected(id);
            set('id', id);
          }}
        />
      ) : (
        <div className="board-grid">
          {statuses.map((status) => (
            <section
              className={`board-column ${status === 'delivered' || status === 'cancelled' ? 'collapsed-default' : ''}`}
              key={status}
            >
              <header>
                <StatusBadge status={status} />
                <span className="muted">{grouped[status]?.length ?? 0}</span>
              </header>
              {grouped[status]?.map((order) => (
                <button
                  className="order-card"
                  key={order.id}
                  onClick={() => {
                    setSelected(order.id);
                    set('id', order.id);
                  }}
                >
                  <strong>{order.id}</strong>
                  <span>{order.restaurant_id}</span>
                  <span>{order.total_display}</span>
                  <time>{order.placed_at.slice(0, 10)}</time>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
      {query.data?.next_cursor && (
        <Button
          variant="outline"
          className="mt-5"
          onClick={() => set('cursor', query.data?.next_cursor ?? '')}
        >
          Load more
        </Button>
      )}
      {selected && (
        <OrderDrawer
          orderId={selected}
          onClose={() => {
            setSelected(null);
            const next = new URLSearchParams(params);
            next.delete('id');
            void setParams(next);
          }}
        />
      )}
    </>
  );
}
function OrderTable({ orders, onOpen }: { orders: OrderRow[]; onOpen: (id: string) => void }) {
  return (
    <div className="card overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Restaurant</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Total</TableHead>
            <TableHead>Placed · UTC</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.map((order) => (
            <TableRow key={order.id}>
              <TableCell>
                <button className="link-button" onClick={() => onOpen(order.id)}>
                  {order.id}
                </button>
              </TableCell>
              <TableCell>{order.customer_id}</TableCell>
              <TableCell>{order.restaurant_id}</TableCell>
              <TableCell>
                <StatusBadge status={order.status} />
              </TableCell>
              <TableCell>{order.total_display}</TableCell>
              <TableCell>{order.placed_at.replace('T', ' ').slice(0, 16)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
