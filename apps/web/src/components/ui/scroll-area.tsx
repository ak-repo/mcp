import { ScrollArea as Primitive } from 'radix-ui';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '../../lib/cn.js';
export const ScrollArea = forwardRef<
  ElementRef<typeof Primitive.Root>,
  ComponentPropsWithoutRef<typeof Primitive.Root>
>(({ children, className, ...props }, ref) => (
  <Primitive.Root ref={ref} className={cn('relative overflow-hidden', className)} {...props}>
    <Primitive.Viewport className="h-full w-full rounded-[inherit]">{children}</Primitive.Viewport>
    <Primitive.Scrollbar orientation="vertical" className="scrollbar">
      <Primitive.Thumb className="scroll-thumb" />
    </Primitive.Scrollbar>
    <Primitive.Corner />
  </Primitive.Root>
));
ScrollArea.displayName = 'ScrollArea';
