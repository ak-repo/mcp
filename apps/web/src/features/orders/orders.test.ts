import { describe, expect, it } from 'vitest';
import { query } from './api.js';
import { parseRefundAmount } from './refund-utils.js';
import { paymentLabel } from './payment-label.js';

describe('orders URL and refund utilities', () => {
  it('round-trips filters into stable query parameters', () => {
    expect(query({ to: '2026-11-05', from: '2026-11-01', q: 'O-1', cursor: undefined })).toBe(
      '?to=2026-11-05&from=2026-11-01&q=O-1',
    );
  });
  it.each([
    ['0', 0, false],
    ['1.5', 150, true],
    ['1.50', 150, true],
    ['1,000', 100000, true],
    ['', 0, false],
    ['999999999999999999', 0, false],
  ])('parses refund input %s', (value, expected, valid) => {
    const result = parseRefundAmount(value, 200000);
    expect(result.paise).toBe(expected);
    expect(Boolean(result.error)).toBe(!valid);
  });
  it('rejects amounts above the remaining balance', () => {
    expect(parseRefundAmount('20.01', 2000).error).toContain('exceeds');
  });
});

describe('payment label', () => {
  it('does not present a never-collected cancelled COD payment as outstanding', () => {
    expect(paymentLabel({ status: 'pending' }, 'cancelled')).toBe('Not collected: order cancelled');
    expect(paymentLabel({ status: 'pending' }, 'placed')).toBe('pending');
    expect(paymentLabel({ status: 'refunded' }, 'cancelled')).toBe('refunded');
    expect(paymentLabel(null, 'placed')).toBe('No payment');
  });
});
