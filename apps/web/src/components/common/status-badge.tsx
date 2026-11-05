import type { OrderStatus } from '@foodops/shared';
import { statusConfig } from '../../lib/status-config.js';
import { Badge } from '../ui/badge.js';
export function StatusBadge({ status }: { status: OrderStatus }) {
  const config = statusConfig[status];
  const Icon = config.icon;
  return (
    <Badge data-status={config.token}>
      <Icon size={14} aria-hidden="true" />
      {config.label}
    </Badge>
  );
}
