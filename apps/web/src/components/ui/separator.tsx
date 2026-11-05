import { Separator as Primitive } from 'radix-ui';
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn.js';
export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: ComponentPropsWithoutRef<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      orientation={orientation}
      decorative={decorative}
      className={cn('separator', className)}
      {...props}
    />
  );
}
