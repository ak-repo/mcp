import { describe, expect, it } from 'vitest';
import {
  ActorSchema,
  AddressSchema,
  AppError,
  createPageSchema,
  CursorSchema,
  CustomerSchema,
  decodeCursor,
  DeliverySchema,
  DeliveryStatusSchema,
  encodeCursor,
  ErrorCodeSchema,
  IdempotencyKeySchema,
  InvoiceSchema,
  MenuItemSchema,
  OrderEventSchema,
  OrderItemSchema,
  OrderListFiltersSchema,
  OrderSchema,
  OrderStatusSchema,
  PaginationSchema,
  PartnerStatusSchema,
  PaymentMethodSchema,
  PaymentSchema,
  PaymentStatusSchema,
  RefundSchema,
  RestaurantListFiltersSchema,
  RestaurantSchema,
  SalesSummaryFiltersSchema,
  SummaryMetricsSchema,
  ToolCallLogSchema,
} from '../index.js';

const at = '2026-11-01T12:00:00.000Z';
const order = {
  id: 'O-1',
  customer_id: 'C-1',
  restaurant_id: 'R-1',
  address_id: 'A-1',
  status: 'placed',
  subtotal_paise: 100,
  tax_paise: 5,
  delivery_fee_paise: 0,
  platform_fee_paise: 0,
  discount_paise: 0,
  total_paise: 105,
  notes: null,
  cancel_reason: null,
  placed_at: at,
  updated_at: at,
};

describe('entity contracts', () => {
  it('validates the documented entities and nullable lifecycle fields', () => {
    expect(
      CustomerSchema.parse({
        id: 'C-1',
        name: 'Customer',
        phone: '+919876543210',
        email: 'ops@example.com',
        created_at: at,
      }).id,
    ).toBe('C-1');
    expect(
      AddressSchema.safeParse({
        id: 'A-1',
        customer_id: 'C-1',
        label: 'Home',
        line1: '1 Street',
        area: 'Central',
        city: 'Pune',
        pincode: '411001',
      }).success,
    ).toBe(true);
    expect(
      RestaurantSchema.safeParse({
        id: 'R-1',
        name: 'Cafe',
        cuisine: 'Indian',
        city: 'Pune',
        area: 'Central',
        rating: 4.2,
        prep_time_min: 20,
        is_open: true,
      }).success,
    ).toBe(true);
    expect(
      MenuItemSchema.safeParse({
        id: 'M-1',
        restaurant_id: 'R-1',
        name: 'Meal',
        price_paise: 100,
        is_veg: true,
        is_available: false,
      }).success,
    ).toBe(true);
    expect(OrderSchema.parse(order).status).toBe('placed');
    expect(
      OrderItemSchema.safeParse({
        id: 'OI-1',
        order_id: 'O-1',
        menu_item_id: 'M-1',
        name_snapshot: 'Meal',
        unit_price_paise: 100,
        qty: 2,
      }).success,
    ).toBe(true);
    expect(
      OrderEventSchema.safeParse({
        id: 'E-1',
        order_id: 'O-1',
        from_status: null,
        to_status: 'placed',
        actor: 'system',
        reason: 'Placed',
        at,
      }).success,
    ).toBe(true);
    expect(
      DeliverySchema.safeParse({
        id: 'D-1',
        order_id: 'O-1',
        partner_id: null,
        status: 'pending',
        eta_min: null,
        assigned_at: null,
        picked_up_at: null,
        delivered_at: null,
      }).success,
    ).toBe(true);
    expect(
      PaymentSchema.safeParse({
        id: 'P-1',
        order_id: 'O-1',
        method: 'upi',
        status: 'pending',
        amount_paise: 105,
        txn_ref: null,
      }).success,
    ).toBe(true);
    expect(
      RefundSchema.safeParse({
        id: 'RF-1',
        order_id: 'O-1',
        payment_id: 'P-1',
        amount_paise: 1,
        reason: 'Refund',
        actor: 'ops',
        idempotency_key: null,
        created_at: at,
      }).success,
    ).toBe(true);
    expect(
      InvoiceSchema.safeParse({
        id: 'I-1',
        order_id: 'O-1',
        invoice_no: 'INV-20261101-0001',
        subtotal_paise: 100,
        tax_paise: 5,
        fees_paise: 0,
        discount_paise: 0,
        total_paise: 105,
        issued_at: at,
      }).success,
    ).toBe(true);
    expect(
      ToolCallLogSchema.safeParse({
        id: 'T-1',
        session_id: null,
        tool: 'get_order',
        args_json: '{"order_id":"O-1"}',
        status: 'success',
        error_code: null,
        latency_ms: 0,
        actor: 'ai',
        at,
      }).success,
    ).toBe(true);
    expect(
      IdempotencyKeySchema.safeParse({
        key: 'K-1',
        operation: 'cancel_order',
        request_hash: 'a'.repeat(64),
        response_json: '{"ok":true}',
        created_at: at,
      }).success,
    ).toBe(true);
  });

  it('rejects unknown properties, invalid money, invalid booleans, timestamps and enums', () => {
    expect(OrderSchema.safeParse({ ...order, internal_secret: 'hidden' }).success).toBe(false);
    expect(OrderSchema.safeParse({ ...order, total_paise: -1 }).success).toBe(false);
    expect(OrderSchema.safeParse({ ...order, total_paise: 0.5 }).success).toBe(false);
    expect(
      OrderSchema.safeParse({ ...order, total_paise: Number.MAX_SAFE_INTEGER + 1 }).success,
    ).toBe(false);
    expect(OrderSchema.safeParse({ ...order, placed_at: 'yesterday' }).success).toBe(false);
    expect(
      OrderSchema.safeParse({ ...order, placed_at: '2026-11-01T12:00:00+05:30' }).success,
    ).toBe(false);
    for (const schema of [
      OrderStatusSchema,
      PaymentStatusSchema,
      PaymentMethodSchema,
      DeliveryStatusSchema,
      PartnerStatusSchema,
      ActorSchema,
      ErrorCodeSchema,
    ]) {
      expect(schema.safeParse('invalid').success).toBe(false);
    }
    expect(
      CustomerSchema.safeParse({ id: ' ', name: 'Test', phone: '1', email: 'bad', created_at: at })
        .success,
    ).toBe(false);
  });

  it('requires positive refund amounts, proper invoice numbers and valid serialized JSON', () => {
    expect(RefundSchema.shape.amount_paise.safeParse(0).success).toBe(false);
    expect(InvoiceSchema.shape.invoice_no.safeParse('INV-20261101-0001x').success).toBe(false);
    expect(ToolCallLogSchema.shape.args_json.safeParse('{broken').success).toBe(false);
    expect(IdempotencyKeySchema.shape.response_json.safeParse('{}').success).toBe(true);
  });
});

