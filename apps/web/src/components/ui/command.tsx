import { Command as Primitive } from 'cmdk';
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn.js';
export function Command({ className, ...props }: ComponentPropsWithoutRef<typeof Primitive>) {
  return <Primitive className={cn('command', className)} {...props} />;
}
export function CommandInput({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Primitive.Input>) {
  return <Primitive.Input className={cn('input', className)} {...props} />;
}
export const CommandList = Primitive.List;
export const CommandEmpty = Primitive.Empty;
export const CommandGroup = Primitive.Group;
export function CommandItem({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Primitive.Item>) {
  return <Primitive.Item className={cn('menu-item', className)} {...props} />;
}
