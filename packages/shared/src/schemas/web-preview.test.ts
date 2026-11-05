import { describe, expect, it } from 'vitest';
import {
  AdvancePreviewResponseSchema,
  CancelPreviewResponseSchema,
  RefundPreviewResponseSchema,
} from './web-preview.js';

const confirmation = {
  confirmation_token: 'signed-preview-token',
  expires_at: '2026-11-05T12:05:00.000Z',
};

describe('REST preview wire schemas', () => {
  it('parses the signed advance preview returned by the API', () => {
    const value = {
      order_id: 'O-1',
      from_status: 'accepted',
      to_status: 'preparing',
      reason: 'Kitchen accepted the order',
      delivery_status_after: null,
      partner_id: null,
      partner_status_after: null,
      invoice_will_be_issued: false,
      payment_status_after: 'paid',
      refund_amount_paise: 0,
      refund_amount_display: '₹0.00',
      requiresConfirmation: true,
      requiresPaymentConfirmation: false,
      ...confirmation,
    };
    expect(AdvancePreviewResponseSchema.parse(value)).toEqual(value);
  });

  it('parses the signed cancel preview returned by the API', () => {
    const value = {
      delivery_status_after: 'cancelled',
      partner_id: 'P-1',
      partner_status_after: 'available',
      order_id: 'O-1',
      from_status: 'accepted',
      to_status: 'cancelled',
      cancel_reason: 'Customer requested cancellation',
      payment_id: 'PAY-1',
      payment_status_after: 'refunded',
      refund_amount_paise: 1000,
      refund_amount_display: '₹10.00',
      requiresConfirmation: true,
      requiresPaymentConfirmation: false,
      ...confirmation,
    };
    expect(CancelPreviewResponseSchema.parse(value)).toEqual(value);
  });

  it('parses the signed refund preview returned by the API', () => {
    const value = {
      order_id: 'O-1',
      payment_id: 'PAY-1',
      refund_amount_paise: 1000,
      refund_amount_display: '₹10.00',
      remaining_before_paise: 5000,
      remaining_before_display: '₹50.00',
      remaining_after_paise: 4000,
      remaining_after_display: '₹40.00',
      payment_status_after: 'partially_refunded',
      requiresConfirmation: true,
      ...confirmation,
    };
    expect(RefundPreviewResponseSchema.parse(value)).toEqual(value);
  });

  it.each([
    ['advance', AdvancePreviewResponseSchema, confirmation],
    ['cancel', CancelPreviewResponseSchema, confirmation],
    ['refund', RefundPreviewResponseSchema, confirmation],
  ])('rejects unknown fields and wrong confirmation types for %s', (_name, schema, extra) => {
    expect(schema.safeParse({ ...extra, unexpected: true }).success).toBe(false);
    expect(schema.safeParse({ ...extra, confirmation_token: 123 }).success).toBe(false);
    expect(schema.safeParse({ ...extra, expires_at: 'not-a-date' }).success).toBe(false);
  });
});
