import { expect, it } from 'vitest';
import { formatDate, formatRelative } from './dates.js';
import { newIdempotencyKey } from './ids.js';
import { statusConfig } from './status-config.js';
import { OrderStatusSchema } from '@foodops/shared';
it('formats dates, relative time and generates distinct valid idempotency keys', () => {
  expect(formatDate('invalid')).toBe('Unknown time');
  expect(formatDate('2026-11-04T10:00:00Z')).not.toBe('Unknown time');
  expect(formatRelative('invalid')).toBe('Unknown time');
  expect(formatRelative('2026-11-04T10:00:00Z', Date.parse('2026-11-04T10:01:00Z'))).toMatch(
    /minute/,
  );
  const key = newIdempotencyKey();
  expect(key).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  expect(newIdempotencyKey()).not.toBe(key);
  expect(Object.keys(statusConfig).sort()).toEqual([...OrderStatusSchema.options].sort());
});
