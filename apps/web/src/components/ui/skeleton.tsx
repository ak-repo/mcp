import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.js';
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('skeleton', className)} {...props} />;
}
