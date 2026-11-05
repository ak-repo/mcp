import { Switch as Primitive } from 'radix-ui';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '../../lib/cn.js';
export const Switch = forwardRef<
  ElementRef<typeof Primitive.Root>,
  ComponentPropsWithoutRef<typeof Primitive.Root>
>(({ className, ...props }, ref) => (
  <Primitive.Root ref={ref} className={cn('switch', className)} {...props}>
    <Primitive.Thumb className="switch-thumb" />
  </Primitive.Root>
));
Switch.displayName = 'Switch';
