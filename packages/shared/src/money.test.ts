import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from './errors.js';
import {
  addPaise,
  assertPaise,
  formatINR,
  MAX_PAISE,
  paiseToRupees,
  percentOf,
  rupeesToPaise,
  subtractPaise,
} from './money.js';

describe('integer paise', () => {
  it('formats zero, fractional rupees, Indian grouping, and the safe integer boundary exactly', () => {
    expect(formatINR(0)).toBe('₹0.00');
    expect(formatINR(1)).toBe('₹0.01');
    expect(formatINR(123456789)).toBe('₹12,34,567.89');
    expect(formatINR(MAX_PAISE)).toBe('₹9,00,71,99,25,47,409.91');
  });

  it('converts decimal rupees with half-up rounding rather than binary floating-point rounding', () => {
    expect(rupeesToPaise(1.005)).toBe(101);
    expect(rupeesToPaise(0.004)).toBe(0);
    expect(rupeesToPaise(0.005)).toBe(1);
    expect(rupeesToPaise(1e-7)).toBe(0);
    expect(rupeesToPaise(1e3)).toBe(100000);
    expect(paiseToRupees(12345)).toBe(123.45);
  });

  it('rounds tax half-up, including fractional percentages and large amounts', () => {
    expect(percentOf(10, 5)).toBe(1);
    expect(percentOf(9, 5)).toBe(0);
    expect(percentOf(200, 5)).toBe(10);
    expect(percentOf(100, 1.005)).toBe(1);
    expect(percentOf(10000, 2.675)).toBe(268);
    expect(percentOf(MAX_PAISE, 100)).toBe(MAX_PAISE);
    expect(percentOf(MAX_PAISE, 50)).toBe(4503599627370496);
    expect(percentOf(0, 200)).toBe(0);
    expect(percentOf(100, 1e-7)).toBe(0);
  });

  it('adds and subtracts safely without allowing negative money', () => {
    expect(addPaise()).toBe(0);
    expect(addPaise(100, 5, 10)).toBe(115);
    expect(addPaise(MAX_PAISE, 0)).toBe(MAX_PAISE);
    expect(subtractPaise(100, 20, 30)).toBe(50);
    expect(subtractPaise(MAX_PAISE, MAX_PAISE)).toBe(0);
    expect(subtractPaise(100)).toBe(100);
    expect(() => addPaise(MAX_PAISE, 1)).toThrow(AppError);
    expect(() => subtractPaise(0, 1)).toThrow(AppError);
    expect(() => percentOf(MAX_PAISE, 200)).toThrow(AppError);
    expect(() => rupeesToPaise(MAX_PAISE)).toThrow(AppError);
  });

  it.each([-1, 0.1, NaN, Infinity, -Infinity, MAX_PAISE + 1])(
    'rejects invalid paise %s',
    (value) => {
      for (const operation of [assertPaise, formatINR, paiseToRupees, addPaise]) {
        expect(() => operation(value)).toThrow(AppError);
      }
      expect(() => subtractPaise(100, value)).toThrow(AppError);
      expect(() => percentOf(value, 5)).toThrow(AppError);
    },
  );

  it.each([-1, NaN, Infinity, -Infinity])('rejects invalid percentage or rupees %s', (value) => {
    expect(() => percentOf(100, value)).toThrow(AppError);
    expect(() => rupeesToPaise(value)).toThrow(AppError);
  });

  it('normalizes negative zero', () => {
    expect(Object.is(assertPaise(-0), 0)).toBe(true);
    expect(formatINR(-0)).toBe('₹0.00');
  });
});

describe('AppError', () => {
  it('preserves its typed code, details and hint while producing tool text', () => {
    const error = new AppError(ErrorCode.NOT_FOUND, 'Order not found.', 'Check order_id', {
      order_id: 'O-404',
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AppError');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.details).toEqual({ order_id: 'O-404' });
    expect(error.toToolText()).toBe('NOT_FOUND: Order not found. Hint: Check order_id');
    expect(new AppError(ErrorCode.CONFLICT, 'Already exists').toToolText()).toBe(
      'CONFLICT: Already exists.',
    );
  });
});
