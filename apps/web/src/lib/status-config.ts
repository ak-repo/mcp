import type { OrderStatus } from '@foodops/shared';
import {
  Circle,
  Check,
  CookingPot,
  BellRing,
  PackageCheck,
  Bike,
  CircleCheck,
  CircleX,
  type LucideIcon,
} from 'lucide-react';

export const statusConfig = {
  placed: { label: 'Placed', token: 'placed', icon: Circle },
  accepted: { label: 'Accepted', token: 'accepted', icon: Check },
  preparing: { label: 'Preparing', token: 'preparing', icon: CookingPot },
  ready: { label: 'Ready', token: 'ready', icon: BellRing },
  picked_up: { label: 'Picked up', token: 'picked-up', icon: PackageCheck },
  out_for_delivery: { label: 'Out for delivery', token: 'out-for-delivery', icon: Bike },
  delivered: { label: 'Delivered', token: 'delivered', icon: CircleCheck },
  cancelled: { label: 'Cancelled', token: 'cancelled', icon: CircleX },
} satisfies Record<OrderStatus, { label: string; token: string; icon: LucideIcon }>;
