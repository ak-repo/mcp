import {
  addPaise,
  AppError,
  ErrorCode,
  InvoiceSchema,
  type Invoice,
  type Order,
} from '@foodops/shared';
import { id, newId, required, type Repositories, type ServiceContext } from './context.js';

export function planInvoice(repos: Repositories, order: Order, at: string) {
  const existing = repos.invoice.forOrder(order.id);
  if (existing) return { existing, invoiceNo: existing.invoice_no, feesPaise: existing.fees_paise };
  const feesPaise = addPaise(order.delivery_fee_paise, order.platform_fee_paise);
  const date = at.slice(0, 10).replace(/-/g, '');
  const sequence = repos.invoice.maxSequence(date) + 1n;
  if (sequence > BigInt(Number.MAX_SAFE_INTEGER))
    throw new AppError(
      ErrorCode.LIMIT_EXCEEDED,
      'Invoice sequence is exhausted',
      'Start a new issue date or reconcile invoice numbering',
    );
  return {
    existing: null,
    invoiceNo: `INV-${date}-${sequence.toString().padStart(4, '0')}`,
    feesPaise,
  };
}
export function issueInvoice(repos: Repositories, order: Order, at: string): Invoice {
  const plan = planInvoice(repos, order, at);
  if (plan.existing) return plan.existing;
  const invoice = InvoiceSchema.parse({
    id: newId(),
    order_id: order.id,
    invoice_no: plan.invoiceNo,
    subtotal_paise: order.subtotal_paise,
    tax_paise: order.tax_paise,
    fees_paise: plan.feesPaise,
    discount_paise: order.discount_paise,
    total_paise: order.total_paise,
    issued_at: at,
  });
  repos.invoice.insert(invoice);
  return invoice;
}
export function createInvoiceService(context: ServiceContext) {
  return {
    getInvoice(orderId: string) {
      id(orderId);
      return context.read((repos) => {
        required(repos.order.get(orderId), 'Order');
        return {
          invoice: required(repos.invoice.forOrder(orderId), 'Invoice'),
          items: repos.order.items(orderId),
        };
      });
    },
  };
}
