import { DropdownMenu as Primitive } from 'radix-ui';
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn.js';
export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuLabel = Primitive.Label;
export const DropdownMenuSeparator = Primitive.Separator;
export function DropdownMenuContent({
  className,
  sideOffset = 8,
  ...props
}: ComponentPropsWithoutRef<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        sideOffset={sideOffset}
        className={cn('popover min-w-48 p-1', className)}
        {...props}
      />
    </Primitive.Portal>
  );
}
export function DropdownMenuItem({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Primitive.Item>) {
  return <Primitive.Item className={cn('menu-item', className)} {...props} />;
}
