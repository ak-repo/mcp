import { Tooltip as Primitive } from 'radix-ui';
export const TooltipProvider = Primitive.Provider;
export const Tooltip = Primitive.Root;
export const TooltipTrigger = Primitive.Trigger;
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn.js';
export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentPropsWithoutRef<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        sideOffset={sideOffset}
        className={cn('popover tooltip', className)}
        {...props}
      />
    </Primitive.Portal>
  );
}
