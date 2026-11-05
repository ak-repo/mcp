import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { getInvoice, getOrder } from '../orders/api.js';
import { queryKeys } from '../../lib/api/query-keys.js';
import { PageHeader } from '../../components/common/page-header.js';
import { ErrorState, LoadingState } from '../../components/common/async-state.js';
import { Button } from '../../components/ui/button.js';
import { formatDate } from '../../lib/dates.js';
import { ApiError } from '../../lib/api/errors.js';

export function InvoicePage() {
  const { id = '' } = useParams();
  const invoice = useQuery({
    queryKey: queryKeys.invoice(id),
    queryFn: ({ signal }) => getInvoice(id, signal),
    enabled: Boolean(id),
  });
  const order = useQuery({
    queryKey: queryKeys.order(id),
    queryFn: ({ signal }) => getOrder(id, signal),
    enabled: Boolean(id),
  });
  if (invoice.isPending || order.isPending) return <LoadingState label="Loading invoice" />;
  if (invoice.isError && invoice.error instanceof ApiError && invoice.error.status === 404)
    return (
      <div className="page-stack">
        <PageHeader title="Invoice" description={`Order ${id}`} />
        <div className="state-panel">
          <h2>Invoice not issued yet</h2>
          <p className="muted">Invoices are issued when an order is delivered.</p>
          <Link className="button button-outline" to={`/orders/${encodeURIComponent(id)}`}>
            Back to order
          </Link>
        </div>
      </div>
    );
  if (invoice.isError || order.isError || !invoice.data || !order.data)
    return (
      <ErrorState
        error={invoice.error ?? order.error}
        onRetry={() => {
          void invoice.refetch();
          void order.refetch();
        }}
      />
    );
  const { invoice: value, items } = invoice.data;
  const { order: orderValue, customer, payment } = order.data;
  return (
    <div className="page-stack invoice-page">
      <PageHeader
        title={`Invoice ${value.invoice_no}`}
        description="Immutable invoice · issued from delivered order"
        actions={
          <div className="invoice-actions">
            <Button onClick={() => window.print()}>Print</Button>
            <Link className="button button-outline" to={`/orders/${encodeURIComponent(id)}`}>
              Back to order
            </Link>
          </div>
        }
      />
      <article className="invoice-paper" aria-label="Invoice">
        <header className="invoice-heading">
          <div>
            <h2>FoodOps</h2>
            <p className="muted">Invoice {value.invoice_no}</p>
          </div>
          <dl>
            <div>
              <dt>Issue date</dt>
              <dd>{formatDate(value.issued_at)}</dd>
            </div>
            <div>
              <dt>Order</dt>
              <dd>{orderValue.id}</dd>
            </div>
          </dl>
        </header>
        <section className="invoice-parties">
          <div>
            <h3>Customer</h3>
            <p>{customer.name}</p>
            <p>{customer.email}</p>
            <p>{customer.phone}</p>
          </div>
          <div>
            <h3>Restaurant</h3>
            <p>{orderValue.restaurant_id}</p>
          </div>
        </section>
        <table className="invoice-table">
          <caption className="sr-only">Invoice line items</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Quantity</th>
              <th scope="col">Unit price</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.name_snapshot}</td>
                <td>{item.qty}</td>
                <td>{item.unit_price_display}</td>
                <td>{item.unit_price_display}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="invoice-totals">
          <div>
            <dt>Subtotal</dt>
            <dd>{value.subtotal_display}</dd>
          </div>
          <div>
            <dt>Tax</dt>
            <dd>{value.tax_display}</dd>
          </div>
          <div>
            <dt>Fees</dt>
            <dd>{value.fees_display}</dd>
          </div>
          <div>
            <dt>Discount</dt>
            <dd>{value.discount_display}</dd>
          </div>
          <div className="invoice-total">
            <dt>Total</dt>
            <dd>{value.total_display}</dd>
          </div>
        </dl>
        <section className="invoice-payment">
          <h3>Payment</h3>
          <p>
            {payment?.method ?? '—'} · {payment?.status ?? '—'}
          </p>
          <p className="muted">
            Invoices are immutable. Refunds, if any, are recorded separately in the order payment
            history.
          </p>
        </section>
      </article>
    </div>
  );
}
