import { describe, expect, it } from 'vitest';
import { AppError, encodeCursor, OrderSchema } from '@foodops/shared';
import { parsePagination, pageResponse } from '../lib/pagination.js';
import { validate } from '../lib/validate.js';
describe('shared HTTP validation', () => {
  it('parses HTTP pagination through the shared schemas', () => {
    const cursor = encodeCursor({ placed_at: '2026-11-01T00:00:00.000Z', id: 'O-1' });
    expect(parsePagination({})).toEqual({ limit: 20 });
    expect(parsePagination({ limit: '50', cursor })).toEqual({ limit: 50, cursor });
    expect(pageResponse({ items: [{ id: 1 }], next_cursor: cursor })).toEqual({
      data: [{ id: 1 }],
      next_cursor: cursor,
    });
  });
  it.each([
    { limit: '0' },
    { limit: '51' },
    { limit: '1.5' },
    { limit: '' },
    { limit: ['1', '2'] },
    { cursor: 'invalid' },
    { cursor: ['a', 'b'] },
    { extra: 'x' },
    null,
  ])('rejects invalid pagination %j', (query) => {
    expect(() => parsePagination(query)).toThrow(AppError);
  });
  it('does not leak rejected entity data', () => {
    expect(() => validate(OrderSchema, { notes: 'private-value' })).toThrow('Invalid request data');
    try {
      validate(OrderSchema, { notes: 'private-value' });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('private-value');
    }
  });
});
