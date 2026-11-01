import { AppError, ErrorCode } from './errors.js';

export const PAISE_PER_RUPEE = 100;
export const MAX_PAISE = Number.MAX_SAFE_INTEGER;

/** Money is a non-negative safe integer number of paise. */
export function assertPaise(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError(ErrorCode.VALIDATION, 'Money must be non-negative safe integer paise');
  }
  return value === 0 ? 0 : value;
}

function safeResult(value: bigint): number {
  if (value < 0n || value > BigInt(MAX_PAISE)) {
    throw new AppError(ErrorCode.VALIDATION, 'Money calculation is outside the safe paise range');
  }
  return Number(value);
}

/** Interpret a finite non-negative decimal number exactly as its decimal string. */
function decimalRatio(value: number): readonly [bigint, bigint] {
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Amount or percentage must be finite and non-negative',
    );
  }
  const [coefficient = '0', exponent = '0'] = value.toString().split('e');
  const [whole = '0', fraction = ''] = coefficient.split('.');
  const scale = fraction.length - Number(exponent);
  const numerator = BigInt(whole + fraction);
  return scale >= 0 ? [numerator, 10n ** BigInt(scale)] : [numerator * 10n ** BigInt(-scale), 1n];
}

function roundHalfUp(numerator: bigint, denominator: bigint): number {
  return safeResult((2n * numerator + denominator) / (2n * denominator));
}

export function rupeesToPaise(rupees: number): number {
  const [numerator, denominator] = decimalRatio(rupees);
  return roundHalfUp(numerator * 100n, denominator);
}

export function paiseToRupees(paise: number): number {
  return assertPaise(paise) / PAISE_PER_RUPEE;
}

export function addPaise(...amounts: number[]): number {
  return safeResult(amounts.reduce((sum, value) => sum + BigInt(assertPaise(value)), 0n));
}

export function subtractPaise(amount: number, ...deductions: number[]): number {
  return safeResult(
    deductions.reduce(
      (remaining, value) => remaining - BigInt(assertPaise(value)),
      BigInt(assertPaise(amount)),
    ),
  );
}

export function percentOf(paise: number, pct: number): number {
  const amount = BigInt(assertPaise(paise));
  const [numerator, denominator] = decimalRatio(pct);
  return roundHalfUp(amount * numerator, denominator * 100n);
}

const inrWholeFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Format without floating-point division, including at MAX_SAFE_INTEGER paise. */
export function formatINR(paise: number): string {
  const amount = BigInt(assertPaise(paise));
  return `${inrWholeFormatter.format(amount / 100n)}.${(amount % 100n).toString().padStart(2, '0')}`;
}
