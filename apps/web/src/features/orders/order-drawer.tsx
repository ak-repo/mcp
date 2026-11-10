import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { getOrder } from './api.js';
import { queryKeys } from '../../lib/api/query-keys.js';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../components/ui/sheet.js';
import { LoadingState, ErrorState } from '../../components/common/async-state.js';
import { StatusBadge } from '../../components/common/status-badge.js';
import { formatDate } from '../../lib/dates.js';
import { WriteFlow } from './write-flow.js';
import { RefundDialog } from './refund-dialog.js';
import { paymentLabel } from './payment-label.js';
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import type { OrderStatus } from '@foodops/shared';

export function OrderDrawer({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: queryKeys.order(orderId),
    queryFn: ({ signal }) => getOrder(orderId, signal),
  });
  const [refundOpen, setRefundOpen] = useState(false);
  const refundable = detail.data?.payment?.amount_paise ?? 0;
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="order-drawer">
        <SheetTitle>Order {orderId}</SheetTitle>
        <SheetDescription>Operational details and approved actions.</SheetDescription>
        {detail.isPending ? (
          <LoadingState label="Loading order" />
        ) : detail.isError ? (
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        ) : (
          <div className="drawer-stack">
            <div className="flex items-center justify-between">
              <StatusBadge status={detail.data.order.status} />
              <span className="muted">{formatDate(detail.data.order.placed_at)}</span>
            </div>
            <p className="customer-note">
              <strong>Customer note</strong>
              <br />
              {detail.data.order.notes ?? '—'}
            </p>
            <h3>Items</h3>
            {detail.data.items.map((item) => (
              <div className="detail-row" key={item.id}>
                <span>
                  {item.name_snapshot} × {item.qty}
                </span>
                <span>{item.unit_price_display}</span>
              </div>
            ))}
            <h3>Timeline</h3>
            {detail.data.timeline.map((event) => (
              <div className="timeline-row" key={event.id}>
                <span className="badge">{event.actor}</span>
                <span>{event.reason}</span>
                <time>{formatDate(event.at)}</time>
              </div>
            ))}
            <h3>Payment & delivery</h3>
            <p>
              {paymentLabel(detail.data.payment, detail.data.order.status)} ·{' '}
              {detail.data.delivery?.status ?? 'No delivery'}
            </p>
            <p>Partner ID: {detail.data.delivery?.partner_id ?? '—'}</p>
            <h3>Invoice</h3>
            {detail.data.order.status === 'delivered' ? (
              <Link
                className="button button-outline"
                to={`/orders/${encodeURIComponent(orderId)}/invoice`}
                onClick={onClose}
              >
                View invoice
              </Link>
            ) : (
              <p className="muted">Invoice is issued when the order is delivered.</p>
            )}
            <div className="drawer-actions">
              <WriteFlow
                orderId={orderId}
                input={{ operation: 'cancel', reason: '' }}
                onSuccess={() => {
                  void queryClient.invalidateQueries({ queryKey: queryKeys.order(orderId) });
                }}
              />
              <WriteFlow
                orderId={orderId}
                input={{
                  operation: 'advance',
                  to_status: nextStatus(detail.data.order.status),
                  reason: '',
                }}
                onSuccess={() => {
                  void queryClient.invalidateQueries({ queryKey: queryKeys.order(orderId) });
                }}
              />
              <Button variant="outline" onClick={() => setRefundOpen(true)}>
                Refund
              </Button>
            </div>
            <Link className="button button-outline" to="/orders" onClick={onClose}>
              Back to orders
            </Link>
            <RefundDialog
              orderId={orderId}
              maxPaise={refundable}
              open={refundOpen}
              onOpenChange={setRefundOpen}
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
function nextStatus(status: OrderStatus): OrderStatus {
  const next: Partial<Record<OrderStatus, OrderStatus>> = {
    placed: 'accepted',
    accepted: 'preparing',
    preparing: 'ready',
    ready: 'picked_up',
    picked_up: 'out_for_delivery',
    out_for_delivery: 'delivered',
  };
  return next[status] ?? status;
}
