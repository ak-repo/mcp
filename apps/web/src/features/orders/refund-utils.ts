import { rupeesToPaise } from '@foodops/shared';

export function parseRefundAmount(
  value: string,
  maxPaise: number,
): { paise: number; error: string } {
  if (!value.trim()) return { paise: 0, error: 'Enter a refund amount.' };
  try {
    const paise = rupeesToPaise(Number(value.replaceAll(',', '')));
    if (!Number.isSafeInteger(paise) || paise <= 0)
      return { paise: 0, error: 'Enter a positive rupee amount.' };
    if (paise > maxPaise)
      return { paise: 0, error: 'Amount exceeds the remaining refundable balance.' };
    return { paise, error: '' };
  } catch {
    return { paise: 0, error: 'Enter a valid rupee amount.' };
  }
}