describe('pagination and filters', () => {
  const position = { placed_at: at, id: 'O-हिंदी' };

  it('round-trips Unicode cursors using canonical base64url', () => {
    const cursor = encodeCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual(position);
    expect(OrderListFiltersSchema.parse({ cursor }).limit).toBe(20);
    expect(
      createPageSchema(OrderSchema).parse({ items: [order], next_cursor: cursor }).items,
    ).toHaveLength(1);
  });

  it.each(['', '!!!!', 'e30', 'bnVsbA', 'a'.repeat(4097)])(
    'rejects malformed cursor %s',
    (cursor) => {
      expect(() => decodeCursor(cursor)).toThrow(AppError);
      expect(CursorSchema.safeParse(cursor).success).toBe(false);
    },
  );

  it('rejects unknown cursor keys and oversized positions without leaking parser exceptions', () => {
    const cursor = btoa(JSON.stringify({ placed_at: at, id: 'O-1', extra: 1 }));
    expect(() => decodeCursor(cursor)).toThrow(AppError);
    expect(() => encodeCursor({ placed_at: at, id: 'x'.repeat(100000) })).toThrow(AppError);
    expect(() => encodeCursor({ placed_at: 'bad', id: 'O-1' })).toThrow(AppError);
  });

  it('defaults limit to 20, accepts 50, and rejects invalid or coerced limits', () => {
    expect(PaginationSchema.parse({}).limit).toBe(20);
    expect(PaginationSchema.parse({ limit: 50 }).limit).toBe(50);
    for (const limit of [0, 51, 1.5, '20', null]) {
      expect(PaginationSchema.safeParse({ limit }).success).toBe(false);
    }
    expect(RestaurantListFiltersSchema.safeParse({ open_now: 'true' }).success).toBe(false);
    expect(OrderListFiltersSchema.safeParse({ sql: 'DROP TABLE orders' }).success).toBe(false);
  });

  it('accepts UTC dates or timestamps and rejects reversed ranges', () => {
    expect(OrderListFiltersSchema.safeParse({ from: '2026-10-01', to: at }).success).toBe(true);
    expect(OrderListFiltersSchema.safeParse({ from: '2026-11-02', to: '2026-11-01' }).success).toBe(
      false,
    );
    expect(
      SalesSummaryFiltersSchema.safeParse({ from: '2026-11-01', to: '2026-11-01', group_by: 'day' })
        .success,
    ).toBe(true);
    expect(
      SalesSummaryFiltersSchema.safeParse({ from: '2026-11-02', to: '2026-11-01', group_by: 'day' })
        .success,
    ).toBe(false);
  });

  it('represents empty metrics without invented delivery times', () => {
    const metrics = {
      orders: 0,
      gmv_paise: 0,
      gmv_display: '₹0.00',
      avg_order_value_paise: 0,
      avg_order_value_display: '₹0.00',
      cancel_rate: 0,
      avg_delivery_time_min: null,
    };
    expect(SummaryMetricsSchema.safeParse(metrics).success).toBe(true);
    expect(SummaryMetricsSchema.safeParse({ ...metrics, cancel_rate: 1.01 }).success).toBe(false);
  });
});
