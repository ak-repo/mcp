import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Input } from '../../components/ui/input.js';
import { listPartners } from '../orders/api.js';
import { WriteFlow } from '../orders/write-flow.js';
import { useState } from 'react';

export function ReassignDialog({
  orderId,
  open,
  onOpenChange,
  onSuccess,
}: {
  orderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const partners = useQuery({
    queryKey: ['server', 'partners', 'available'],
    queryFn: ({ signal }) => listPartners({ status: 'available' }, signal),
    enabled: open,
  });
  const [partner, setPartner] = useState('');
  const [search, setSearch] = useState('');
  const available = partners.data?.data.filter(
    (p) => !search || p.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Reassign delivery</DialogTitle>
        <DialogDescription>
          Choose an available partner, review the signed preview, then confirm.
        </DialogDescription>
        {partners.isPending ? (
          <p role="status">Loading partners…</p>
        ) : (
          <>
            <Input
              aria-label="Search available partners"
              placeholder="Search partners"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select value={partner} onValueChange={setPartner}>
              <SelectTrigger aria-label="Available partner">
                <SelectValue placeholder="Select partner" />
              </SelectTrigger>
              <SelectContent>
                {available?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} · {p.vehicle}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {partner && (
              <WriteFlow
                orderId={orderId}
                input={{ operation: 'reassign', partner_id: partner, reason: '' }}
                onSuccess={() => {
                  onSuccess();
                  onOpenChange(false);
                }}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
