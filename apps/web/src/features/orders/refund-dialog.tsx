import { useState } from 'react';
import { formatINR } from '@foodops/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { WriteFlow } from './write-flow.js';
import { parseRefundAmount } from './refund-utils.js';

export function RefundDialog({
  orderId,
  maxPaise,
  open,
  onOpenChange,
}: {
  orderId: string;
  maxPaise: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  let parsed = 0;
  let error = '';
  if (amount.trim()) {
    const result = parseRefundAmount(amount, maxPaise);
    parsed = result.paise;
    error = result.error;
  }
  const large = parsed >= 100000;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Refund order</DialogTitle>
        <DialogDescription>
          Refund up to {formatINR(maxPaise)} remaining. All amounts are INR.
        </DialogDescription>
        <div className="drawer-stack">
          <Label htmlFor="refund-amount">Amount (₹)</Label>
          <Input
            id="refund-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1,000.00"
            aria-describedby="refund-help"
          />
          <p id="refund-help" className="muted text-xs">
            {error || `Remaining balance: ${formatINR(maxPaise)}`}
          </p>
          {large && !error && (
            <p className="warning-text" role="alert">
              Large refund: review the amount carefully before confirming.
            </p>
          )}
          <Label htmlFor="refund-reason">Reason</Label>
          <Input
            id="refund-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
          />
          {parsed > 0 && !error && (
            <WriteFlow
              orderId={orderId}
              input={{ operation: 'refund', amount_paise: parsed, reason }}
              onSuccess={() => onOpenChange(false)}
            />
          )}
        </div>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </DialogContent>
    </Dialog>
  );
}
