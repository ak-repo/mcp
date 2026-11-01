import { createContext, type ServiceHandles } from './context.js';
import { createCatalogService } from './catalog.service.js';
import { createOrderService } from './order.service.js';
import { createDeliveryService } from './delivery.service.js';
import { createRefundService } from './refund.service.js';
import { createInvoiceService } from './invoice.service.js';
import { createMetricsService } from './metrics.service.js';
import { createAuditService } from './audit.service.js';

/**
 * Read APIs use a read-only snapshot. Writes re-read state under an immediate transaction.
 * Calling an execute method represents caller approval; previews never persist changes.
 * Keep these handles open for the service lifetime; the caller owns closing them.
 */
export function createServices(handles: ServiceHandles) {
  const context = createContext(handles);
  return {
    catalog: createCatalogService(context),
    order: createOrderService(context),
    delivery: createDeliveryService(context),
    refund: createRefundService(context),
    invoice: createInvoiceService(context),
    metrics: createMetricsService(context),
    audit: createAuditService(context),
  };
}
export type Services = ReturnType<typeof createServices>;
export type { ServiceHandles, Presented, WriteMeta } from './context.js';
export type * from './types.js';
