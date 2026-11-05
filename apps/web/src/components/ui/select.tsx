import { Select as Primitive } from 'radix-ui';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '../../lib/cn.js';
export const Select = Primitive.Root;
export const SelectValue = Primitive.Value;
export const SelectGroup = Primitive.Group;
export const SelectLabel = Primitive.Label;
export const SelectTrigger = forwardRef<
  ElementRef<typeof Primitive.Trigger>,
  ComponentPropsWithoutRef<typeof Primitive.Trigger>
>(({ children, className, ...props }, ref) => (
  <Primitive.Trigger ref={ref} className={cn('input select-trigger', className)} {...props}>
    {children}
    <Primitive.Icon>
      <ChevronDown size={16} />
    </Primitive.Icon>
  </Primitive.Trigger>
));
SelectTrigger.displayName = 'SelectTrigger';
export function SelectContent({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        position="popper"
        className={cn('popover select-content', className)}
        {...props}
      >
        <Primitive.ScrollUpButton className="flex justify-center">
          <ChevronUp size={16} />
        </Primitive.ScrollUpButton>
        <Primitive.Viewport>{children}</Primitive.Viewport>
        <Primitive.ScrollDownButton className="flex justify-center">
          <ChevronDown size={16} />
        </Primitive.ScrollDownButton>
      </Primitive.Content>
    </Primitive.Portal>
  );
}
export function SelectItem({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Primitive.Item>) {
  return (
    <Primitive.Item className={cn('menu-item', className)} {...props}>
      <Primitive.ItemText>{children}</Primitive.ItemText>
      <Primitive.ItemIndicator>
        <Check size={16} />
      </Primitive.ItemIndicator>
    </Primitive.Item>
  );
}
